import json
import tempfile
import unittest
from pathlib import Path

from reruns.archive import Archive
from reruns.chat import ChatReplays, parse


def line(offset, *items):
    """One line of yt-dlp's live_chat.json, as YouTube words it."""
    return json.dumps({"replayChatItemAction": {
        "actions": [{"addChatItemAction": {"item": item}} for item in items],
        "videoOffsetTimeMsec": str(offset)}})


def text(author, *runs, badges=()):
    return {"liveChatTextMessageRenderer": {
        "authorName": {"simpleText": author},
        "message": {"runs": [run if isinstance(run, dict) else {"text": run} for run in runs]},
        "authorBadges": [{"liveChatAuthorBadgeRenderer": badge} for badge in badges]}}


REPLAY = "\n".join([
    line(5000, text("Zed", "second")),
    line(1000, text("Ann", "hello ", {"emoji": {"emojiId": "👋"}})),
    # Custom emoji are a picture on YouTube's servers, so they stay a shortcut.
    line(1000, text("Bea", {"emoji": {"emojiId": "UC/x", "shortcuts": [":wave:"],
                                       "isCustomEmoji": True}}, badges=[
        {"icon": {"iconType": "MODERATOR"}}, {"customThumbnail": {"thumbnails": [{"url": "x"}]}}])),
    line(2000, {"liveChatPaidMessageRenderer": {
        "authorName": {"simpleText": "Cat"}, "purchaseAmountText": {"simpleText": "£5.00"},
        "message": {"runs": [{"text": "thanks!"}]}}}),
    line(2500, {"liveChatPaidStickerRenderer": {
        "authorName": {"simpleText": "Dee"}, "purchaseAmountText": {"simpleText": "$2.00"}}}),
    line(3000, {"liveChatMembershipItemRenderer": {
        "authorName": {"simpleText": "Eve"}, "headerSubtext": {"runs": [{"text": "Welcome to the club!"}]},
        "authorBadges": [{"liveChatAuthorBadgeRenderer": {"customThumbnail": {"thumbnails": [{"url": "x"}]}}}]}}),
    # Furniture, an empty message, a line cut short, and chat from before the start.
    line(3500, {"liveChatViewerEngagementMessageRenderer": {"message": {"runs": [{"text": "Be kind"}]}}}),
    line(3600, text("Fay")),
    '{"replayChatItemAction": {"actions": [',
    line(-4000, text("Gus", "early")),
])


class ChatTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def replay(self, content=REPLAY):
        path = self.root / "stream.live_chat.json"
        path.write_text(content + "\n", encoding="utf-8")
        return path

    def test_a_replay_is_boiled_down_and_put_in_order(self):
        messages = parse(self.replay())
        self.assertEqual([(m["t"], m["author"]) for m in messages], [
            (0, "Gus"), (1000, "Ann"), (1000, "Bea"), (2000, "Cat"),
            (2500, "Dee"), (3000, "Eve"), (5000, "Zed")])
        by_author = {m["author"]: m for m in messages}
        self.assertEqual(by_author["Ann"]["text"], "hello 👋")
        self.assertEqual(by_author["Bea"]["text"], ":wave:")
        self.assertEqual(by_author["Bea"]["role"], "moderator")
        self.assertEqual((by_author["Cat"]["kind"], by_author["Cat"]["amount"], by_author["Cat"]["text"]),
                         ("paid", "£5.00", "thanks!"))
        self.assertEqual((by_author["Dee"]["amount"], by_author["Dee"]["text"]), ("$2.00", ""))
        self.assertEqual((by_author["Eve"]["kind"], by_author["Eve"]["role"], by_author["Eve"]["text"]),
                         ("member", "member", "Welcome to the club!"))

    def test_an_author_is_named_by_channel_and_their_picture_kept_back(self):
        def said(name, channel, *photos):
            item = text(name, "hi")
            item["liveChatTextMessageRenderer"].update({
                "authorExternalChannelId": channel,
                "authorPhoto": {"thumbnails": [{"url": url} for url in photos]}})
            return item
        path = self.replay("\n".join([
            line(1000, said("Ann", "UCann", "https://yt3.example/ann32", "https://yt3.example/ann64")),
            line(2000, said("Bob", "UCbob", "http://insecure.example/bob")),
            line(3000, said("Ann", "UCann", "https://yt3.example/ann-new")),
        ]))
        messages = parse(path)
        # The page is told whose it is, never where the picture lives.
        self.assertEqual([m.get("a") for m in messages], ["UCann", None, "UCann"])
        self.assertFalse(any("_photo" in m for m in messages))
        replays = ChatReplays()
        self.assertEqual(replays.photo(path, "UCann"), "https://yt3.example/ann-new")
        self.assertEqual(replays.photo(path, "UCbob"), "")
        self.assertEqual(replays.photo(path, "UCnobody"), "")

    def test_a_window_is_a_slice_and_the_parse_is_kept(self):
        path = self.replay()
        replays = ChatReplays()
        self.assertEqual([m["author"] for m in replays.window(path, 1000, 2500)], ["Ann", "Bea", "Cat"])
        self.assertEqual(replays.window(path, 6000, 9000), [])
        # Unchanged on disk, so the second window comes from memory.
        path.chmod(0o000)
        try:
            self.assertEqual(len(replays.window(path, 0, 1000)), 1)
        finally:
            path.chmod(0o644)
        # A replay rewritten in place is read again.
        self.replay(line(500, text("New", "fresh")))
        self.assertEqual([m["author"] for m in replays.window(path, 0, 9000)], ["New"])
        self.assertEqual(replays.window(self.root / "gone.live_chat.json", 0, 9000), [])

    def test_the_oldest_replay_is_dropped(self):
        replays = ChatReplays(keep=1)
        first = self.replay()
        second = self.root / "other.live_chat.json"
        second.write_text(line(1, text("Ann", "hi")) + "\n", encoding="utf-8")
        replays.window(first, 0, 1)
        replays.window(second, 0, 1)
        self.assertEqual(list(replays._replays), [second])

    def test_the_archive_serves_the_chat_of_the_stream_that_has_it(self):
        (self.root / "stream.info.json").write_text('{"title":"Stream"}')
        (self.root / "stream.mp4").write_bytes(b"video")
        (self.root / "plain.info.json").write_text('{"title":"Plain"}')
        (self.root / "plain.mp4").write_bytes(b"video")
        self.replay()
        archive = Archive(self.root)
        records = {record["title"]: record for record in archive.scan()}
        self.assertEqual(records["Plain"]["_chat_url"], "")
        self.assertEqual(records["Stream"]["_chat_url"], "/api/chat/stream.info.json")
        served = archive.chat("stream.info.json", 1000, 2000)
        self.assertEqual((served["held"], [m["author"] for m in served["messages"]]),
                         (True, ["Ann", "Bea"]))
        self.assertEqual(archive.chat("plain.info.json", 0, 9000), {"held": False, "messages": []})
        self.assertIsNone(archive.chat("missing.info.json", 0, 9000))


if __name__ == "__main__":
    unittest.main()
