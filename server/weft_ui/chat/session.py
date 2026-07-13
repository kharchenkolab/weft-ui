"""The Agent SDK wrapper (plan D5/R5): everything SDK-touching lives here.

One turn = one `query()` with `resume=<sdk session id>` — the SDK persists
the conversation server-side in ~/.claude, so turns survive OUR restarts
too. The wrapper's stable seam is typed events (dicts), emitted in order:

    {type: "user_text", text}
    {type: "text", text}                         assistant prose
    {type: "tool_call", id, tool, args}
    {type: "tool_result", id, tool, payload, is_error}
    {type: "approval_request", id, tool, args, tier, reason, plan?}
    {type: "approval_resolved", id, decision}
    {type: "turn_done", subtype, cost_usd, total_cost_usd, num_turns}
    {type: "error", detail}

Gate face 2 (plan D4): `can_use_tool` classifies weft tools; a gated call
emits approval_request and awaits a future the approval endpoint
resolves — defer + resume, never kill-and-restart. The tier comes from
the PLAN (a task_submit dry_run), not the phrasing.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from anyio import to_thread
from claude_agent_sdk import (AssistantMessage, ClaudeAgentOptions,
                              PermissionResultAllow, PermissionResultDeny,
                              ResultMessage, TextBlock, ThinkingBlock,
                              ToolResultBlock, ToolUseBlock, UserMessage, query)

from weft.api import DENY_PATTERNS

from .actor import agent_actor
from .tools import SERVER_NAME, build_weft_mcp_server

Emit = Callable[[dict], Awaitable[None]]

# account-shaped / destructive: always ask, regardless of plan numbers
ALWAYS_GATED = {"register_site", "site_teardown", "site_unregister",
                "gc_sweep", "gc_packages", "bundle_import"}


def _skill_text(weft_repo: Path) -> str:
    """The weft skill mounted as doctrine — inlined into the system prompt
    (the agent has no filesystem tools in this panel)."""
    skill = weft_repo / "skills" / "weft" / "SKILL.md"
    parts = []
    if skill.exists():
        parts.append(skill.read_text())
    refs = weft_repo / "skills" / "weft" / "references"
    if refs.is_dir():
        for p in sorted(refs.glob("*.md")):
            body = p.read_text()
            parts.append(f"\n\n## Reference: {p.name}\n\n{body}")
    return "\n".join(parts)


class AgentSession:
    """One conversation's agent runtime. Not named *session* in any API —
    weft owns that word; this class is internal."""

    def __init__(self, weft: Any, workspace: Path, emit: Emit,
                 confirm_staging_gb: float):
        self.weft = weft
        self.workspace = workspace
        self.emit = emit
        self.confirm_staging_gb = confirm_staging_gb
        self.mcp_server, self.allowed = build_weft_mcp_server(weft)
        self.pending_approvals: dict[str, asyncio.Future] = {}
        self.tool_names: dict[str, str] = {}  # tool_use_id -> tool name
        weft_repo = Path(weft.workspace).resolve()
        # the skill lives in the weft REPO; fall back gracefully outside dev
        for candidate in [Path(__file__).resolve().parents[4] / "weft",
                          weft_repo]:
            if (candidate / "skills" / "weft" / "SKILL.md").exists():
                self.skill = _skill_text(candidate)
                break
        else:
            self.skill = ""

    # ---- gate face 2 ----------------------------------------------------

    async def _can_use_tool(self, tool_name: str, input_data: dict,
                            _context: Any) -> Any:
        if tool_name == "ToolSearch":
            return PermissionResultAllow()  # read-only: loads deferred MCP tools
        if not tool_name.startswith(f"mcp__{SERVER_NAME}__"):
            return PermissionResultDeny(
                message="this panel exposes only weft tools")
        short = tool_name.removeprefix(f"mcp__{SERVER_NAME}__")

        plan = None
        tier = "free"
        reason = ""
        if short in ALWAYS_GATED:
            tier = "account"
            reason = "destructive or account-level effect"
        elif short == "site_exec":
            cmd = str(input_data.get("command", ""))
            if any(p.search(cmd) for p in DENY_PATTERNS):
                return PermissionResultDeny(
                    message="command matches weft's deny patterns")
        elif short == "task_submit" and not input_data.get("dry_run"):
            # tier from the PLAN, not vibes: dry_run is free and side-effect-less
            def dry() -> Any:
                with agent_actor():
                    return self.weft.task_submit(dict(input_data.get("task", {})),
                                                 dry_run=True)
            plan_result = await to_thread.run_sync(dry)
            plan = plan_result.get("plan") if isinstance(plan_result, dict) else None
            bytes_to_move = ((plan or {}).get("staging") or {}).get("bytes_to_move", 0)
            gb = bytes_to_move / 1024 ** 3
            if gb > self.confirm_staging_gb:
                tier = "costly"
                reason = (f"staging {gb:.1f} GB exceeds the "
                          f"{self.confirm_staging_gb:g} GB auto-approve threshold")

        if tier == "free":
            return PermissionResultAllow()

        rid = "apr_" + uuid.uuid4().hex[:8]
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending_approvals[rid] = fut
        await self.emit({"type": "approval_request", "id": rid, "tool": short,
                         "args": input_data, "tier": tier, "reason": reason,
                         "plan": plan, "ts": time.time()})
        try:
            decision = await fut  # resolved by the approval endpoint
        finally:
            self.pending_approvals.pop(rid, None)
        await self.emit({"type": "approval_resolved", "id": rid,
                         "decision": decision, "ts": time.time()})
        if decision == "allow":
            return PermissionResultAllow()
        return PermissionResultDeny(
            message="the user denied this action in the approval card")

    def resolve_approval(self, rid: str, decision: str) -> bool:
        fut = self.pending_approvals.get(rid)
        if fut is None or fut.done():
            return False
        fut.set_result(decision)
        return True

    # ---- a turn ----------------------------------------------------------

    async def run_turn(self, text: str, *, model: str | None,
                       resume: str | None, budget_left_usd: float) -> dict:
        """Runs one user turn; returns {sdk_session_id, cost_usd, subtype}."""
        options = ClaudeAgentOptions(
            model=model or None,
            cwd=str(self.workspace),
            system_prompt=(
                "You are the analysis agent inside weft-ui, working a scientific "
                "workspace through weft's tools. The human sees every tool call "
                "and its full result as rendered cards — do not repeat payloads "
                "verbatim in prose; interpret them. Plans before effects: prefer "
                "task_submit(dry_run=True) first for anything that moves data. "
                "Read errors before retrying; never resubmit unchanged twice.\n\n"
                + self.skill),
            # NOTE: no allowed_tools — a whole-tool allow entry auto-approves
            # BEFORE can_use_tool is consulted (CanUseToolShadowedWarning),
            # which would silence the consent gate entirely. Every weft call
            # falls through to the callback instead.
            mcp_servers={SERVER_NAME: self.mcp_server},
            can_use_tool=self._can_use_tool,
            resume=resume,
            max_turns=40,
            max_budget_usd=max(budget_left_usd, 0.01),
        )
        out = {"sdk_session_id": resume, "cost_usd": 0.0, "subtype": "success"}

        async def prompt_stream():  # can_use_tool requires streaming-mode input
            yield {"type": "user", "message": {"role": "user", "content": text}}

        async for message in query(prompt=prompt_stream(), options=options):
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock) and block.text.strip():
                        await self.emit({"type": "text", "text": block.text,
                                         "ts": time.time()})
                    elif isinstance(block, ToolUseBlock):
                        short = block.name.removeprefix(f"mcp__{SERVER_NAME}__")
                        self.tool_names[block.id] = short
                        await self.emit({"type": "tool_call", "id": block.id,
                                         "tool": short, "args": block.input,
                                         "ts": time.time()})
                    elif isinstance(block, ThinkingBlock):
                        pass  # keep the panel calm; transcripts stay prose+cards
            elif isinstance(message, UserMessage):
                content = message.content if isinstance(message.content, list) else []
                for block in content:
                    if isinstance(block, ToolResultBlock):
                        payload = _parse_result(block)
                        await self.emit({
                            "type": "tool_result", "id": block.tool_use_id,
                            "tool": self.tool_names.get(block.tool_use_id, "?"),
                            "payload": payload,
                            "is_error": bool(block.is_error),
                            "ts": time.time()})
            elif isinstance(message, ResultMessage):
                out["sdk_session_id"] = message.session_id
                out["cost_usd"] = message.total_cost_usd or 0.0
                out["subtype"] = message.subtype
                await self.emit({"type": "turn_done", "subtype": message.subtype,
                                 "cost_usd": message.total_cost_usd,
                                 "num_turns": message.num_turns,
                                 "ts": time.time()})
        return out


def _parse_result(block: ToolResultBlock) -> Any:
    """Our weft tools return one JSON text block; parse it back for the
    renderers. Anything else passes through as text."""
    content = block.content
    if isinstance(content, list):
        texts = [c.get("text", "") if isinstance(c, dict) else str(c)
                 for c in content]
        raw = "\n".join(t for t in texts if t)
    else:
        raw = str(content) if content is not None else ""
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return raw
