"""Boot weft's own docker fixtures as demo compute sites.

Reuses the images weft's test suite builds (sshd = a remote workstation,
slurm = a single-node cluster), so the wizard demo registers *real* sites
over real ssh. Blast radius: two containers named weft-ui-demo-*, a
session keypair under demo/.keys, state file demo/fixtures.json.

    pixi run fixtures up      # build (cached) + start + wait ready
    pixi run fixtures status
    pixi run fixtures down
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEFT = HERE.parents[1] / "weft"
KEYDIR = HERE / ".keys"
STATE = HERE / "fixtures.json"

FIXTURES = {
    "sshd": {"container": "weft-ui-demo-sshd", "image": "weft-test-sshd",
             "extra": [], "ready": "echo ready", "ready_ok": "ready"},
    "slurm": {"container": "weft-ui-demo-slurm", "image": "weft-test-slurm",
              "extra": ["--hostname", "weftslurm"],
              "ready": "sinfo -h -o %a 2>/dev/null | head -1", "ready_ok": "up"},
}


def _sh(*argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True)


def ssh_opts() -> list[str]:
    return ["-i", str(KEYDIR / "id_ed25519"),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "IdentitiesOnly=yes"]


def up() -> None:
    state = {}
    for kind, fx in FIXTURES.items():
        build = _sh("sh", str(WEFT / f"tests/fixtures/{kind}/build.sh"), str(KEYDIR))
        if build.returncode != 0:
            sys.exit(f"cannot build {kind} image: {build.stderr[-400:]}")
        _sh("docker", "rm", "-f", fx["container"])
        run = _sh("docker", "run", "-d", "--rm", "--name", fx["container"],
                  *fx["extra"], "-p", "127.0.0.1::22", fx["image"])
        if run.returncode != 0:
            sys.exit(f"cannot start {kind}: {run.stderr[-400:]}")
        port = _sh("docker", "port", fx["container"], "22").stdout.strip().rsplit(":", 1)[-1]
        deadline = time.time() + 90
        while time.time() < deadline:
            ok = _sh("ssh", *ssh_opts(), "-o", "BatchMode=yes", "-p", port,
                     "physicist@127.0.0.1", fx["ready"])
            if ok.returncode == 0 and fx["ready_ok"] in ok.stdout.lower():
                break
            time.sleep(0.5)
        else:
            sys.exit(f"{kind} container never became ready")
        state[kind] = {
            "container": fx["container"], "host": "127.0.0.1", "port": int(port),
            "user": "physicist", "root": "/home/physicist/.weft",
            "ssh_opts": ssh_opts(),
            **({"modules_init": "export MODULEPATH=/opt/site-modules"}
               if kind == "slurm" else {}),
        }
        print(f"{kind}: physicist@127.0.0.1:{port} (container {fx['container']})")
    STATE.write_text(json.dumps(state, indent=2) + "\n")
    print(f"\nconfigs written to {STATE}")
    print("wizard demo: pick 'Slurm cluster', host 127.0.0.1, "
          f"port {state['slurm']['port']}, user physicist")


def down() -> None:
    for fx in FIXTURES.values():
        r = _sh("docker", "rm", "-f", fx["container"])
        if r.returncode == 0:
            print(f"removed {fx['container']}")
    STATE.unlink(missing_ok=True)


def status() -> None:
    for kind, fx in FIXTURES.items():
        r = _sh("docker", "inspect", "-f", "{{.State.Status}}", fx["container"])
        print(f"{kind}: {r.stdout.strip() or 'not running'}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["up", "down", "status"])
    args = ap.parse_args()
    {"up": up, "down": down, "status": status}[args.command]()


if __name__ == "__main__":
    main()
