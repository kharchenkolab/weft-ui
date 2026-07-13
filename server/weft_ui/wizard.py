"""Wizard support endpoints (plan D6): the probes that run BEFORE a site
exists — ssh-config discovery, reachability preflight with a classified
fix ladder, disk and scheduler probes over raw ssh.

Security posture: never a shell — argv lists only; destinations and
options are validated against tight patterns before any process spawns;
BatchMode=yes always (nothing here can prompt for credentials).
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

from anyio import to_thread
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

DEST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9_.@-]*[A-Za-z0-9])?$")
SAFE_OPT_RE = re.compile(
    r"^(?:-i|-o|-p|-J|-[46])$|"                       # option flags we pass through
    r"^[A-Za-z]+=[A-Za-z0-9_./@:, -]+$|"              # -o Key=Value bodies
    r"^[A-Za-z0-9_./@:-]+$"                            # -i path / -J jump / -p port bodies
)
# -o keys that execute commands — never over the wire
DENY_OPT_KEYS = re.compile(r"^(proxycommand|localcommand|permitlocalcommand|"
                           r"remotecommand|knownhostscommand)=", re.IGNORECASE)
SSH_TIMEOUT = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]


def _validate(dest: str, opts: list[str]) -> str | None:
    if not DEST_RE.match(dest.split("@")[-1]) or dest.count("@") > 1:
        return f"destination {dest!r} is not a plain host/user@host"
    for o in opts:
        if not SAFE_OPT_RE.match(o) or DENY_OPT_KEYS.match(o):
            return f"ssh option {o!r} not allowed"
    return None


def _ssh(dest: str, port: int | None, opts: list[str], command: str,
         timeout: int = 20) -> subprocess.CompletedProcess:
    argv = ["ssh", *SSH_TIMEOUT, *opts]
    if port:
        argv += ["-p", str(port)]
    argv += [dest, command]
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)


# ---- preflight classification (pure — unit-tested) --------------------------

FIX_LADDER = {
    "auth": {
        "headline": "This machine isn't set up to reach {dest} yet",
        "explain": "The host answered but didn't accept the connection — "
                   "usually a missing key. A short one-time setup on your "
                   "machine fixes it; weft never sees your sign-in.",
        "commands": ["ssh-keygen -t ed25519   # once, if you have no key",
                     "ssh-copy-id {ssh_target}"],
    },
    "hostkey": {
        "headline": "Your machine doesn't trust {dest}'s identity yet",
        "explain": "First contact (or the host changed). Connect once from "
                   "a terminal and accept the fingerprint.",
        "commands": ["ssh {ssh_target}   # inspect + accept the fingerprint"],
    },
    "dns": {
        "headline": "The name {dest} doesn't resolve from here",
        "explain": "Check the spelling — or the cluster may only have a "
                   "name on the lab network (VPN or a jump host).",
        "commands": [],
    },
    "network": {
        "headline": "No route to {dest}",
        "explain": "Some clusters are only reachable over VPN or through a "
                   "jump host. If you normally connect via another machine, "
                   "add it as a jump host.",
        "commands": [],
    },
    "unknown": {
        "headline": "Something else",
        "explain": "The full message from the host is shown as-is; the "
                   "agent can help read it.",
        "commands": [],
    },
}


def classify_preflight(returncode: int, stderr: str) -> str:
    """Map ssh's stderr onto the fix-ladder cases, most specific first."""
    if returncode == 0:
        return "ok"
    s = stderr.lower()
    if "permission denied" in s or "no supported authentication" in s:
        return "auth"
    if "host key verification failed" in s or "remote host identification has changed" in s:
        return "hostkey"
    if "could not resolve hostname" in s or "name or service not known" in s:
        return "dns"
    if "connection refused" in s or "timed out" in s or "no route to host" in s \
            or "network is unreachable" in s:
        return "network"
    return "unknown"


# ---- ~/.ssh/config discovery (pure — unit-tested) ---------------------------

def parse_ssh_config(text: str) -> list[dict]:
    """Host blocks with concrete names (wildcards skipped): the saved-hosts
    picker. Reads only Host/HostName/User/Port/ProxyJump."""
    hosts: list[dict] = []
    current: list[dict] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        key, _, value = line.partition(" ")
        key, value = key.lower(), value.strip()
        if key == "host":
            current = [{"host": h} for h in value.split()
                       if not any(c in h for c in "*?!")]
            hosts.extend(current)
        elif current and key in ("hostname", "user", "port", "proxyjump"):
            for h in current:
                h[{"hostname": "hostname", "user": "user",
                   "port": "port", "proxyjump": "jump"}[key]] = value
    return hosts


# ---- scheduler probe parsing (pure — unit-tested) ---------------------------

