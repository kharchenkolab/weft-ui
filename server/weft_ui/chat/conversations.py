"""Conversations (never "sessions" — that word is weft's, plan R3):
metadata + typed-event transcripts, persisted per workspace under
`.weft-ui/conversations/`. One jsonl per conversation: every event the
panel ever rendered, replayable — a UI restart shows the same transcript.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterator


@dataclass
class ConversationMeta:
    id: str
    title: str
    created_at: float
    model: str = "default"
    sdk_session_id: str | None = None
    state: str = "idle"  # idle | running | waiting_approval
    cost_usd: float = 0.0
    budget_usd: float = 5.0
    turns: int = 0


class ConversationStore:
    def __init__(self, workspace: Path):
        self.dir = workspace / ".weft-ui" / "conversations"
        self.dir.mkdir(parents=True, exist_ok=True)

    def _meta_path(self, cid: str) -> Path:
        return self.dir / f"{cid}.meta.json"

    def _log_path(self, cid: str) -> Path:
        return self.dir / f"{cid}.events.jsonl"

    def create(self, title: str, model: str, budget_usd: float) -> ConversationMeta:
        meta = ConversationMeta(id="c_" + uuid.uuid4().hex[:8], title=title,
                                created_at=time.time(), model=model,
                                budget_usd=budget_usd)
        self.save_meta(meta)
        return meta

    def save_meta(self, meta: ConversationMeta) -> None:
        p = self._meta_path(meta.id)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(meta), indent=1))
        tmp.replace(p)

    def get(self, cid: str) -> ConversationMeta | None:
        p = self._meta_path(cid)
        if not p.exists():
            return None
        return ConversationMeta(**json.loads(p.read_text()))

    def list(self) -> list[ConversationMeta]:
        metas = []
        for p in self.dir.glob("*.meta.json"):
            try:
                metas.append(ConversationMeta(**json.loads(p.read_text())))
            except (json.JSONDecodeError, TypeError):
                continue
        return sorted(metas, key=lambda m: -m.created_at)

    def append_event(self, cid: str, event: dict) -> int:
        """Append one typed event; returns its index in the transcript."""
        path = self._log_path(cid)
        with path.open("a") as f:
            f.write(json.dumps(event, default=str) + "\n")
        # index = line count - 1; cheap enough at conversation scale
        with path.open() as f:
            return sum(1 for _ in f) - 1

    def events(self, cid: str, after: int = -1) -> Iterator[tuple[int, dict]]:
        path = self._log_path(cid)
        if not path.exists():
            return
        with path.open() as f:
            for i, line in enumerate(f):
                if i <= after:
                    continue
                try:
                    yield i, json.loads(line)
                except json.JSONDecodeError:
                    continue
