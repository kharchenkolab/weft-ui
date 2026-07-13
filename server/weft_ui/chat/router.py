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
                self.weft, self.workspace, emit,
                confirm_staging_gb=self.config.confirm_staging_gb)
        return self.sessions[cid]

    def _broadcast(self, cid: str, ev: dict) -> None:
        idx = self.store.append_event(cid, ev)
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


class NewMessage(BaseModel):
    text: str


class ApprovalDecision(BaseModel):
    request_id: str
    decision: str  # "allow" | "deny"
    always_allow_staging_gb: float | None = None


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
        if sess is None or not sess.resolve_approval(body.request_id, body.decision):
            return JSONResponse(
                {"error": {"code": "unknown_approval",
                           "detail": "no pending approval with that id"}}, 404)
        if body.always_allow_staging_gb:
            manager.config.confirm_staging_gb = float(body.always_allow_staging_gb)
            manager.config.save(manager.workspace)
            sess.confirm_staging_gb = manager.config.confirm_staging_gb
        return {"ok": True}

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
