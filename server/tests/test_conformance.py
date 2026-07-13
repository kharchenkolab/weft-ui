"""Conformance harness (plan D9/R6): the churn tripwire.

Runs representative tool calls against a real local Weft, then checks the
payloads still carry every key path the UI depends on — the key structure
recorded in shared/samples/*.json. When upstream reshapes a payload this
fails with a named path, not a runtime surprise in the browser.

Refresh samples after an intentional upstream change:

    UPDATE_SAMPLES=1 pixi run test  # rewrites samples + BASELINE

BASELINE records the weft SHA (and dirty flag) the samples were captured
at; CI prints the BASELINE..HEAD delta so drift is visible before it bites.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import pytest

from weft.api import Weft

SAMPLES = Path(__file__).resolve().parents[2] / "shared" / "samples"
WEFT_REPO = Path(__file__).resolve().parents[3] / "weft"
UPDATE = os.environ.get("UPDATE_SAMPLES") == "1"


def key_paths(obj, prefix="") -> set[str]:
    """Every dict key path in a payload; lists validate against their first item."""
    paths = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{prefix}.{k}" if prefix else k
            paths.add(p)
            paths |= key_paths(v, p)
    elif isinstance(obj, list) and obj:
        paths |= key_paths(obj[0], f"{prefix}[]")
    return paths


def check(name: str, payload) -> None:
    path = SAMPLES / f"{name}.json"
    if UPDATE or not path.exists():
        SAMPLES.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2, default=str) + "\n")
        return
    expected = key_paths(json.loads(path.read_text()))
    missing = expected - key_paths(payload)
    assert not missing, (
        f"weft payload for {name!r} lost key paths the UI renders: "
        f"{sorted(missing)}\n(intentional upstream change? "
        f"rerun with UPDATE_SAMPLES=1 and review the diff)")


@pytest.fixture(scope="module")
def weft(tmp_path_factory):
    ws = tmp_path_factory.mktemp("conformance-ws")
    w = Weft(ws)
    r = w.register_site("wkst", "local", {"root": str(ws / "site")})
    assert "error" not in r, r
    (ws / "data.csv").write_text("a,b\n1,2\n3,4\n")
    return w


def _wait(w: Weft, job_id: str, timeout=90) -> dict:
    return w.runner.wait(job_id, timeout)


def test_conformance_core_payloads(weft):
    check("sites_list", weft.sites_list())
    check("sites_describe", weft.sites_describe("wkst"))

    ref = weft.data_register("data.csv")
    check("data_register", ref)

    submit = weft.task_submit({
        "command": "wc -l < data/data.csv > results/n.txt",
        "inputs": [{"ref": ref["ref"], "mount_as": "data/data.csv"}],
        "outputs": ["results/"], "site": "wkst",
    })
    check("task_submit", submit)
    done = _wait(weft, submit["job_id"])
    assert done["state"] == "DONE", done.get("error")
    status_row = weft.task_status(job_id=submit["job_id"])[0]
    assert "plan" in status_row, "persisted submit plan (weft >=9a30cdb) missing"
    check("task_status_row", status_row)
    check("task_result_manifest", weft.task_result(submit["job_id"]))
    check("jobs_where", weft.jobs_where(limit=10))
    check("list_envs", weft.list_envs())
    check("audit_tail", weft.audit_tail(5))

    failed = weft.task_submit({
        "command": "python3 -c 'raise MemoryError(\"Unable to allocate 13.4 GiB\")'",
        "site": "wkst",
    })
    fjob = _wait(weft, failed["job_id"])
    assert fjob["state"] == "FAILED"
    check("job_error", fjob["error"])

    arr = weft.task_submit({
        "command": "test $WEFT_ARRAY_INDEX -ne 1", "site": "wkst", "array": 3,
    })
    group = arr["group"]
    deadline = time.time() + 90
    while time.time() < deadline:
        els = weft.array_status(group).get("elements", [])
        if els and all(e["state"] in ("DONE", "FAILED", "CANCELLED") for e in els):
            break
        time.sleep(1)
    check("array_status", weft.array_status(group))

    # retried elements: the replaced row names its successor (UI folds on it)
    weft.array_retry(group)
    deadline = time.time() + 90
    while time.time() < deadline:
        els = weft.array_status(group).get("elements", [])
        if els and all(e["state"] in ("DONE", "FAILED", "CANCELLED") for e in els):
            break
        time.sleep(1)
    superseded = [j for j in weft.jobs_where(limit=100)["jobs"] if j.get("superseded_by")]
    assert superseded, "array_retry should mark replaced rows with superseded_by"

    # events are heterogeneous by kind — validate one representative per
    # kind, so a new kind landing first in the stream isn't a false alarm
    by_kind: dict = {}
    for ev in weft.store.events_since(0, limit=200):
        by_kind.setdefault(ev["kind"], ev)
    check("events_by_kind", by_kind)
    check("doctor", weft.doctor())

    if UPDATE or not (SAMPLES / "BASELINE").exists():
        try:
            sha = subprocess.run(["git", "-C", str(WEFT_REPO), "rev-parse", "HEAD"],
                                 capture_output=True, text=True, check=True).stdout.strip()
            dirty = bool(subprocess.run(["git", "-C", str(WEFT_REPO), "status", "--porcelain"],
                                        capture_output=True, text=True).stdout.strip())
            (SAMPLES / "BASELINE").write_text(f"{sha}{' (dirty)' if dirty else ''}\n")
        except (subprocess.CalledProcessError, FileNotFoundError):
            pass
