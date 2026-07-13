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
        "label": "count rows",
        "inputs": [{"ref": ref["ref"], "mount_as": "data/data.csv"}],
        "outputs": ["results/"], "site": "wkst",
    })
    check("task_submit", submit)
    done = _wait(weft, submit["job_id"])
    assert done["state"] == "DONE", done.get("error")
    status_row = weft.task_status(job_id=submit["job_id"])[0]
    assert "plan" in status_row, "persisted submit plan (weft >=9a30cdb) missing"
    assert status_row.get("label") == "count rows", \
        "label (weft >=116a0bf) missing from task_status"
    row = next(j for j in weft.jobs_where(limit=100)["jobs"]
               if j["job_id"] == submit["job_id"])
    assert row.get("label") == "count rows", "label missing from jobs_where row"
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

def test_conformance_kernels(weft):
    """kernel lifecycle payloads (M4): start → exec ok/fail → status →
    transcript → restart-with-replay → promote → stop."""
    k = weft.kernel_start("wkst")
    assert "error" not in k, k
    check("kernel_start", k)
    kid = k["kernel_id"]

    ok = weft.kernel_exec(kid, (
        "import os\n"
        "E = sum(1.0 / n**2 for n in range(1, 200))\n"
        "print(f'partial Basel sum {E:.6f}')\n"
        "open(os.environ['WEFT_BLOCK_DIR'] + '/sum.txt', 'w').write(str(E))\n"
    ), wait=True, timeout=60)
    assert ok.get("rc") == 0, ok
    check("kernel_exec", ok)

    bad = weft.kernel_exec(kid, "1/0\n", wait=True, timeout=60)
    assert bad.get("rc") not in (0, None)

    st = weft.kernel_status(kid)
    assert st["state"] == "running" and st["blocks_run"] == 2
    check("kernel_status", st)
    t = weft.kernel_transcript(kid)
    assert [e["rc"] for e in t] == [0, 1]
    check("kernel_transcript", t)
    check("list_kernels", weft.list_kernels())

    # restart replays only the successful block into a NEW kernel
    r = weft.kernel_restart(kid, replay="successful")
    assert "error" not in r, r
    assert r["previous"] == kid and r["replayed_blocks"] == 1
    check("kernel_restart", r)
    kid2 = r["kernel_id"]

    m = weft.kernel_promote(kid2, blocks=[0])
    assert "error" not in m, m
    assert m["reproducibility"] == "state-dependent", m
    check("kernel_promote", m)
    minted = next((j for j in weft.jobs_where(limit=200)["jobs"]
                   if j["job_id"] == m["job_id"]), None)
    assert minted and minted["state"] == "DONE", \
        "promotion should mint a DONE job row"

    weft.kernel_stop(kid2)
    assert weft.kernel_status(kid2)["state"] == "stopped"


def test_conformance_services(weft):
    """service lifecycle payloads (M4): start → endpoints → status → stop."""
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    svc = weft.service_start(
        "wkst",
        {"command": 'exec python3 -m http.server "$WEFT_PORT" --bind 127.0.0.1'},
        ports=[port], ready_timeout=45)
    assert "error" not in svc, svc
    assert svc["state"] == "ready" and svc["endpoints"], svc
    check("service_start", svc)

    st = weft.service_status(svc["service_id"])
    assert st["state"] == "ready" and st.get("endpoints")
    check("service_status", st)
    check("list_services", weft.list_services())

    out = weft.service_stop(svc["service_id"])
    assert out["state"] == "stopped"
    check("service_stop", out)


def test_conformance_provenance(weft):
    """provenance chain (M4): a job consuming another job's output recurses
    into the producing job — the shape the provenance view walks."""
    first = weft.task_submit({
        "command": "echo 0.618 > results/gap.txt", "label": "band gap",
        "outputs": ["results/"], "site": "wkst",
    })
    assert _wait(weft, first["job_id"])["state"] == "DONE"
    ref = weft.task_result(first["job_id"])["outputs"][0]["ref"]

    second = weft.task_submit({
        "command": "cat inputs/gap.txt > results/report.txt",
        "label": "gap report",
        "inputs": [{"ref": ref, "mount_as": "inputs/gap.txt"}],
        "outputs": ["results/"], "site": "wkst",
    })
    assert _wait(weft, second["job_id"])["state"] == "DONE"

    prov = weft.provenance(second["job_id"], depth=5)
    assert "error" not in prov, prov
    assert prov["schema"] == "provenance:v1"
    lineage = prov["inputs"][0].get("produced_by")
    assert lineage and lineage["job_id"] == first["job_id"], \
        "input lineage should recurse into the producing job"
    check("provenance", prov)


def test_baseline_recorded(weft):
    if UPDATE or not (SAMPLES / "BASELINE").exists():
        try:
            sha = subprocess.run(["git", "-C", str(WEFT_REPO), "rev-parse", "HEAD"],
                                 capture_output=True, text=True, check=True).stdout.strip()
            dirty = bool(subprocess.run(["git", "-C", str(WEFT_REPO), "status", "--porcelain"],
                                        capture_output=True, text=True).stdout.strip())
            (SAMPLES / "BASELINE").write_text(f"{sha}{' (dirty)' if dirty else ''}\n")
        except (subprocess.CalledProcessError, FileNotFoundError):
            pass
