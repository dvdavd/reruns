"""What a viewer has chosen in the page (theme, player and download options, resume
positions), kept with their account so it follows them between browsers.

The page keeps a copy in the browser too, because the theme has to be known
before the first paint. These checks only decide what the server will store: the
page decides which of its own keys it syncs."""
import re

POSITION_PREFIX = "reruns.playback:"
_KEY = re.compile(r"(?:(?:archive|ytdlp)-[a-z0-9-]{1,80}|" + re.escape(POSITION_PREFIX) + r".{1,300})\Z")
MAX_VALUE = 20_000
MAX_CHANGES = 1_000


def clean_values(raw: object, *, allow_null: bool = False, defaults: bool = False) -> dict:
    """The key/value pairs worth keeping. Anything else is refused outright
    rather than trimmed, since the page only ever sends keys it knows. A resume
    position is one person's, so it is never offered as an admin default."""
    if not isinstance(raw, dict) or len(raw) > MAX_CHANGES:
        raise ValueError("Expected an object of preferences")
    clean = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not _KEY.match(key) or (defaults and key.startswith(POSITION_PREFIX)):
            raise ValueError("Unknown preference")
        if value is None and allow_null:
            clean[key] = None
        elif isinstance(value, str) and len(value) <= MAX_VALUE:
            clean[key] = value
        else:
            raise ValueError("A preference must be text")
    return clean
