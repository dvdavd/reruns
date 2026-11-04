"""The app's own version. Bump it here; the About page reads it from the server."""

from pathlib import Path

APP_VERSION = "0.8.2"


def _revision() -> str:
    # A running copy updated by commit rather than by release has its short
    # commit id written beside the package (by the update script), since the
    # container has no git and the worktree's .git points at the host.
    try:
        return (Path(__file__).resolve().parent.parent / ".revision").read_text().strip()
    except OSError:
        return ""


# "0.3.20+a88509c" for a checkout between releases, plain "0.3.20" otherwise.
DISPLAY_VERSION = f"{APP_VERSION}+{_revision()}" if _revision() else APP_VERSION
