"""Two actors, one Weft (peer principle, audit half).

Our server constructs `Weft(default_actor="user")` — every audited action
through the instance says "user". The agent shares the instance (the
single-writer invariant forbids a second `Weft`), so its calls need a
different actor WITHOUT a process-global flip.

weft's seam: tools call `store.audit_log(None, …)` and the store falls
back to `store.audit_actor`. We wrap `audit_log` so a None actor resolves
through a contextvar first. anyio propagates contextvars into worker
threads, so a tool call made inside `agent_actor()` audits as "agent"
even mid-flight alongside concurrent "user" calls — no locks, no races.

(Noted upstream as the pattern to bless; if weft grows a native
contextvar actor, this wrapper deletes.)
"""

from __future__ import annotations

import contextvars
from contextlib import contextmanager
from typing import Any, Iterator

CURRENT_ACTOR: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "weft_ui_actor", default=None)


def install(store: Any) -> None:
    orig = store.audit_log

    def audit_log(actor: str | None, action: str, **kw: Any) -> None:
        orig(actor or CURRENT_ACTOR.get(), action, **kw)

    store.audit_log = audit_log


@contextmanager
def agent_actor() -> Iterator[None]:
    token = CURRENT_ACTOR.set("agent")
    try:
        yield
    finally:
        CURRENT_ACTOR.reset(token)
