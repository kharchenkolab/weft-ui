"""UI-only endpoints — the seams the tool surface doesn't cover.

As of weft 9a30cdb the enumeration verbs (jobs_where, list_envs,
list_kernels, list_services, audit_tail) are PUBLIC_TOOLS, so the web
client calls them through the facade like any peer. What remains here is
the live log sub-stream (plan D3): `task_logs` is cursor-polling, so the
server polls at 1 s per open pane and re-emits over SSE — UI copy says
"live (1 s)", honest not fake.
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
    follows: dict[str, int] = {}  # client host -> open follow count

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
