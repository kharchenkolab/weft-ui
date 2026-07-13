"""Workspace-level UI config: `<workspace>/.weft-ui.json`.

Holds consent-gate thresholds and chat defaults. Loaded once at startup,
saved atomically on change ("always allow under X" writes here later).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

CONFIG_NAME = ".weft-ui.json"


@dataclass
class UIConfig:
    # consent-gate thresholds (gate.py reads these; M2 wires the editor)
    confirm_staging_gb: float = 5.0
    confirm_walltime_hours: float = 12.0
    confirm_spend_usd: float = 1.0
    # chat defaults (M3)
    chat_model: str = "default"
    chat_budget_usd: float = 5.0
    extra: dict = field(default_factory=dict)

    @classmethod
    def load(cls, workspace: Path) -> "UIConfig":
        path = workspace / CONFIG_NAME
        if not path.exists():
            return cls()
        try:
            data = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            return cls()
        known = {f for f in cls.__dataclass_fields__ if f != "extra"}
        kwargs = {k: v for k, v in data.items() if k in known}
        extra = {k: v for k, v in data.items() if k not in known}
        return cls(**kwargs, extra=extra)

    def save(self, workspace: Path) -> None:
        path = workspace / CONFIG_NAME
        tmp = path.with_suffix(".json.tmp")
        data = asdict(self)
        data.update(data.pop("extra"))
        tmp.write_text(json.dumps(data, indent=2) + "\n")
        tmp.replace(path)
