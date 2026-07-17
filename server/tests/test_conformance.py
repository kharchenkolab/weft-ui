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
    desc = weft.sites_describe("wkst")
    cands = (desc.get("capabilities", {}).get("storage") or {}).get("candidates") or []
    assert cands and all((c.get("total_gb") or 0) > 0 for c in cands), \
        "storage candidates should carry total_gb (shim v4, weft >=5ff9f36)"
    check("sites_describe", desc)

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
    # list_envs is checked in test_conformance_envs, which owns a POPULATED
    # sample — here the workspace has no envs yet and the paths would vanish
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
    k = weft.kernel_start("wkst", label="basel sum exploration")
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
    assert st.get("label") == "basel sum exploration", \
        "kernel label (weft >=5ff9f36) missing from kernel_status"
    check("kernel_status", st)
    t = weft.kernel_transcript(kid)
    assert [e["rc"] for e in t] == [0, 1]
    check("kernel_transcript", t)
    rows = weft.list_kernels()
    assert any(r.get("label") == "basel sum exploration"
               for r in rows["kernels"]), \
        "kernel label missing from list_kernels rows"
    check("list_kernels", rows)

    # restart replays only the successful block into a NEW kernel,
    # which INHERITS the label (it names the work, not the process)
    r = weft.kernel_restart(kid, replay="successful")
    assert "error" not in r, r
    assert r["previous"] == kid and r["replayed_blocks"] == 1
    check("kernel_restart", r)
    kid2 = r["kernel_id"]
    assert weft.kernel_status(kid2).get("label") == "basel sum exploration", \
        "restarted kernel should inherit the label"

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


def test_conformance_envs(weft):
    """Env surface (M5): the one test here that needs network — a tiny
    conda+pypi solve. The envs tab renders exactly these payloads."""
    ens = weft.env_ensure({"name": "conformance-env",
                           "deps": {"conda": ["python=3.12"], "pypi": ["tqdm"]}})
    assert "env_id" in ens, ens
    eid = ens["env_id"]
    check("env_ensure", ens)
    listed = weft.list_envs()
    assert any(e["env_id"] == eid and e["name"] == "conformance-env"
               for e in listed["envs"]), "list_envs should carry the solved env"
    check("list_envs", listed)

    sub = weft.task_submit({"command": "python3 -c 'import tqdm'",
                            "site": "wkst", "env": eid,
                            "label": "env realization check"})
    done = _wait(weft, sub["job_id"], timeout=600)
    assert done["state"] == "DONE", done.get("error")

    st = weft.env_status(eid)
    assert st["summary"]["name"] == "conformance-env"
    assert st["summary"].get("reproducibility"), "grade missing from env summary"
    real = next(r for r in st["realizations"] if r["site"] == "wkst")
    for k in ("state", "bytes", "read_only", "strategy"):
        assert k in real, f"realization row lost {k!r}"
    assert real["state"] == "ready"
    check("env_status", st)

    # the packages endpoint (uiapi, round-23 stopgap) reads this shape —
    # keep its contract pinned: canonical carries per-platform records
    row = weft.store.get_env(eid)
    plats = (row.get("canonical") or {}).get("platforms") or {}
    layers = (row.get("canonical") or {}).get("layers") or {}
    assert plats or layers, "canonical resolution lost both platforms and layers"
    if plats:
        first = next(iter(plats.values()))
        assert first and "name" in first[0], "package records lost 'name'"

    ev = weft.env_evict(eid, "wkst")
    assert "error" not in ev, ev
    check("env_evict", ev)
    after = [r for r in weft.env_status(eid)["realizations"] if r["site"] == "wkst"]
    assert not after or after[0]["state"] != "ready", \
        "evict left the realization 'ready'"

    # empty catalog is the common first render — keep its shape honest
    check("env_published_empty", weft.env_published("wkst", "/no-such-tree"))


def test_conformance_retention(weft):
    """retention tier (weft >=1077631): inventory -> retain -> forget;
    knowledge survives holdings."""
    sub = weft.task_submit({
        "command": "mkdir -p results && echo kept > results/keep.txt "
                   "&& echo scratch > tmp.dat",
        "outputs": ["results/"], "site": "wkst", "label": "retention probe",
    })
    done = _wait(weft, sub["job_id"])
    assert done["state"] == "DONE", done.get("error")

    inv = weft.run_inventory(sub["job_id"])
    assert inv["total_files"] >= 1 and inv["entries"], inv
    for k in ("path", "bytes"):
        assert k in inv["entries"][0], f"inventory entry lost {k!r}"
    check("run_inventory", inv)

    # retention2: a site with no declared durable storage REFUSES a bare
    # retain — the hints carry the levers the UI renders (ship home /
    # re-register with durable=). The refusal is a contract, sample it.
    refused = weft.run_retain(sub["job_id"], background=False)
    assert refused.get("error") == "retain.no_durable", refused
    assert "options" in (refused.get("hints") or {}), refused
    check("run_retain_no_durable", refused)

    r = weft.run_retain(sub["job_id"], dest="@workspace", background=False)
    assert "error" not in r, r
    check("run_retain", r)
    mine = [x for x in weft.retained_runs() if x["target"] == sub["job_id"]]
    assert mine and mine[0]["files"] >= 1, mine
    for k in ("location", "bytes", "state", "site"):
        assert k in mine[0], f"retained_runs row lost {k!r}"
    check("retained_runs", weft.retained_runs())

    f = weft.run_forget(target=sub["job_id"])
    assert "error" not in f, f
    check("run_forget", f)
    assert not [x for x in weft.retained_runs() if x["target"] == sub["job_id"]], \
        "forget should drop the retained index entry"
    assert weft.run_inventory(sub["job_id"])["total_files"] >= 1, \
        "the inventory (knowledge) must survive run_forget (holdings)"

    # selective retention (the UI's checkbox/glob path) + label grouping
    r2 = weft.run_retain(sub["job_id"], include=["results/*"],
                         label="conformance-campaign", background=False,
                         dest="@workspace", layout="label")
    assert "error" not in r2, r2
    mine2 = [x for x in weft.retained_runs(label="conformance-campaign")
             if x["target"] == sub["job_id"]]
    assert mine2 and mine2[0]["files"] == 1, \
        f"include=['results/*'] should retain exactly the one matching file: {mine2}"
    assert mine2[0].get("label") == "conformance-campaign"
    f2 = weft.run_forget(label="conformance-campaign")
    assert "error" not in f2, f2
    assert not weft.retained_runs(label="conformance-campaign"), \
        "forget-by-label should clear the whole group"


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
