#!/usr/bin/env python3
"""Prepare Docker's writable mounts, then run the command without root."""
import errno
import os
from pathlib import Path
import sys


def identity(name):
    value = os.environ.get(name, "1000")
    if not value.isascii() or not value.isdecimal() or not 0 < int(value) < 2**32 - 1:
        raise ValueError(f"{name} must be a positive numeric UID/GID")
    return int(value)


def own(path, uid, gid):
    # Never follow a symlink out of an application volume into another mount.
    info = path.lstat()
    if (info.st_uid, info.st_gid) != (uid, gid):
        os.chown(path, uid, gid, follow_symlinks=False)


def prepare(uid, gid):
    for root in (Path("/config"), Path("/cache")):
        root.mkdir(parents=True, exist_ok=True)
        if root.is_symlink():
            raise ValueError(f"{root} must be a directory, not a symlink")
        own(root, uid, gid)
        for directory, folders, files in os.walk(root, followlinks=False):
            for name in folders + files:
                own(Path(directory) / name, uid, gid)
    prepare_media(Path("/media"), uid, gid)


def prepare_media(media, uid, gid):
    # An empty root-owned directory matches Docker's newly created bind
    # sources. Never change ownership of an existing archive or follow links.
    if media.is_symlink() or not media.is_dir() or media.stat().st_uid != 0:
        return
    with os.scandir(media) as entries:
        if next(entries, None) is not None:
            return
    try:
        own(media, uid, gid)
    except OSError as error:
        # Read-only libraries are valid for browsing, even when empty.
        if error.errno != errno.EROFS:
            raise


def main():
    if os.geteuid() == 0:
        uid, gid = identity("PUID"), identity("PGID")
        prepare(uid, gid)
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
    # An explicit docker --user bypasses ownership changes and uses that user.
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        sys.exit(f"Docker startup failed: {error}")