def parse_sinfo(out: str) -> list[dict]:
    """sinfo -h -o '%P|%D|%c|%m|%l|%G' rows -> partition dicts."""
    parts = []
    for line in out.strip().splitlines():
        cols = line.split("|")
        if len(cols) < 6:
            continue
        name, nodes, cpus, mem, wall, gres = (c.strip() for c in cols[:6])
        parts.append({
            "name": name.rstrip("*"),
            "default": name.endswith("*"),
            "nodes": int(nodes) if nodes.isdigit() else nodes,
            "cpus_per_node": int(cpus) if cpus.isdigit() else cpus,
            "mem_per_node": mem,
            "max_walltime": wall,
            "gres": "" if gres in ("(null)", "") else gres,
        })
    return parts


# ---- routes ------------------------------------------------------------------

class SshTarget(BaseModel):
    dest: str
    port: int | None = None
    ssh_opts: list[str] = []


def build_router() -> APIRouter:
    router = APIRouter(prefix="/api/ui")

    @router.get("/ssh_config_hosts")
    async def ssh_config_hosts():
        path = Path.home() / ".ssh" / "config"
        if not path.exists():
            return {"hosts": [], "note": "no ~/.ssh/config on this machine"}
        return {"hosts": parse_ssh_config(path.read_text())}

    @router.post("/preflight_ssh")
    async def preflight_ssh(t: SshTarget):
        if err := _validate(t.dest, t.ssh_opts):
            return JSONResponse({"error": {"code": "bad_request", "detail": err}},
                                status_code=400)
        try:
            r = await to_thread.run_sync(
                lambda: _ssh(t.dest, t.port, t.ssh_opts, "true"))
        except subprocess.TimeoutExpired:
            r = subprocess.CompletedProcess([], 255, "", "connection timed out")
        case = classify_preflight(r.returncode, r.stderr)
        ssh_target = t.dest if not t.port else f"-p {t.port} {t.dest}"
        out: dict[str, Any] = {"case": case, "stderr": r.stderr[-2000:]}
        if case != "ok":
            # the whole ladder, the diagnosed case first — mockup 04 state 3
            ordered = [case] + [k for k in FIX_LADDER if k != case]
            out["fixes"] = [
                {"case": k,
                 "headline": FIX_LADDER[k]["headline"].format(dest=t.dest),
                 "explain": FIX_LADDER[k]["explain"],
                 "commands": [c.format(ssh_target=ssh_target)
                              for c in FIX_LADDER[k]["commands"]]}
                for k in ordered]
        return out

    @router.post("/df_probe")
    async def df_probe(t: SshTarget):
        if err := _validate(t.dest, t.ssh_opts):
            return JSONResponse({"error": {"code": "bad_request", "detail": err}},
                                status_code=400)
        r = await to_thread.run_sync(lambda: _ssh(
            t.dest, t.port, t.ssh_opts,
            "echo H:$HOME; df -Pk 2>/dev/null | tail -n +2"))
        if r.returncode != 0:
            return JSONResponse({"error": {"code": "unreachable",
                                           "detail": r.stderr[-500:]}}, status_code=502)
        home, mounts = "", []
        for line in r.stdout.splitlines():
            if line.startswith("H:"):
                home = line[2:].strip()
                continue
            cols = line.split()
            if len(cols) >= 6 and cols[1].isdigit():
                total_kb, free_kb, mount = int(cols[1]), int(cols[3]), cols[5]
                if mount.startswith(("/dev", "/proc", "/sys", "/run", "/boot")) \
                        or total_kb < 1024 * 1024:  # skip pseudo + tiny fs
                    continue
                mounts.append({"mount": mount,
                               "total_gb": round(total_kb / 1024 / 1024, 1),
                               "free_gb": round(free_kb / 1024 / 1024, 1)})
        return {"home": home, "mounts": mounts}

    @router.post("/sinfo_probe")
    async def sinfo_probe(t: SshTarget):
        if err := _validate(t.dest, t.ssh_opts):
            return JSONResponse({"error": {"code": "bad_request", "detail": err}},
                                status_code=400)
        # rc must reflect CONNECTIVITY only — a missing `module` command on
        # the host must not read as unreachable, so the probe ends with `true`
        r = await to_thread.run_sync(lambda: _ssh(
            t.dest, t.port, t.ssh_opts,
            "sinfo -h -o '%P|%D|%c|%m|%l|%G' 2>/dev/null; echo ---; "
            "sacctmgr -nP show assoc user=$USER format=account 2>/dev/null | sort -u; "
            "echo ---; (module avail >/dev/null 2>&1 && echo modules-ok); true"))
        if r.returncode != 0:
            return JSONResponse({"error": {"code": "unreachable",
                                           "detail": r.stderr[-500:]}}, status_code=502)
        sinfo_out, _, rest = r.stdout.partition("---")
        accounts_out, _, modules_out = rest.partition("---")
        partitions = parse_sinfo(sinfo_out)
        # some sacctmgr builds ignore format= and return full assoc rows —
        # the account is the first |-field either way
        accounts = sorted({a.split("|")[0].strip()
                           for a in accounts_out.splitlines() if a.strip()})
        return {"partitions": partitions,
                "accounts": accounts,
                "accounts_visible": bool(accounts),
                "modules_ready": "modules-ok" in modules_out}

    return router
