"""The agent's weft tool surface: generated, like the HTTP facade (D1/D5).

Every PUBLIC_TOOLS entry becomes an in-process SDK MCP tool whose handler
is a thin closure over the SAME `Weft` instance the buttons use — same
returns-never-raises payloads, same store, one audit trail. Calls run in
the thread pool under the "agent" actor (chat/actor.py contextvar).

Tool results are the tool's JSON verbatim: the panel's renderers and the
agent read the identical payload — no parallel state.
"""

from __future__ import annotations

import json
from typing import Any

from anyio import to_thread
from claude_agent_sdk import create_sdk_mcp_server, tool

from weft.mcp_server import build_tool_defs

from .actor import agent_actor

SERVER_NAME = "weft"


def build_weft_mcp_server(weft: Any):
    """Returns (sdk_mcp_server, allowed_tool_names)."""
    sdk_tools = []
    names = []
    for tdef in build_tool_defs(type(weft)):
        name = tdef["name"]

        async def handler(args: dict[str, Any], _name: str = name) -> dict[str, Any]:
            def call() -> Any:
                with agent_actor():
                    return getattr(weft, _name)(**args)

            try:
                result = await to_thread.run_sync(call)
            except TypeError as e:  # signature violation — schema said otherwise
                return {"content": [{"type": "text",
                                     "text": json.dumps({"error": "bad_arguments",
                                                         "detail": str(e)})}],
                        "is_error": True}
            return {
                "content": [{"type": "text", "text": json.dumps(result, default=str)}],
                "is_error": isinstance(result, dict) and "error" in result,
            }

        sdk_tools.append(
            tool(name, tdef["description"][:1000], tdef["inputSchema"])(handler))
        names.append(f"mcp__{SERVER_NAME}__{name}")

    server = create_sdk_mcp_server(name=SERVER_NAME, version="1.0.0", tools=sdk_tools)
    return server, names
