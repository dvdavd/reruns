"""Locate bundled assets, or their editable copies in a source checkout."""

from pathlib import Path
import os


def asset_root(name: str) -> Path:
    package = Path(__file__).resolve().parent
    bundled = package / "assets" / name
    return bundled if bundled.is_dir() else package.parent / name


def default_cache_dir() -> Path:
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "reruns"
