"""App factory and entrypoint: one server, one workspace, one Weft.

Boot order (lifespan): take the single-writer lock, construct the Weft
controller, start the event bridge, `reconcile()` so watching resumes for
jobs that were running when the last process died. Bind 127.0.0.1 only;
a fresh bearer token is minted per process and printed once (the served
page gets it injected; the vite dev client passes ?token=).

Single asyncio process is an invariant, not a limitation (plan R9): the
one-controller model and the SSE fan-out both assume exactly one loop.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import events, facade, uiapi, wizard
from .chat import actor as chat_actor
from .chat import router as chat_router
from .auth import AuthMiddleware, mint_token
from .config import UIConfig
from .lock import UILock, WorkspaceLocked

WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"


def create_app(workspace: Path, *, token: str | None = None,
               port: int = 8999, banner: str | None = None) -> FastAPI:
    if os.environ.get("UVICORN_WORKER_ID") or os.environ.get("WEB_CONCURRENCY", "1") != "1":
        raise RuntimeError("weft-ui must run single-process (one Weft controller "
                           "per workspace); do not use --workers")
    workspace = Path(workspace).resolve()
    token = token or mint_token()
    lock = UILock(workspace)
    # host-app embedding (R1): configured origins may frame the UI and
    # call /api; everything else keeps the strict same-origin posture
    embed_origins = list(UIConfig.load(workspace).embed_origins)
    frame_csp = "frame-ancestors 'self'" + ("".join(f" {o}" for o in embed_origins))

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        from weft.api import Weft

        lock.acquire()
        # this instance serves the human: audited actions say "user".
        # The chat milestone (M3) gives the agent its own actor seam.
        weft = Weft(workspace, default_actor="user")
        bridge = events.EventBridge(weft.store)
        bridge.start(asyncio.get_running_loop())
        await asyncio.to_thread(weft.reconcile)
        app.state.weft = weft
        app.state.bridge = bridge
        app.state.config = UIConfig.load(workspace)
        chat_actor.install(weft.store)  # agent tool calls audit as "agent"
        app.state.chat = chat_router.ChatManager(weft, workspace, app.state.config)
        app.include_router(facade.build_router(weft))
        app.include_router(events.build_router(bridge))
        app.include_router(uiapi.build_router(weft))
        app.include_router(chat_router.build_router(app.state.chat))
        _register_spa_fallback(app, token, frame_csp)  # last: routes match in order
        print(f"weft-ui: workspace {workspace}", file=sys.stderr)
        # under an ASGI mount the origin is the host's — no URL to print
        print(f"weft-ui: {banner}" if banner
              else f"weft-ui: http://127.0.0.1:{port}/?token={token}",
              file=sys.stderr)
        yield
        bridge.stop()
        lock.release()

    app = FastAPI(title="weft-ui", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(
        AuthMiddleware, token=token,
        allowed_origins={f"http://127.0.0.1:{port}", f"http://localhost:{port}",
                         "http://127.0.0.1:5173", "http://localhost:5173",
                         *embed_origins},
    )
    app.state.token = token

    @app.get("/api/ping")
    async def ping():
        return {"ok": True, "workspace": str(workspace)}

    app.include_router(wizard.build_router())  # needs no Weft: pre-registration probes

    if WEB_DIST.exists():
        index = (WEB_DIST / "index.html").read_text()

        @app.get("/", response_class=HTMLResponse)
        async def home():
            return HTMLResponse(index.replace("%%WEFT_UI_TOKEN%%", token),
                                headers={"Content-Security-Policy": frame_csp})

        app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")
    else:

        @app.get("/", response_class=HTMLResponse)
        async def stub():
            return HTMLResponse("<h1>weft-ui</h1><p>web/dist not built — run "
                                "<code>pixi run web-build</code>, or use the vite dev server "
                                "(<code>pixi run web-dev</code>).</p>",
                                headers={"Content-Security-Policy": frame_csp})

    return app


def _register_spa_fallback(app: FastAPI, token: str, frame_csp: str) -> None:
    """Catch-all for client-side routes. Registered at the END of lifespan
    startup so every API router outranks it (routes match in order)."""
    if not WEB_DIST.exists():
        return
    index = (WEB_DIST / "index.html").read_text()

    @app.get("/{path:path}", response_class=HTMLResponse)
    async def spa_fallback(path: str):
        if path.startswith("api/"):  # belt-and-suspenders: never serve HTML on /api
            return JSONResponse({"error": {"code": "not_found", "detail": path}},
                                status_code=404)
        file = WEB_DIST / path
        if file.is_file():
            return FileResponse(file)
        return HTMLResponse(index.replace("%%WEFT_UI_TOKEN%%", token),
                            headers={"Content-Security-Policy": frame_csp})


def cli() -> None:
    import argparse

    import uvicorn

    ap = argparse.ArgumentParser(prog="weft-ui")
    ap.add_argument("command", nargs="?", default="serve", choices=["serve"])
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--port", type=int, default=8999)
    ap.add_argument("--token", default=None,
                    help="bearer token (default: random per process)")
    args = ap.parse_args()
    try:
        app = create_app(Path(args.workspace), token=args.token, port=args.port)
    except WorkspaceLocked as e:
        print(f"error: {e}", file=sys.stderr)
        raise SystemExit(2) from None
    # open SSE streams never end on their own — without a graceful-shutdown
    # cap, SIGTERM waits on them forever, the process lingers, and the
    # workspace flock is never released
    uvicorn.run(app, host="127.0.0.1", port=args.port, workers=1,
                log_level="warning", timeout_graceful_shutdown=3)


if __name__ == "__main__":
    cli()
