"""Generated HTTP facade over weft's tool surface (plan D1).

One wire contract, mechanically derived from `weft.api.PUBLIC_TOOLS`:

    GET  /api/w            -> tool index with JSON schemas (mcp_server machinery)
    POST /api/w/{tool}     -> kwargs in, tool return verbatim out (HTTP 200)

Weft's `tool()` decorator already guarantees returns-never-raises — errors
arrive as WeftError payloads inside a 200, byte-for-byte what the agent
sees. HTTP status codes are reserved for transport: 401 auth, 404 unknown
tool, 400 signature violation, 409 consent (gate). Calls run in the thread
pool: ssh round-trips block for seconds.

New upstream tools appear here automatically on restart — no UI release.
"""

from __future__ import annotations

import inspect
from typing import Any

from anyio import to_thread
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from weft.api import PUBLIC_TOOLS
from weft.mcp_server import build_tool_defs

# Tools whose effects are destructive or account-shaped: gated statically
# until the full plan-aware gate lands (M2, plan D4). A gated call without
# confirm=true returns 409 + an explanation instead of executing.
GATED_TOOLS = {"site_teardown", "gc_sweep", "gc_packages", "register_site",
               "run_forget"}  # deletes retained bytes — holdings, not knowledge


def build_router(weft: Any) -> APIRouter:
    router = APIRouter(prefix="/api/w")
    tool_defs = build_tool_defs(type(weft))
    tools = {t["name"] for t in tool_defs}
    assert tools == set(PUBLIC_TOOLS)

    @router.get("")
    def tool_index() -> dict:
        return {"tools": tool_defs, "gated": sorted(GATED_TOOLS)}

    @router.post("/{tool_name}")
    async def call_tool(tool_name: str, request: Request):
        if tool_name not in tools:
            return JSONResponse({"error": {"code": "unknown_tool", "detail": tool_name}},
                                status_code=404)
        body = await request.body()
        try:
            kwargs = _parse_kwargs(body)
        except ValueError as e:
            return JSONResponse({"error": {"code": "bad_request", "detail": str(e)}},
                                status_code=400)
        if tool_name in GATED_TOOLS and not kwargs.pop("_confirm", False):
            return JSONResponse(
                {"consent_required": {
                    "tool": tool_name,
                    "reason": "destructive or account-level effect",
                    "how": "repeat the call with \"_confirm\": true",
                }},
                status_code=409,
            )
        fn = getattr(weft, tool_name)
        try:
            inspect.signature(fn).bind(**kwargs)
        except TypeError as e:
            return JSONResponse({"error": {"code": "bad_arguments", "detail": str(e)}},
                                status_code=400)
        result = await to_thread.run_sync(lambda: fn(**kwargs))
        return JSONResponse(result)

    return router


def _parse_kwargs(body: bytes) -> dict:
    if not body:
        return {}
    import json
    try:
        kwargs = json.loads(body)
    except json.JSONDecodeError as e:
        raise ValueError(f"body is not JSON: {e}") from None
    if not isinstance(kwargs, dict):
        raise ValueError("body must be a JSON object of keyword arguments")
    return kwargs
