"""Seed kernels + a service for the M4 tabs (physics story, fixtures only).

Drives the *running* weft-ui server over its HTTP facade, like
seed_dft_survey.py — the seed is "the agent", same wire path, same audit
trail. Expects the fixture sites registered (register_site via wizard or
facade): `minihpc` (slurm container) and `minipc` (sshd container).

    pixi run fixtures up   # containers
    pixi run serve         # terminal 1
    python demo/seed_kernel_service.py   # terminal 2

Story:
  1. phonon exploration kernel on minihpc (standard partition, 45 min):
     block 0  Bose–Einstein occupations at 300 K   → OK, saves artifact
     block 1  free energy with a typo (NameError)  → rc=1, honest red
     block 2  the fix                              → OK, saves artifact
     ... left RUNNING: promote blocks [0, 2] from the browser.
  2. a doomed kernel on the `short` partition (60 s walltime): slurm
     kills it → kernel.died → the death card renders live.
  3. DOS mini-dashboard service on minipc: writes an HTML table of the
     gamma modes, serves it on $WEFT_PORT → tunneled URL in the UI.
"""

from __future__ import annotations

import argparse
import os
import sys
import textwrap

import httpx

BLOCK_OCC = textwrap.dedent("""\
    import json, math, os
    freqs_thz = [3.21, 4.87, 5.02, 8.90, 9.14, 12.33]  # gamma modes, run 2024B
    kT_thz = 6.25  # 300 K in THz units (k_B T / h)
    occ = [1.0 / (math.exp(f / kT_thz) - 1.0) for f in freqs_thz]
    for f, n in zip(freqs_thz, occ):
        print(f"  {f:6.2f} THz  n(300K) = {n:.4f}")
    with open(os.environ["WEFT_BLOCK_DIR"] + "/occupations.json", "w") as fh:
        json.dump(dict(zip(map(str, freqs_thz), occ)), fh)
    print("occupations saved")
""")

BLOCK_TYPO = textwrap.dedent("""\
    import math
    # free energy per mode: k_B T ln(2 sinh(hf / 2kT))
    F = sum(kT * math.log(2 * math.sinh(f / (2 * 6.25))) for f in freqs_thz)
    print(F)
""")

BLOCK_FIX = textwrap.dedent("""\
    import json, math, os
    freqs_thz = [3.21, 4.87, 5.02, 8.90, 9.14, 12.33]
    kT = 6.25
    F = sum(kT * math.log(2 * math.sinh(f / (2 * kT))) for f in freqs_thz)
    print(f"vibrational free energy (300 K): {F:.4f} THz·k_B ≈ {F * 0.02585 / 6.25:.4f} eV")
    with open(os.environ["WEFT_BLOCK_DIR"] + "/free_energy.txt", "w") as fh:
        fh.write(str(F))
""")

BLOCK_SPIN = textwrap.dedent("""\
    import time
    print("re-diagonalizing with acoustic sum rule enforced…", flush=True)
    time.sleep(45)
    print("done")
""")

DASHBOARD_SH = (
    "mkdir -p www && printf '%s' "
    "'<!doctype html><title>gamma modes — run 2024B</title>"
    "<h2>Phonon gamma modes (THz)</h2>"
    "<table border=1 cellpadding=6><tr><th>mode</th><th>freq</th></tr>"
    "<tr><td>TA1</td><td>3.21</td></tr><tr><td>TA2</td><td>4.87</td></tr>"
    "<tr><td>LA</td><td>5.02</td></tr><tr><td>TO1</td><td>8.90</td></tr>"
    "<tr><td>TO2</td><td>9.14</td></tr><tr><td>LO</td><td>12.33</td></tr>"
    "</table>' > www/index.html && "
    'cd www && exec python3 -m http.server "$WEFT_PORT" --bind 127.0.0.1'
)


class UI:
    def __init__(self, url: str, token: str):
        self.http = httpx.Client(base_url=url,
                                 headers={"authorization": f"Bearer {token}"},
                                 timeout=180)

    def w(self, tool: str, **kwargs):
        r = self.http.post(f"/api/w/{tool}", json=kwargs)
        r.raise_for_status()
        return r.json()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("WEFT_UI_URL", "http://127.0.0.1:8999"))
    ap.add_argument("--token", default=os.environ.get("WEFT_UI_TOKEN", "demo"))
    args = ap.parse_args()
    ui = UI(args.url, args.token)

    sites = {s["name"] for s in ui.w("sites_list")}
    for need in ("minihpc", "minipc"):
        if need not in sites:
            sys.exit(f"site {need!r} not registered — run the fixture "
                     f"registration first (wizard or register_site)")

    print("1. phonon exploration kernel on minihpc (standard, 45 min hold)")
    k = ui.w("kernel_start", site="minihpc", walltime="0:45:00",
             resources={"partition": "standard"})
    if "error" in k:
        sys.exit(f"kernel_start: {k}")
    kid = k["kernel_id"]
    print(f"   {kid}")
    for label, code, want_rc in [("occupations", BLOCK_OCC, 0),
                                 ("free energy (typo)", BLOCK_TYPO, 1),
                                 ("free energy (fixed)", BLOCK_FIX, 0)]:
        r = ui.w("kernel_exec", kernel_id=kid, code=code, wait=True, timeout=90)
        rc = r.get("rc")
        print(f"   block {r.get('block')} [{label}] rc={rc}")
        if rc != want_rc:
            sys.exit(f"   unexpected rc for {label}: {r}")
    # a slow block left running so interrupt/composer have a live target
    ui.w("kernel_exec", kernel_id=kid, code=BLOCK_SPIN, wait=False)
    print("   block 3 [asr re-diagonalization] left running (~45 s)")

    print("2. doomed kernel on the short partition (60 s walltime)")
    doomed = ui.w("kernel_start", site="minihpc", walltime="1:00",
                  resources={"partition": "short"})
    if "error" in doomed:
        print(f"   skipped: {doomed.get('error')} — {doomed.get('detail')}")
    else:
        print(f"   {doomed['kernel_id']} — slurm will kill it; watch the death card")

    print("3. DOS dashboard service on minipc")
    svc = ui.w("service_start", site="minipc",
               task={"command": DASHBOARD_SH, "label": "gamma-mode dashboard",
                     "outputs": ["www/"]},  # so Stop+collect has something to harvest
               ports=[8811], ready_timeout=60)
    if "error" in svc:
        sys.exit(f"service_start: {svc}")
    print(f"   {svc['service_id']} ready — {svc['endpoints'][0]['url']}")

    print("\nopen the Jobs panel → Kernels / Services tabs; promote blocks "
          "[0, 2] of the exploration kernel from the browser")


if __name__ == "__main__":
    main()
