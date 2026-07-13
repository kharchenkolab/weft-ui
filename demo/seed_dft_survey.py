"""Seed the demo workspace with the DFT-survey story the mockups tell.

Drives the *running* weft-ui server over its HTTP facade — the seed script
is "the agent": same wire path, same audit trail, and a browser left open
watches every state change arrive over SSE. (A second in-process Weft
would violate the one-controller-per-workspace invariant.)

    pixi run serve      # terminal 1 (uses --token demo via `pixi run seed` docs)
    pixi run seed       # terminal 2

Story (mirrors mockups/01 + 05, physics only):
  1. wkst        local site registered
  2. reduce      DONE — beamline reduction with previews (inline json + csv head)
  3. pilot       FAILED — mode_select.py OOMs (python traceback, hints)
  4. qc array    24 elements, 3 OOM on cue — failure buckets + live progress
  5. reduce#2    memoized resubmit (zero-cost repeat)
  6. stream      RUNNING ~20 min — live log follow at 1 s
"""

from __future__ import annotations

import argparse
import os
import sys
import textwrap
import time
from pathlib import Path

import httpx

QC_PY = textwrap.dedent("""\
    import json, os, sys, time
    idx = int(os.environ.get("WEFT_ARRAY_INDEX", "0"))
    time.sleep(1 + idx % 7)  # stagger so the digest moves while you watch
    if idx in (3, 11, 17):   # the OOM cohort: large supercells
        print(f"qc: struct {idx}: building dynamical matrix (48000x48000)", flush=True)
        raise MemoryError(f"Unable to allocate 13.4 GiB for an array with shape "
                          f"(48000, 48000) and data type float64")
    freqs = [round(3.2 + idx * 0.01 + m * 1.7, 3) for m in range(6)]
    os.makedirs("results", exist_ok=True)
    with open(f"results/modes_{idx:03d}.json", "w") as f:
        json.dump({"struct": idx, "gamma_modes_thz": freqs, "converged": True}, f)
    print(f"qc: struct {idx}: 6 modes, all real — OK", flush=True)
""")

MODE_SELECT_PY = textwrap.dedent("""\
    import sys, time
    print("mode_select: loading spectral/ run 2024B (gamma-only pilot)", flush=True)
    time.sleep(2)
    print("mode_select: building dynamical matrix for 4x4x4 supercell", flush=True)
    time.sleep(1)
    raise MemoryError("Unable to allocate 11.4 GiB for an array with shape "
                      "(38000, 38000) and data type float64")
""")

REDUCE_PY = textwrap.dedent("""\
    import csv, json, os, sys
    rows = list(csv.DictReader(open("data/raw_runs.csv")))
    os.makedirs("results", exist_ok=True)
    with open("results/phonon_summary.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["run", "n_scans", "peak_thz"])
        for r in rows:
            w.writerow([r["run"], r["scans"], round(float(r["scans"]) * 0.037 + 3.1, 3)])
    json.dump({"runs": len(rows), "detector": "pilatus-2m",
               "peak_thz": 4.87, "resolution_mev": 0.31},
              open("results/reduction.json", "w"))
    print(f"reduce: {len(rows)} runs reduced", flush=True)
""")

STREAM_WATCH_PY = textwrap.dedent("""\
    import time
    for scan in range(1, 601):
        print(f"scan {scan:03d}: acquiring 2.0 s | integrating | "
              f"peak intensity {5200 + (scan * 37) % 900} cts", flush=True)
        time.sleep(2)
""")

RAW_RUNS = "run,scans\n" + "\n".join(f"2024B-{n:04d},{40 + (n * 13) % 25}"
                                     for n in range(1, 49)) + "\n"


class UI:
    def __init__(self, url: str, token: str):
        self.http = httpx.Client(base_url=url,
                                 headers={"authorization": f"Bearer {token}"},
                                 timeout=120)

    def w(self, tool: str, **kwargs):
        r = self.http.post(f"/api/w/{tool}", json=kwargs)
        r.raise_for_status()
        return r.json()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", default="demo/workspace")
    ap.add_argument("--url", default=os.environ.get("WEFT_UI_URL", "http://127.0.0.1:8999"))
    ap.add_argument("--token", default=os.environ.get("WEFT_UI_TOKEN", "demo"))
    args = ap.parse_args()

    ws = Path(args.workspace).resolve()
    ui = UI(args.url, args.token)
    ping = ui.http.get("/api/ping").json()
    if Path(ping["workspace"]) != ws:
        sys.exit(f"server is serving {ping['workspace']}, not {ws} — wrong --workspace?")

    # workspace files the tasks mount
    for name, body in [("code/qc.py", QC_PY), ("code/mode_select.py", MODE_SELECT_PY),
                       ("code/reduce.py", REDUCE_PY), ("code/stream_watch.py", STREAM_WATCH_PY),
                       ("data/raw_runs.csv", RAW_RUNS)]:
        p = ws / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)

    sites = {s["name"] for s in ui.w("sites_list")}
    if "wkst" not in sites:
        site_root = ws.parent / "site"
        r = ui.w("register_site", name="wkst", kind="local",
                 config={"root": str(site_root)}, _confirm=True)
        print("registered site:", r.get("name", r))

    refs = {}
    for rel in ["code/qc.py", "code/mode_select.py", "code/reduce.py",
                "code/stream_watch.py", "data/raw_runs.csv"]:
        refs[rel] = ui.w("data_register", path=rel)["ref"]

    def submit(label: str, task: dict, **kw):
        r = ui.w("task_submit", task=task, **kw)
        handle = r.get("job_id") or (f"group {r['group']}" if "group" in r else None)
        memo = " (memoized)" if r.get("memoized") else ""
        print(f"{label}: {handle}{memo}" if handle else f"{label}: {r}")
        return r

    reduce_task = {
        "command": "python3 code/reduce.py",
        "label": "reduce 2024B beamline runs",
        "code": {"ref": refs["code/reduce.py"], "mount_as": "code/reduce.py"},
        "inputs": [{"ref": refs["data/raw_runs.csv"], "mount_as": "data/raw_runs.csv"}],
        "outputs": ["results/"], "site": "wkst",
    }
    r = submit("reduce", reduce_task)
    reduce_id = r["job_id"]

    submit("pilot (will OOM)", {
        "command": "python3 code/mode_select.py",
        "label": "mode_select pilot (gamma-only)",
        "code": {"ref": refs["code/mode_select.py"], "mount_as": "code/mode_select.py"},
        "outputs": ["results/"], "site": "wkst",
    })

    submit("qc array x24", {
        "command": "python3 code/qc.py",
        "label": "phonon QC sweep",
        "code": {"ref": refs["code/qc.py"], "mount_as": "code/qc.py"},
        "outputs": ["results/"], "site": "wkst", "array": 24,
        "resources": {"cpus": 1, "mem_gb": 8},
    })

    # wait for reduce to finish so the resubmit memoizes
    for _ in range(60):
        jobs = ui.w("task_status", job_id=reduce_id)
        if jobs and jobs[0]["state"] in ("DONE", "FAILED"):
            break
        time.sleep(1)
    submit("reduce again", reduce_task)

    submit("stream watch (runs ~20 min)", {
        "command": "python3 code/stream_watch.py",
        "label": "detector stream watch",
        "code": {"ref": refs["code/stream_watch.py"], "mount_as": "code/stream_watch.py"},
        "site": "wkst",
        "resources": {"walltime": "00:25:00"},
    })

    print("\nseeded — open the UI and watch the qc array digest move.")


if __name__ == "__main__":
    main()
