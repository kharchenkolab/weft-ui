"""UI-only endpoints: the seams PUBLIC_TOOLS doesn't cover (plan Pass 1 §6).

Store-level list APIs (jobs, envs, kernels, services, audit) exist in weft
but aren't exported as tools yet — an upstream ask is filed; until then the
UI reads them in-process here. Plus the live log sub-stream (plan D3):
`task_logs` is cursor-polling, so the server polls at 1 s per open pane
and re-emits over SSE — UI copy says "live (1 s)", honest not fake.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

from anyio import to_thread
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

LOG_POLL_S = 1.0
MAX_FOLLOWS_PER_CLIENT = 4
RUNNING_STATES = {"RUNNING", "QUEUED", "STAGING", "SUBMITTED"}


def build_router(weft: Any) -> APIRouter:
    router = APIRouter(prefix="/api/ui")
    store = weft.store
    follows: dict[str, int] = {}  # client host -> open follow count

    @router.get("/jobs")
    async def jobs(state: str | None = None, site: str | None = None):
        return await to_thread.run_sync(lambda: store.jobs_where(state, site))

    @router.get("/envs")
    async def envs():
        return await to_thread.run_sync(store.list_envs)

    @router.get("/kernels")
    async def kernels(state: str | None = None):
        return await to_thread.run_sync(lambda: store.list_kernels(state))

    @router.get("/services")
    async def services(state: str | None = None):
        return await to_thread.run_sync(lambda: store.list_services(state))

    @router.get("/audit")
    async def audit(n: int = 50):
        return await to_thread.run_sync(lambda: store.audit_tail(n))

    @router.get("/jobs/{job_id}/logs/stream")
    async def log_stream(job_id: str, request: Request):
        """SSE sub-stream: tail once, then follow at 1 s while non-terminal."""
        client = request.client.host if request.client else "?"
        if follows.get(client, 0) >= MAX_FOLLOWS_PER_CLIENT:
            return JSONResponse(
                {"error": {"code": "too_many_follows",
                           "detail": f"max {MAX_FOLLOWS_PER_CLIENT} live log panes"}},
                status_code=429)

        async def sse() -> AsyncIterator[str]:
            follows[client] = follows.get(client, 0) + 1
            try:
                cursor = 0
                while True:
                    r = await to_thread.run_sync(
                        lambda c=cursor: weft.task_logs(job_id, follow_cursor=c))
                    if await request.is_disconnected():
                        return
                    if "error" in r:
                        yield f"data: {json.dumps(r)}\n\n"
                        return
                    if r["log"]:
                        yield f"data: {json.dumps(r)}\n\n"
                    cursor = r["cursor"]
                    if r["state"] not in RUNNING_STATES:
                        yield f"data: {json.dumps({'eof': True, 'state': r['state']})}\n\n"
                        return
                    await asyncio.sleep(LOG_POLL_S)
            finally:
                follows[client] -= 1

        return StreamingResponse(sse(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache"})

    return router
