"""A stream's saved chat replay, read for the player.

yt-dlp writes ``<stem>.live_chat.json`` as one JSON object per line, in
YouTube's own renderer structure. The page never sees that: this module boils
each line down to the few fields a chat panel draws, and hands them out by
time window, because a long stream is hundreds of thousands of messages and
only the minute being watched is wanted.

The parsed replay is the one cache this module owns. It is kept for the last
couple of streams opened and dropped when the file changes.
"""
from __future__ import annotations
import json
import threading
from bisect import bisect_left
from collections import OrderedDict
from pathlib import Path

# The kinds of chat event that carry words a person said or paid to say. The
# rest of what a replay holds (pinned banners, removed messages, engagement
# prompts) is the player's furniture rather than the conversation.
TEXT_RENDERERS = {
    "liveChatTextMessageRenderer": "text",
    "liveChatPaidMessageRenderer": "paid",
    "liveChatPaidStickerRenderer": "paid",
    "liveChatMembershipItemRenderer": "member",
}
# The badge that earns a name a mark, strongest first.
ROLES = ("owner", "moderator", "member")
BADGE_ICONS = {"OWNER": "owner", "MODERATOR": "moderator"}
KEPT_REPLAYS = 2


def _runs(node: object) -> str:
    """The words of a ``message`` or header node. A custom emoji is YouTube's
    own picture at an address on its servers, which the browser is never sent
    to fetch (as with a commenter's portrait), so it is left as its shortcut,
    ``:name:``; a standard emoji is simply the character."""
    if not isinstance(node, dict):
        return ""
    if isinstance(node.get("simpleText"), str):
        return node["simpleText"]
    words = []
    for run in node.get("runs") or []:
        if not isinstance(run, dict):
            continue
        if isinstance(run.get("text"), str):
            words.append(run["text"])
            continue
        emoji = run.get("emoji")
        if isinstance(emoji, dict):
            shortcuts = emoji.get("shortcuts")
            custom = emoji.get("isCustomEmoji") and isinstance(shortcuts, list) and shortcuts
            words.append(str(shortcuts[0]) if custom else str(emoji.get("emojiId") or ""))
    return "".join(words)


def _role(renderer: dict) -> str:
    found = set()
    for badge in renderer.get("authorBadges") or []:
        inner = badge.get("liveChatAuthorBadgeRenderer") if isinstance(badge, dict) else None
        if not isinstance(inner, dict):
            continue
        icon = (inner.get("icon") or {}).get("iconType")
        if icon in BADGE_ICONS:
            found.add(BADGE_ICONS[icon])
        elif inner.get("customThumbnail"):
            found.add("member")
    return next((role for role in ROLES if role in found), "")


def _message(offset: int, renderer_name: str, renderer: dict) -> dict | None:
    kind = TEXT_RENDERERS[renderer_name]
    text = _runs(renderer.get("message"))
    if kind == "member":
        # A new member's welcome is the header; whatever they typed follows it.
        header = _runs(renderer.get("headerSubtext")) or _runs(renderer.get("headerPrimaryText"))
        text = " · ".join(part for part in (header, text) if part)
    author = _runs(renderer.get("authorName"))
    amount = _runs(renderer.get("purchaseAmountText")) if kind == "paid" else ""
    # A sticker has no words, only an amount; anything else with neither is noise.
    if not text and not amount:
        return None
    return {"t": offset, "author": author, "role": _role(renderer),
            "kind": kind, "amount": amount, "text": text}


def parse(path: Path) -> list[dict]:
    """Every message in a replay, in the order they were said. A line that
    is not JSON, or not a chat event, is passed over: a file cut short by a
    stopped download is still worth showing as far as it goes."""
    messages: list[dict] = []
    with path.open(encoding="utf-8", errors="replace") as lines:
        for line in lines:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            action = event.get("replayChatItemAction") if isinstance(event, dict) else None
            if not isinstance(action, dict):
                continue
            try:
                # Chat from before the stream began is offset below zero.
                offset = max(0, int(action.get("videoOffsetTimeMsec")))
            except (TypeError, ValueError):
                continue
            for inner in action.get("actions") or []:
                item = ((inner.get("addChatItemAction") or {}).get("item")
                        if isinstance(inner, dict) else None)
                if not isinstance(item, dict):
                    continue
                for name in TEXT_RENDERERS:
                    renderer = item.get(name)
                    if isinstance(renderer, dict):
                        message = _message(offset, name, renderer)
                        if message:
                            messages.append(message)
                        break
    # Python's sort is stable, so messages sharing a moment keep their order.
    messages.sort(key=lambda message: message["t"])
    return messages


class ChatReplays:
    """Parsed replays by file, so each window request is a slice of memory
    rather than another read of a file of tens of megabytes."""

    def __init__(self, keep: int = KEPT_REPLAYS) -> None:
        self.keep = keep
        self._lock = threading.Lock()
        # path -> (signature, messages, offsets), least recently used first.
        self._replays: OrderedDict[Path, tuple[tuple[int, int], list[dict], list[int]]] = OrderedDict()

    def window(self, path: Path, start: int, end: int) -> list[dict]:
        """The messages at or after ``start`` and before ``end``, in
        milliseconds from the start of the video. Empty if the file has gone."""
        try:
            stat = path.stat()
        except OSError:
            return []
        signature = (stat.st_mtime_ns, stat.st_size)
        with self._lock:
            held = self._replays.get(path)
            if held and held[0] == signature:
                self._replays.move_to_end(path)
        if not held or held[0] != signature:
            # Outside the lock: a parse takes a second or more on a long
            # stream, and two requests racing to do it only waste work.
            try:
                messages = parse(path)
            except OSError:
                return []
            held = (signature, messages, [message["t"] for message in messages])
            with self._lock:
                self._replays[path] = held
                self._replays.move_to_end(path)
                while len(self._replays) > self.keep:
                    self._replays.popitem(last=False)
        _, messages, offsets = held
        return messages[bisect_left(offsets, start):bisect_left(offsets, end)]
