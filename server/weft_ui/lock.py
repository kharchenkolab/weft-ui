"""Single-writer guard (plan R7): one weft-ui per workspace.

Two servers embedding two `Weft` controllers on one workspace would
corrupt the single-writer invariants, so we take an exclusive flock on
`.weft/ui.lock` for the life of the process and refuse to boot if it is
already held.
"""

from __future__ import annotations

import fcntl
import os
from pathlib import Path


class WorkspaceLocked(RuntimeError):
    pass


class UILock:
    def __init__(self, workspace: Path):
        self.path = workspace / ".weft" / "ui.lock"
        self._fd: int | None = None

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            holder = ""
            try:
                holder = os.read(fd, 64).decode().strip()
            except OSError:
                pass
            os.close(fd)
            raise WorkspaceLocked(
                f"another weft-ui is serving this workspace"
                f"{f' (pid {holder})' if holder else ''} — lock: {self.path}"
            ) from None
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
        self._fd = fd

    def release(self) -> None:
        if self._fd is not None:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
            os.close(self._fd)
            self._fd = None
