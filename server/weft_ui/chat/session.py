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
from claude_agent_sdk.types import HookMatcher

from weft.api import DENY_PATTERNS

from .actor import agent_actor
from .gate import classify, discover_skills, parse_mcp_json
from .tools import SERVER_NAME, build_weft_mcp_server

Emit = Callable[[dict], Awaitable[None]]

# account-shaped / destructive: always ask, regardless of plan numbers
ALWAYS_GATED = {"register_site", "site_teardown", "site_unregister", "run_forget",
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


def _fmt_size(gb: float) -> str:
    """Humane size for approval-card copy — '682 B', '3.2 MB', '6.0 GB'.
    A demo threshold of 1e-07 GB must not render as '0.0 GB'."""
    b = gb * 1024 ** 3
    for unit, div in (("GB", 1024 ** 3), ("MB", 1024 ** 2), ("KB", 1024)):
        if b >= div:
            v = b / div
            return f"{v:.1f} {unit}" if v < 100 else f"{v:,.0f} {unit}"
    return f"{b:,.0f} B"


class AgentSession:
    """One conversation's agent runtime. Not named *session* in any API —
    weft owns that word; this class is internal."""

    def __init__(self, weft: Any, workspace: Path, emit: Emit,
                 config: Any):
        self.weft = weft
        self.workspace = workspace
        self.emit = emit
        self.config = config  # shared UIConfig; the approval endpoint mutates it
        self.mcp_server, self.allowed = build_weft_mcp_server(weft)
        self.pending_approvals: dict[str, asyncio.Future] = {}
        self.tool_names: dict[str, str] = {}  # tool_use_id -> tool name
        # foreign MCP servers approved for THIS conversation (durable allows
        # live in config.chat_allowed_mcp_servers)
        self.approved_servers: set[str] = set()
        weft_repo = Path(weft.workspace).resolve()
        # the skill lives in the weft REPO; fall back gracefully outside dev
        for candidate in [Path(__file__).resolve().parents[4] / "weft",
                          weft_repo]:
            if (candidate / "skills" / "weft" / "SKILL.md").exists():
                self.skill = _skill_text(candidate)
                break
        else:
            self.skill = ""

    # ---- gate v2: the PreToolUse perimeter --------------------------------

    async def _pre_tool_gate(self, input_data: dict, _tool_use_id: Any,
                             _context: Any) -> dict:
        """Sees EVERY tool call (built-ins included — can_use_tool never
        does) and cannot be shadowed by settings allow-rules. Weft tools
        fall through to _can_use_tool, the proven tiered path."""
        tool_name = str(input_data.get("tool_name", ""))
        d = classify(tool_name, dict(input_data.get("tool_input") or {}),
                     workspace=self.workspace, weft_server=SERVER_NAME,
                     allowed_servers=(set(self.config.chat_allowed_mcp_servers)
                                      | self.approved_servers))
        if d.verdict == "gate-weft":
            return {}  # no opinion — falls through to can_use_tool
        if d.verdict == "allow":
            return _hook_decision("allow", d.reason)
        if d.verdict == "gate-foreign":
            # first use of this MCP server: the human decides, per server —
            # awaited HERE because the external-MCP can_use_tool round-trip
            # is broken in SDK 0.2.116 (hook-allow is the working path, E11)
            decision, always = await self._await_approval(
                tool=tool_name, tier="foreign", server=d.server,
                reason=(f"first use of MCP server '{d.server}' — its tools "
                        "run outside weft's audit trail"))
            if decision == "allow":
                self.approved_servers.add(d.server)
                return _hook_decision(
                    "allow", f"user approved MCP server '{d.server}'"
                             + (" (always)" if always else ""))
            return _hook_decision(
                "deny", "the user denied this MCP server in the approval card")
        return _hook_decision("deny", d.reason)

    # ---- gate face 2 (weft tools; in-process path, unchanged) -------------

    async def _can_use_tool(self, tool_name: str, input_data: dict,
                            _context: Any) -> Any:
        if tool_name == "ToolSearch":
            return PermissionResultAllow()  # read-only: loads deferred MCP tools
        if not tool_name.startswith(f"mcp__{SERVER_NAME}__"):
            # the hook already gated everything else; this is the belt
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
            if gb > self.config.confirm_staging_gb:
                tier = "costly"
                reason = (f"staging {_fmt_size(gb)} exceeds the "
                          f"{_fmt_size(self.config.confirm_staging_gb)} "
                          "auto-approve threshold")

        if tier == "free":
            return PermissionResultAllow()

        decision, _always = await self._await_approval(
            tool=short, tier=tier, reason=reason, args=input_data, plan=plan)
        if decision == "allow":
            return PermissionResultAllow()
        return PermissionResultDeny(
            message="the user denied this action in the approval card")

    async def _await_approval(self, *, tool: str, tier: str, reason: str,
                              args: dict | None = None, plan: Any = None,
                              server: str = "") -> tuple[str, bool]:
        """Emit an approval_request, block on the endpoint-resolved future.
        Returns (decision, always) — always is the card's persistence flag."""
        rid = "apr_" + uuid.uuid4().hex[:8]
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending_approvals[rid] = fut
        ev = {"type": "approval_request", "id": rid, "tool": tool,
              "args": args or {}, "tier": tier, "reason": reason,
              "plan": plan, "ts": time.time()}
        if server:
            ev["server"] = server
        await self.emit(ev)
        try:
            decision, always = await fut  # resolved by the approval endpoint
        finally:
            self.pending_approvals.pop(rid, None)
        await self.emit({"type": "approval_resolved", "id": rid,
                         "decision": decision, "ts": time.time()})
        return decision, always

    def resolve_approval(self, rid: str, decision: str,
                         always: bool = False) -> bool:
        fut = self.pending_approvals.get(rid)
        if fut is None or fut.done():
            return False
        fut.set_result((decision, always))
        return True

    # ---- a turn ----------------------------------------------------------

    async def run_turn(self, text: str, *, model: str | None,
                       resume: str | None, budget_left_usd: float) -> dict:
        """Runs one user turn; returns {sdk_session_id, cost_usd, subtype}."""
        # workspace capability, re-read each turn so edits to .claude/skills
        # or .mcp.json land without a server restart
        skills = discover_skills(self.workspace)
        ws_servers, mcp_err = parse_mcp_json(self.workspace)
        ws_servers.pop(SERVER_NAME, None)  # weft's name is reserved
        if mcp_err:
            await self.emit({"type": "error", "detail": mcp_err,
                             "ts": time.time()})
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
            mcp_servers={SERVER_NAME: self.mcp_server, **ws_servers},
            # the perimeter: sees built-ins and foreign MCP tools, which
            # never reach can_use_tool (session experiments E1-E11)
            hooks={"PreToolUse": [HookMatcher(hooks=[self._pre_tool_gate])]},
            can_use_tool=self._can_use_tool,
            # explicit, never inherited: None would load ~/.claude too
            setting_sources=list(self.config.chat_setting_sources),
            # explicit names only — skills="all" would shadow can_use_tool
            skills=[s["name"] for s in skills] or None,
            # workspace .mcp.json is parsed above and passed explicitly;
            # nothing else (user scope, plugins) sneaks servers in
            strict_mcp_config=True,
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
                # turn_done is NOT emitted here: the router broadcasts it
                # after persisting the updated meta, so a client that
                # refetches on turn_done reads fresh cost/state (emitting
                # before the save left the meter stale forever)
                out["sdk_session_id"] = message.session_id
                out["cost_usd"] = message.total_cost_usd or 0.0
                out["subtype"] = message.subtype
                out["num_turns"] = message.num_turns
        return out


def _hook_decision(decision: str, reason: str) -> dict:
    """PreToolUse hook decision envelope (SDK 0.2.116 shape)."""
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": decision,
        "permissionDecisionReason": reason,
    }}


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
