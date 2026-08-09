"""The agent's weft tool surface: generated, like the HTTP facade (D1/D5).

Every PUBLIC_TOOLS entry becomes an in-process SDK MCP tool whose handler
is a thin closure over the SAME `Weft` instance the buttons use — same
returns-never-raises payloads, same store, one audit trail. Calls run in
the thread pool under weft's native `as_actor` seam (weft >=baec7f0),
stamped "agent:<conversation>" — the audit trail names WHICH chat acted,
and conversation-scope footprints join it directly.

Tool results are the tool's JSON verbatim: the panel's renderers and the
agent read the identical payload — no parallel state.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from anyio import to_thread
from claude_agent_sdk import create_sdk_mcp_server, tool

from weft.mcp_server import build_tool_defs

from ..facade import decycle

SERVER_NAME = "weft"


def _inherit_campaign(name: str, args: dict, campaign: str | None) -> dict:
    """The tail sweeps into the open campaign — AUTHORITATIVELY: while a
    campaign is open its label replaces any hand-written label= (two live
    scenario runs showed the agent labeling beside its own declaration,
    which orphans the work from its campaign; changing labels is what
    campaign_set is for)."""
    if not campaign:
        return args
    if name == "task_submit":
        task = dict(args.get("task") or {})
        if task.get("label") != campaign:
            task["label"] = campaign
            return {**args, "task": task}
    elif name in ("run_retain", "kernel_start") \
            and args.get("label") != campaign:
        return {**args, "label": campaign}
    return args


def build_weft_mcp_server(weft: Any, actor: str = "agent",
                          campaign: Callable[[], str | None] | None = None,
                          extra_tools: list | None = None):
    """Returns (sdk_mcp_server, allowed_tool_names)."""
    sdk_tools = list(extra_tools or [])
    names = [f"mcp__{SERVER_NAME}__{t.name}" for t in sdk_tools]
    for tdef in build_tool_defs(type(weft)):
        name = tdef["name"]

        async def handler(args: dict[str, Any], _name: str = name) -> dict[str, Any]:
            def call() -> Any:
                kwargs = _inherit_campaign(
                    _name, args, campaign() if campaign else None)
                with weft.as_actor(actor):
                    return getattr(weft, _name)(**kwargs)

            try:
                result = await to_thread.run_sync(call)
            except TypeError as e:  # signature violation — schema said otherwise
                return {"content": [{"type": "text",
                                     "text": json.dumps({"error": "bad_arguments",
                                                         "detail": str(e)})}],
                        "is_error": True}
            return {
                "content": [{"type": "text",
                             "text": json.dumps(decycle(result), default=str)}],
                "is_error": isinstance(result, dict) and "error" in result,
            }

        sdk_tools.append(
            tool(name, tdef["description"][:1000], tdef["inputSchema"])(handler))
        names.append(f"mcp__{SERVER_NAME}__{name}")

    server = create_sdk_mcp_server(name=SERVER_NAME, version="1.0.0", tools=sdk_tools)
    return server, names
