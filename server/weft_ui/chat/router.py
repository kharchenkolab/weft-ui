"""Chat HTTP surface: conversations CRUD, message turns, the typed-event
SSE stream (replay-then-live, same discipline as the jobs spine), and the
approval endpoint that resolves gate face 2's futures.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from .conversations import ConversationStore
from .session import AgentSession


class ChatManager:
    def __init__(self, weft: Any, workspace: Path, config: Any):
        self.weft = weft
        self.workspace = workspace
        self.config = config
        self.store = ConversationStore(workspace)
        self.sessions: dict[str, AgentSession] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.queues: dict[str, set[asyncio.Queue]] = {}

    def session_for(self, cid: str) -> AgentSession:
        if cid not in self.sessions:
            async def emit(ev: dict, _cid: str = cid) -> None:
                self._broadcast(_cid, ev)

            self.sessions[cid] = AgentSession(
                self.weft, self.workspace, emit, config=self.config)
        return self.sessions[cid]

    def drop_session(self, cid: str) -> None:
        """Forget the in-memory session (deleting a conversation must not
        leave a live SDK client keyed to a dead id)."""
        self.sessions.pop(cid, None)

    def _broadcast(self, cid: str, ev: dict) -> None:
        idx = self.store.append_event(cid, ev)
        # keep the sidebar honest: a pending card means the turn is paused
        # on a human — WAITING, not RUNNING (and back once resolved)
        t = ev.get("type")
        if t in ("approval_request", "approval_resolved"):
            meta = self.store.get(cid)
            if meta is not None and meta.state in ("running", "waiting_approval"):
                meta.state = "waiting_approval" if t == "approval_request" else "running"
                self.store.save_meta(meta)
        for q in self.queues.get(cid, set()):
            try:
                q.put_nowait((idx, ev))
            except asyncio.QueueFull:
                pass  # chat streams are short; a stuck tab just misses live

    async def run_turn(self, cid: str, text: str) -> None:
        meta = self.store.get(cid)
        if meta is None:
            return
        sess = self.session_for(cid)
        meta.state = "running"
        meta.turns += 1
        if meta.title == "New conversation" and text.strip():
            meta.title = text.strip()[:60]
        self.store.save_meta(meta)
        self._broadcast(cid, {"type": "user_text", "text": text, "ts": time.time()})
        try:
            out = await sess.run_turn(
                text, model=None if meta.model == "default" else meta.model,
                resume=meta.sdk_session_id,
                budget_left_usd=meta.budget_usd - meta.cost_usd)
            meta.sdk_session_id = out["sdk_session_id"]
            meta.cost_usd += out["cost_usd"] or 0.0
            # persist BEFORE broadcasting turn_done: clients refetch meta on
            # that event, and must see the new cost/state
            meta.state = "idle"
            self.store.save_meta(meta)
            self._broadcast(cid, {"type": "turn_done",
                                  "subtype": out.get("subtype"),
                                  "cost_usd": out.get("cost_usd"),
                                  "num_turns": out.get("num_turns"),
                                  "ts": time.time()})
        except Exception as e:  # SDK/transport failure — surface, don't die
            self._broadcast(cid, {"type": "error", "detail": str(e)[:2000],
                                  "ts": time.time()})
        finally:
            meta.state = "idle"
            self.store.save_meta(meta)


class NewConversation(BaseModel):
    title: str = "New conversation"
    model: str = "default"
    budget_usd: float | None = None


class RenameConversation(BaseModel):
    title: str


class NewMessage(BaseModel):
    text: str


class ApprovalDecision(BaseModel):
    request_id: str
    decision: str  # "allow" | "deny"
    always_allow_staging_gb: float | None = None
    # foreign tier: MCP server name to allow durably (workspace config)
    always_allow_server: str | None = None


def build_router(manager: ChatManager) -> APIRouter:
    router = APIRouter(prefix="/api/chat")

    @router.get("/conversations")
    async def list_conversations():
        return [vars(m) for m in manager.store.list()]

    @router.post("/conversations")
    async def create_conversation(body: NewConversation):
        model = body.model if body.model != "default" else manager.config.chat_model
        meta = manager.store.create(
            body.title, model,
            body.budget_usd if body.budget_usd is not None
            else manager.config.chat_budget_usd)
        return vars(meta)

    @router.patch("/conversations/{cid}")
    async def rename_conversation(cid: str, body: RenameConversation):
        meta = manager.store.rename(cid, body.title)
        if meta is None:
            return JSONResponse({"error": {"code": "unknown_conversation"}}, 404)
        return vars(meta)

    @router.delete("/conversations/{cid}")
    async def delete_conversation(cid: str):
        meta = manager.store.get(cid)
        if meta is None:
            return JSONResponse({"error": {"code": "unknown_conversation"}}, 404)
        if meta.state == "running":
            return JSONResponse(
                {"error": {"code": "conversation_running",
                           "detail": "wait for the turn to finish"}}, 409)
        manager.drop_session(cid)
        manager.store.delete(cid)
        return {"ok": True}

    @router.post("/conversations/{cid}/message")
    async def send_message(cid: str, body: NewMessage):
        meta = manager.store.get(cid)
        if meta is None:
            return JSONResponse({"error": {"code": "unknown_conversation"}}, 404)
        if manager.tasks.get(cid) and not manager.tasks[cid].done():
            return JSONResponse(
                {"error": {"code": "turn_in_progress",
                           "detail": "wait for the current turn (or approve/deny "
                                     "its pending card)"}}, 409)
        if meta.cost_usd >= meta.budget_usd:
            return JSONResponse(
                {"error": {"code": "budget_exhausted",
                           "detail": f"${meta.cost_usd:.2f} of ${meta.budget_usd:.2f} "
                                     "spent — raise the cap to continue"}}, 409)
        manager.tasks[cid] = asyncio.create_task(manager.run_turn(cid, body.text))
        return {"ok": True}

    @router.post("/conversations/{cid}/approval")
    async def approve(cid: str, body: ApprovalDecision):
        sess = manager.sessions.get(cid)
        always = bool(body.always_allow_staging_gb or body.always_allow_server)
        if sess is None or not sess.resolve_approval(
                body.request_id, body.decision, always=always):
            return JSONResponse(
                {"error": {"code": "unknown_approval",
                           "detail": "no pending approval with that id"}}, 404)
        if body.decision == "allow" and body.always_allow_staging_gb:
            manager.config.confirm_staging_gb = float(body.always_allow_staging_gb)
            manager.config.save(manager.workspace)
        if body.decision == "allow" and body.always_allow_server:
            if body.always_allow_server not in manager.config.chat_allowed_mcp_servers:
                manager.config.chat_allowed_mcp_servers.append(body.always_allow_server)
                manager.config.save(manager.workspace)
        return {"ok": True}

    @router.get("/setup")
    async def setup():
        """What the agent is equipped with, and who decided — the Agent
        setup panel's single read."""
        from ..chat.gate import discover_skills, parse_mcp_json
        from .tools import SERVER_NAME

        skills = [{"name": s["name"], "description": s["description"],
                   "source": "workspace (.claude/skills)"}
                  for s in discover_skills(manager.workspace)]
        skills.insert(0, {
            "name": "weft", "source": "built-in",
            "description": "execution doctrine — inlined into the system prompt"})

        ws_servers, mcp_err = parse_mcp_json(manager.workspace)
        allowed = set(manager.config.chat_allowed_mcp_servers)
        servers = [{
            "name": SERVER_NAME, "source": "built-in", "transport": "in-process",
            "consent": "tiered gate (plan-based approval cards)"}]
        for name, cfg in ws_servers.items():
            servers.append({
                "name": name, "source": "workspace (.mcp.json)",
                "transport": (cfg.get("command") or cfg.get("url") or "?"),
                "consent": ("allowed durably"
                            if name in allowed else "first-use approval card"),
            })

        # project-scope settings allow-rules are inert until the workspace
        # is trusted via interactive claude — say so, or users will be
        # confused why their .claude/settings.json does nothing
        trusted = False
        try:
            cj = json.loads((Path.home() / ".claude.json").read_text())
            trusted = bool(cj.get("projects", {})
                           .get(str(manager.workspace),
                                {}).get("hasTrustDialogAccepted"))
        except (OSError, json.JSONDecodeError, ValueError):
            pass

        return {
            "skills": skills,
            "mcp_servers": servers,
            "mcp_error": mcp_err,
            "setting_sources": manager.config.chat_setting_sources,
            "workspace_trusted": trusted,
            "notes": [
                "built-in tools: workspace-scoped reads only; Bash/Write/"
                "subagents are denied by the gate",
                "OAuth-authenticated MCP servers cannot complete their "
                "login flow headless — use stdio servers or token-in-env",
            ],
        }

    @router.get("/conversations/{cid}/stream")
    async def stream(cid: str, request: Request, after: int = -1):
        meta = manager.store.get(cid)
        if meta is None:
            return JSONResponse({"error": {"code": "unknown_conversation"}}, 404)

        async def sse() -> AsyncIterator[str]:
            q: asyncio.Queue = asyncio.Queue(maxsize=2000)
            manager.queues.setdefault(cid, set()).add(q)
            try:
                last = after
                for idx, ev in manager.store.events(cid, after=after):
                    yield f"data: {json.dumps({'i': idx, **ev}, default=str)}\n\n"
                    last = idx
                while True:
                    try:
                        idx, ev = await asyncio.wait_for(q.get(), timeout=15.0)
                    except asyncio.TimeoutError:
                        yield 'data: {"type": "_heartbeat"}\n\n'
                        if await request.is_disconnected():
                            return
                        continue
                    if idx <= last:
                        continue
                    last = idx
                    yield f"data: {json.dumps({'i': idx, **ev}, default=str)}\n\n"
            finally:
                manager.queues.get(cid, set()).discard(q)

        return StreamingResponse(sse(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache"})

    return router
