"""Filesystem failures said briefly, for messages a person reads.

Python words an OSError as "[Errno 13] Permission denied: '/srv/x'". Put into
a sentence that already names the folder, that gave "Could not create /srv/x:
[Errno 13] Permission denied: '/srv/x'" - the number means nothing to a
reader and the path appeared twice. The operating system's own phrase is
enough on its own.
"""
from __future__ import annotations

import errno

# Refusals of access, the usual failure and one worth its own plain sentence.
DENIED = frozenset({errno.EACCES, errno.EPERM})


def reason(error: BaseException) -> str:
    """The failure without its number or path: "Permission denied". Anything
    that is not an OSError (sqlite's refusal of a read-only database, say)
    is already worded for reading and comes back as it is."""
    return getattr(error, "strerror", None) or str(error)
