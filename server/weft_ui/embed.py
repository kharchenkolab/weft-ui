"""In-process embedding (docs/embedding.md): mount weft-ui inside a host
FastAPI/Starlette app — one process, one port, one origin.

The one real trap is lifespans: Starlette does NOT run a mounted
sub-app's lifespan, and without it nothing starts (no Weft controller,
no flock, no event bridge, no chat). `attach()` chains the sub-app's
lifespan into the host's; hosts that prefer explicit wiring can use
`lifespan_of()` inside their own lifespan instead.
"""

from __future__ import annotations

import contextlib
from pathlib import Path

from fastapi import FastAPI

from .main import create_app


def lifespan_of(sub: FastAPI):
    """The mounted app's lifespan as a context manager — enter it inside
    your own lifespan if you don't use attach()'s automatic chaining."""
    return sub.router.lifespan_context(sub)


def attach(host_app: FastAPI, *, path: str, workspace: str | Path,
           token: str) -> FastAPI:
    """Mount weft-ui under `path` and run its lifespan within the host's.

    - one workspace per mount; the workspace flock still enforces a single
      writer (attaching one workspace twice fails loudly at startup)
    - call BEFORE the host app starts (lifespans are chained at attach time)
    - panels are same-origin: <iframe src="{path}/?token=…&embed=1#/…">
    """
    path = path.rstrip("/")
    if not path:
        raise ValueError("mount path must be non-root (e.g. '/weft/proj-a') "
                         "— at root, run weft-ui standalone instead")
    sub = create_app(Path(workspace), token=token, banner=f"mounted at {path}/")
    host_app.mount(path, sub)

    prev = host_app.router.lifespan_context

    @contextlib.asynccontextmanager
    async def chained(app):
        async with prev(app):
            async with sub.router.lifespan_context(sub):
                yield

    host_app.router.lifespan_context = chained
    return sub
