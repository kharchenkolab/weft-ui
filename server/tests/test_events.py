"""Event spine against a fake store: replay, seam dedup, resync, slow client."""

import asyncio
import threading

import pytest

from weft_ui.events import QUEUE_SIZE, REPLAY_BUDGET, EventBridge


class FakeStore:
    """In-memory stand-in with weft Store's bus semantics: synchronous
    subscriber calls (possibly from foreign threads), monotonic seq."""

    def __init__(self):
        self.events: list[dict] = []
        self.subs = []

    def subscribe(self, fn):
        self.subs.append(fn)

    def emit(self, kind, job_id=None, **payload):
        seq = len(self.events) + 1
        ev = {"seq": seq, "kind": kind, "job_id": job_id, **payload}
        self.events.append({**ev, "ts": 1.0})
        for fn in self.subs:
            fn(ev)
        return seq

    def events_since(self, cursor, limit=200):
        return [e for e in self.events if e["seq"] > cursor][:limit]


async def collect(stream, n, timeout=5.0):
    out = []
    async with asyncio.timeout(timeout):
        async for ev in stream:
            if ev["kind"] == "_heartbeat":
                continue
            out.append(ev)
            if len(out) >= n:
                break
    return out


@pytest.mark.anyio
async def test_replay_pages_then_live():
    store = FakeStore()
    for i in range(450):  # > 2 replay pages
        store.emit("job.state", job_id=f"job-{i}", state="DONE")
    bridge = EventBridge(store)
    bridge.start(asyncio.get_running_loop())
    stream = bridge.stream(cursor=0)
    got = await collect(stream, 450)
    assert [e["seq"] for e in got] == list(range(1, 451))
    # now a live event, emitted from a foreign thread like weft's pollers do
    t = threading.Thread(target=store.emit, args=("job.state",),
                         kwargs={"job_id": "job-live", "state": "RUNNING"})
    t.start()
    t.join()
    (live,) = await collect(stream, 1)
    assert live["job_id"] == "job-live"
    assert "ts" in live  # bridge stamps arrival time on live emits


@pytest.mark.anyio
async def test_seam_dedup_no_gap_no_dupe():
    store = FakeStore()
    for i in range(10):
        store.emit("a")
    bridge = EventBridge(store)
    bridge.start(asyncio.get_running_loop())

    # emit *during* replay: subscribe-first means it lands in the live queue
    # and must be deduped/ordered against the replayed pages
    stream = bridge.stream(cursor=3)
    first = await collect(stream, 1)
    store.emit("b")
    rest = await collect(stream, 7)
    seqs = [e["seq"] for e in first + rest]
    assert seqs == list(range(4, 12))
    assert len(set(seqs)) == len(seqs)


@pytest.mark.anyio
async def test_stale_cursor_resyncs():
    store = FakeStore()
    for i in range(REPLAY_BUDGET + 100):
        store.emit("x")
    bridge = EventBridge(store)
    bridge.start(asyncio.get_running_loop())
    stream = bridge.stream(cursor=1)  # gap > budget
    (ctrl,) = await collect(stream, 1)
    assert ctrl["kind"] == "_resync"
    assert ctrl["seq"] == REPLAY_BUDGET + 100
    store.emit("after")  # live continues from current seq
    (live,) = await collect(stream, 1)
    assert live["kind"] == "after"


@pytest.mark.anyio
async def test_future_cursor_from_wiped_store_resyncs():
    # a persisted cursor can outlive a wiped-and-recreated workspace store;
    # without the guard, seam-dedup silently drops every live event
    store = FakeStore()
    for i in range(10):
        store.emit("x")
    bridge = EventBridge(store)
    bridge.start(asyncio.get_running_loop())
    stream = bridge.stream(cursor=999)
    (ctrl,) = await collect(stream, 1)
    assert ctrl["kind"] == "_resync"
    assert "ahead of the stream" in ctrl["reason"]
    store.emit("after")  # seq 11 << 999: must still be delivered
    (live,) = await collect(stream, 1)
    assert live["kind"] == "after"


@pytest.mark.anyio
async def test_fresh_client_cursor_zero_replays_everything():
    store = FakeStore()
    for i in range(REPLAY_BUDGET + 100):
        store.emit("x")
    bridge = EventBridge(store)
    bridge.start(asyncio.get_running_loop())
    # cursor=0 = "first visit", replays in full even past the budget
    got = await collect(bridge.stream(cursor=0), REPLAY_BUDGET + 100)
    assert got[0]["seq"] == 1


@pytest.mark.anyio
async def test_slow_client_dropped_with_resync():
    store = FakeStore()
    bridge = EventBridge(store)
    bridge.start(asyncio.get_running_loop())
    stream = bridge.stream(cursor=0)
    task = asyncio.ensure_future(anext(stream))  # attach the queue
    await asyncio.sleep(0)
    for i in range(QUEUE_SIZE + 10):  # overflow without a reader
        store.emit("flood")
    first = await task
    assert first["kind"] == "flood"
    tail = [ev async for ev in stream]
    assert tail[-1]["kind"] == "_resync"
    assert "behind" in tail[-1]["reason"]
    assert bridge.clients == set()  # stream closed and detached
