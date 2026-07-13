"""The event spine (plan D2 + R2): store bus -> SSE, replay-first.

weft's `store.emit()` calls subscribers synchronously on the *emitting*
thread (pollers, runners) — the bridge must never block or raise there.
It does exactly one thing: `loop.call_soon_threadsafe` onto the asyncio
side, which fans out to bounded per-client queues.

A client connects with its last-seen cursor:

    GET /api/events?cursor=N

- gap-free path: replay `events_since` in pages, then switch to live
  (dedup by seq across the seam);
- stale-cursor path: if the gap exceeds REPLAY_BUDGET, send a `_resync`
  control event — the client refetches list endpoints and continues live;
- slow-client path: a full queue drops the client with `_resync` too.

The client reducer is written resync-first, so all three are one path.
A ticker task heartbeats every 15 s so proxies don't reap idle streams
(and so dead connections are noticed by the disconnect check).
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

REPLAY_BUDGET = 5_000
REPLAY_PAGE = 200
QUEUE_SIZE = 1_000
HEARTBEAT_S = 15.0


class EventBridge:
    """Fan out the store's synchronous bus to per-client asyncio queues."""

    def __init__(self, store: Any):
        self.store = store
        self.loop: asyncio.AbstractEventLoop | None = None
        self.clients: set[asyncio.Queue] = set()
        self.last_seq: int = 0
        self._ticker: asyncio.Task | None = None

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.last_seq = self._current_seq()
        self._ticker = loop.create_task(self._heartbeats())
        self.store.subscribe(self._on_emit)  # weft has no unsubscribe; bridge lives as long as the store

    def stop(self) -> None:
        if self._ticker is not None:
            self._ticker.cancel()
        self.loop = None  # _on_emit becomes a no-op for late emitting threads

    def _current_seq(self) -> int:
        seq = 0
        while True:  # walk pages once at startup, then track live
            page = self.store.events_since(seq, limit=REPLAY_PAGE)
            if not page:
                return seq
            seq = page[-1]["seq"]

    def _on_emit(self, event: dict) -> None:
        # emitting-thread side: never raise, never block (store contract)
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._fanout, event)
        except RuntimeError:
            pass  # loop shut down mid-call

    def _fanout(self, event: dict) -> None:
        event.setdefault("ts", time.time())  # live emits carry no ts; stamp arrival
        self.last_seq = max(self.last_seq, event.get("seq") or 0)
        for q in list(self.clients):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # slow client: poison its queue; its stream sends `_resync` and
                # closes. _fanout runs on the loop thread, so draining one slot
                # to make room for the poison can't race the consumer.
                self.clients.discard(q)
                try:
                    q.get_nowait()
                    q.put_nowait(None)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    async def _heartbeats(self) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_S)
            self._fanout({"kind": "_heartbeat", "seq": self.last_seq})

    async def stream(self, cursor: int) -> AsyncIterator[dict]:
        """Replay-then-live event dicts; `_`-prefixed kinds are control events."""
        q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_SIZE)
        self.clients.add(q)  # subscribe first: no gap between replay end and live start
        try:
            gap = self.last_seq - cursor
            if cursor and gap > REPLAY_BUDGET:
                yield {"kind": "_resync", "seq": self.last_seq,
                       "reason": f"cursor {cursor} is {gap} events behind (budget {REPLAY_BUDGET})"}
                cursor = self.last_seq
            else:
                while True:
                    page = await asyncio.to_thread(
                        self.store.events_since, cursor, REPLAY_PAGE)
                    if not page:
                        break
                    for ev in page:
                        yield ev
                    cursor = page[-1]["seq"]
            while True:
                ev = await q.get()
                if ev is None:  # dropped as a slow client
                    yield {"kind": "_resync", "seq": self.last_seq,
                           "reason": "client fell behind the live stream"}
                    return
                if ev["kind"].startswith("_"):
                    yield ev
                    continue
                if ev["seq"] <= cursor:
                    continue  # replay/live seam dedup
                cursor = ev["seq"]
                yield ev
        finally:
            self.clients.discard(q)


def build_router(bridge: EventBridge) -> APIRouter:
    router = APIRouter()

    @router.get("/api/events")
    async def events(request: Request, cursor: int = 0):
        async def sse() -> AsyncIterator[str]:
            async for ev in bridge.stream(cursor):
                if await request.is_disconnected():
                    return
                yield f"data: {json.dumps(ev, default=str)}\n\n"

        return StreamingResponse(sse(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache",
                                          "X-Accel-Buffering": "no"})

    return router
