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

    @router.get("/envs/{env_id}/packages")
    async def env_packages(env_id: str):
        """The env's actual resolved packages — no PUBLIC_TOOL returns the
        list wholesale yet (env_status carries counts, env_why is
        per-package); upstream ask on file (round 23). Reads the stored
        canonical resolution; merged across platforms."""
        row = await to_thread.run_sync(lambda: weft.store.get_env(env_id))
        if not row:
            return JSONResponse(
                {"error": {"code": "unknown_env", "detail": env_id}},
                status_code=404)
        c = row.get("canonical") or {}
        merged: dict[tuple, set] = {}
        # newer format: layers[eco].records[]; at-rest format:
        # platforms[plat] = [{name, version, kind, …}]
        for eco, layer in (c.get("layers") or {}).items():
            for rec in layer.get("records", []) if isinstance(layer, dict) else []:
                key = (rec.get("name"), rec.get("version"), rec.get("kind", eco))
                merged.setdefault(key, set())
        for plat, recs in (c.get("platforms") or {}).items():
            if not isinstance(recs, list):
                continue
            for rec in recs:
                if not isinstance(rec, dict):
                    continue
                key = (rec.get("name"), rec.get("version"), rec.get("kind", "?"))
                merged.setdefault(key, set()).add(plat)
        packages = [
            {"name": n or "?", "version": v, "kind": k,
             "platforms": sorted(plats)}
            for (n, v, k), plats in sorted(merged.items(),
                                           key=lambda kv: str(kv[0][0]).lower())
        ]
        return {"env_id": env_id, "count": len(packages), "packages": packages}

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
