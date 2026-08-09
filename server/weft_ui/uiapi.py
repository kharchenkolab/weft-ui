"""UI-only endpoints — the seams the tool surface doesn't cover.

As of weft 9a30cdb the enumeration verbs (jobs_where, list_envs,
list_kernels, list_services, audit_tail) are PUBLIC_TOOLS, so the web
client calls them through the facade like any peer. What remains here is
the live log sub-stream (plan D3): `task_logs` is cursor-polling, so the
server polls at 1 s per open pane and re-emits over SSE — UI copy says
"live (1 s)", honest not fake.
"""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import time
from pathlib import Path
from typing import Any, AsyncIterator

from anyio import to_thread
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

LOG_POLL_S = 1.0
MAX_FOLLOWS_PER_CLIENT = 4
RUNNING_STATES = {"RUNNING", "QUEUED", "STAGING", "SUBMITTED"}

INDEX_TTL_S = 2.0          # store-only aggregation; SSE drives refetch anyway
INDEX_HIT_CAP = 8          # file hits shown per object; hit_total says the rest
DOWNLOAD_CHUNK = 8 * 1024 * 1024
DOWNLOAD_MAX = 2 * 1024 ** 3  # streamed through the controller; beyond this,
                              # fetch local and take it from the workspace


def _parse_origin_target(origin: str) -> str | None:
    """producing job/kernel id from a dataset's origin string, if any"""
    if origin.startswith("job:jobs/"):
        return origin.split("/", 1)[1]
    if origin.startswith("run:"):
        rest = origin[4:]
        return rest.split("/", 1)[0] if "/" in rest else rest
    return None


# weft's own run plumbing, for inventories recorded before the substrate
# grew the scaffold flag — mirrors the client-side fallback
SCAFFOLD_NAMES = {
    "activate.sh", "cmd.sh", "exit_code", "log", "log.err", "node",
    "pid", "pid.real", "rc", "runner.sh", "rusage", "wall_s",
    "driver.py", "kernel.stop", "kernel.pid", "kernel.log",
}


def _name_tail(origin: str) -> str | None:
    """a filename-looking tail of a path/url/run origin, for display"""
    tail = origin.rstrip("/").rsplit("/", 1)[-1]
    return tail if "." in tail else None


def build_index(weft: Any) -> list[dict]:
    """One flat view over the three data vocabularies — DATASETS
    (identity: datarefs+locations), KEEPS (holdings: retained_runs),
    REMAINS (knowledge: run_inventories for runs nobody retained).
    Store-only by design: the record IS the index; live observation
    (data_stat / run_file_stat / peeks) stays a per-object, on-demand
    tier. Rows carry _rels (per-file names) for file-deep search —
    stripped before the response."""
    store = weft.store
    jobs = {r["job_id"]: dict(r) for r in store._rows(
        "SELECT job_id, task, site, state, updated_at, manifest FROM jobs")}
    labels: dict[str, str | None] = {}
    # run manifests record path<->ref for every declared output — the
    # human name of each "anonymous" output dataset lives right here
    out_paths: dict[str, str] = {}
    for jid, r in jobs.items():
        try:
            labels[jid] = (json.loads(r["task"] or "{}") or {}).get("label")
        except json.JSONDecodeError:
            labels[jid] = None
        try:
            man = json.loads(r.get("manifest") or "{}") or {}
        except json.JSONDecodeError:
            man = {}
        for o in man.get("outputs") or []:
            if isinstance(o, dict) and o.get("ref") and o.get("path"):
                out_paths[o["ref"]] = o["path"]
    for k in store._rows("SELECT kernel_id, label FROM kernels"):
        labels[k["kernel_id"]] = k["label"]

    invs = {r["target"]: dict(r) for r in store._rows(
        "SELECT target, site, recorded_at, entries, truncated, total"
        " FROM run_inventories")}

    def inv_rels(target: str) -> list[tuple[str, int]]:
        row = invs.get(target)
        if not row:
            return []
        try:
            entries = json.loads(row["entries"] or "[]")
        except json.JSONDecodeError:
            return []
        return [(e.get("path", ""), e.get("bytes", 0)) for e in entries
                if not e.get("scaffold")
                and e.get("path") not in SCAFFOLD_NAMES]

    rows: list[dict] = []
    # per-run rels whose bytes are ALREADY in the workspace — the
    # persistent "saved" state the run faces show per file
    local_rels: dict[str, set] = {}

    # -- datasets ---------------------------------------------------------
    locs: dict[str, list[dict]] = {}
    for l_ in store._rows(
            "SELECT ref, site, path, present, verified_at FROM locations"):
        locs.setdefault(l_["ref"], []).append(dict(l_))
    for d in store._rows("SELECT ref, kind, bytes, meta FROM datarefs"):
        meta = d["meta"]
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except json.JSONDecodeError:
                meta = {}
        meta = meta or {}
        origin = str(meta.get("origin") or "")
        producer = _parse_origin_target(origin)
        plabel = labels.get(producer) if producer else None
        # the manifest's recorded output path is the ref's human name
        rel_path = out_paths.get(d["ref"])
        tail = _name_tail(origin) or (
            rel_path.rstrip("/").rsplit("/", 1)[-1] if rel_path else None)
        # producer-minted output refs still ROLL UP below (one row per
        # campaign) — 55 named result files are one product set, not 55
        # rows; the names ride into the rollup's member list
        auto = _name_tail(origin) is None and producer is not None
        name = (tail
                or (f"{plabel or producer} · output" if producer else None)
                or f"{d['kind']} {d['ref'][5:17]}…")
        dlocs = locs.get(d["ref"], [])
        rels: list[tuple[str, int]] = []
        files = 1 if d["kind"] == "file" else None
        members: list[dict] | None = None
        if d["kind"] == "tree":
            try:  # manifest is content-addressed — cacheable forever
                members = [e for e in weft.cas.tree_manifest(d["ref"])
                           if e.get("kind") == "file"]
                rels = [(e["path"], e.get("size", 0)) for e in members]
                files = len(members)
            except Exception:
                pass  # never-ingested reference-in-place tree: no manifest
        if rel_path:  # result files are findable by their own names
            rels.append((rel_path, d["bytes"]))
        # local = the workspace actually holds the bytes: a recorded
        # @workspace location OR the content sitting in the workspace CAS
        # (data_fetch fills the CAS without minting a location row)
        local = any(x["site"] == "@workspace" and x["present"]
                    for x in dlocs)
        if not local:
            try:
                if d["kind"] == "file":
                    local = weft.cas._blob_path(d["ref"][5:]).exists()
                elif members:
                    local = all(
                        weft.cas._blob_path(e["sha256"]).exists()
                        for e in members)
            except Exception:
                pass
        if local:
            if origin.startswith("run:") and "/" in origin[4:]:
                t, rl = origin[4:].split("/", 1)
                local_rels.setdefault(t, set()).add(rl)
            elif producer and rel_path and not rel_path.endswith("/") \
                    and d["kind"] == "file":
                # per-FILE ledger: folder-shaped output refs would make
                # the count disagree with the file list
                local_rels.setdefault(producer, set()).add(rel_path)
        rows.append({
            "tier": "dataset", "id": d["ref"], "ref": d["ref"],
            "kind": d["kind"], "name": name, "campaign": plabel,
            "origin": origin or None, "producer": producer,
            "sites": sorted({x["site"] for x in dlocs
                             if x["present"] and x["site"] != "@workspace"}),
            "local": local,
            "files": files, "bytes": d["bytes"],
            "when": max((x["verified_at"] or 0 for x in dlocs), default=0)
            or (jobs.get(producer or "") or {}).get("updated_at"),
            "state": None, "rel": rel_path,
            "_auto": auto, "_rels": rels,
        })

    # -- roll up anonymous outputs --------------------------------------
    # one row per campaign (array elements share the submit's label but
    # each has its own job id — the label IS the human handle); a lone
    # auto-named ref stays a plain dataset row
    by_camp: dict[str, list[dict]] = {}
    keep_rows: list[dict] = []
    for r in rows:
        if r.pop("_auto", False) and (r["campaign"] or r["producer"]):
            by_camp.setdefault(r["campaign"] or r["producer"], []).append(r)
        else:
            keep_rows.append(r)
    rows = keep_rows
    for key, kids in by_camp.items():
        if len(kids) == 1:
            rows.extend(kids)
            continue
        kids.sort(key=lambda k: k.get("bytes") or 0, reverse=True)
        rows.append({
            "tier": "outputs", "id": f"out:{key}",
            "name": key, "campaign": kids[0]["campaign"],
            "sites": sorted({s for k in kids for s in k["sites"]}),
            "local": all(k["local"] for k in kids),
            "n_local": sum(1 for k in kids if k["local"]),
            "n_refs": len(kids),
            "files": sum(k.get("files") or 0 for k in kids) or None,
            "bytes": sum(k.get("bytes") or 0 for k in kids),
            "when": max((k.get("when") or 0) for k in kids) or None,
            "state": None,
            "outputs": [{"ref": k["ref"], "kind": k["kind"],
                         "rel": k.get("rel"), "bytes": k["bytes"],
                         "files": k["files"], "local": k["local"],
                         "producer": k["producer"]}
                        for k in kids],
            "_rels": [rel for k in kids for rel in k["_rels"]],
        })

    # -- keeps ------------------------------------------------------------
    retained = [dict(r) for r in store._rows(
        "SELECT target, site, label, in_place, moved, files, bytes,"
        " state, retained_at, selection FROM retained_runs")]
    kept_targets = set()
    for k in retained:
        kept_targets.add(k["target"])
        try:
            sel = json.loads(k["selection"] or "{}")
        except json.JSONDecodeError:
            sel = {}
        home = sel.get("dest") == "@workspace"
        placement = ("marked in place" if k["in_place"] and not k["moved"]
                     else "shipped home" if home else "on-site keep")
        plabel = labels.get(k["target"])
        rows.append({
            "tier": "keep", "id": k["target"], "target": k["target"],
            "name": plabel or k["target"],
            "campaign": k["label"] or plabel,
            "sites": [] if home else [k["site"]],
            "local": bool(home), "placement": placement,
            "files": k["files"], "bytes": k["bytes"],
            "when": k["retained_at"], "state": k["state"],
            "local_rels": sorted(local_rels.get(k["target"], ())),
            "_rels": inv_rels(k["target"]),
        })

    # -- remains ----------------------------------------------------------
    for target, inv in invs.items():
        if target in kept_targets:
            continue  # the keep row speaks for this run
        rels = inv_rels(target)
        if not rels:
            continue  # scaffold-only runs have nothing a human wants
        plabel = labels.get(target)
        job = jobs.get(target) or {}
        rows.append({
            "tier": "remains", "id": target, "target": target,
            "name": plabel or target, "campaign": plabel,
            "sites": [inv["site"]] if inv["site"] else [],
            "local": False,
            "files": len(rels), "bytes": sum(b for _, b in rels),
            "when": inv["recorded_at"], "state": job.get("state"),
            "recorded_truncated": bool(inv["truncated"]),
            "local_rels": sorted(local_rels.get(target, ())),
            "_rels": rels,
        })

    rows.sort(key=lambda r: r.get("when") or 0, reverse=True)
    return rows


def build_footprint(weft: Any, scope: str) -> dict:
    """The uniform "what does X occupy, everywhere" rollup (M11): ONE
    shape for every scope — run:<target> | campaign:<label> |
    site:<name> | local. Store-only enumeration: lines carry sizes and
    the substrate calls that would free them; the truth about
    deletability (last copy? pinned? external?) is answered at confirm
    time by data_evict(dry_run) — weft's evaluator is the single
    authority, never re-implemented here. `shared` counts runs OUTSIDE
    the scope using the same env (site scope: all users — the copy is
    informational either way; released envs rebuild)."""
    store = weft.store
    kind, _, arg = scope.partition(":")
    if kind not in {"run", "campaign", "site", "local"} \
            or (kind != "local" and not arg):
        return {"error": "bad_scope", "detail": scope}

    jobs: dict[str, dict] = {}
    for r in store._rows("SELECT job_id, task, site, state, manifest FROM jobs"):
        try:
            task = json.loads(r["task"] or "{}") or {}
        except json.JSONDecodeError:
            task = {}
        try:
            man = json.loads(r["manifest"] or "{}") or {}
        except json.JSONDecodeError:
            man = {}
        jobs[r["job_id"]] = {"task": task, "site": r["site"],
                             "state": r["state"], "man": man,
                             "label": task.get("label")}
    labels = {jid: j["label"] for jid, j in jobs.items()}
    for k in store._rows("SELECT kernel_id, label FROM kernels"):
        labels[k["kernel_id"]] = k["label"]

    drefs = {d["ref"]: dict(d) for d in store._rows(
        "SELECT ref, kind, bytes, meta FROM datarefs")}
    locs: dict[str, list[dict]] = {}
    for l_ in store._rows(
            "SELECT ref, site, path, present, verified_at FROM locations"):
        locs.setdefault(l_["ref"], []).append(dict(l_))
    retained = {r["target"]: dict(r) for r in store._rows(
        "SELECT target, site, label, in_place, moved, files, bytes, state,"
        " retained_at, selection FROM retained_runs")}
    invs = {r["target"]: dict(r) for r in store._rows(
        "SELECT target, site, recorded_at, entries, truncated"
        " FROM run_inventories")}
    reals = [dict(r) for r in store._rows(
        "SELECT env_id, site, state, bytes FROM realizations"
        " WHERE state IN ('ready', 'building')")]

    def _meta(d: dict) -> dict:
        m = d["meta"]
        if isinstance(m, str):
            try:
                m = json.loads(m)
            except json.JSONDecodeError:
                m = {}
        return m or {}

    def cas_local(ref: str) -> bool:
        d = drefs.get(ref)
        if not d:
            return False
        try:
            if d["kind"] == "file":
                return weft.cas._blob_path(ref[5:]).exists()
            members = [e for e in weft.cas.tree_manifest(ref)
                       if e.get("kind") == "file"]
            return bool(members) and all(
                weft.cas._blob_path(e["sha256"]).exists() for e in members)
        except Exception:
            return False

    def run_refs(target: str) -> set[str]:
        """datasets tied to a run: declared inputs + minted outputs"""
        j = jobs.get(target) or {}
        refs = {i.get("ref") for i in (j.get("task", {}).get("inputs") or [])
                if isinstance(i, dict) and i.get("ref")}
        refs |= {o.get("ref") for o in (j.get("man", {}).get("outputs") or [])
                 if isinstance(o, dict) and o.get("ref")}
        return {r for r in refs if r in drefs}

    def keep_strands(target: str) -> int:
        """pre-flight ESTIMATE of refs whose only bytes are this keep
        (weft's forget receipt is the authority at execution time)"""
        n = 0
        for ref, d in drefs.items():
            if (_meta(d).get("keep") or {}).get("target") != target:
                continue
            if any(x["present"] and x["site"] != "@workspace"
                   for x in locs.get(ref, ())):
                continue
            if cas_local(ref):
                continue
            n += 1
        return n

    lines: list[dict] = []

    def keep_line(t: str) -> None:
        k = retained.get(t)
        if not k:
            return
        # in_place/moved is the placement truth channel (same rule as the
        # retention panel's placementWord — selection.dest is the ASK,
        # these record what actually happened)
        placement = ("shipped home" if not k["in_place"]
                     else "marked in place" if not k["moved"]
                     else "on-site keep")
        lines.append({
            "tier": "keep", "site": k["site"], "target": t,
            "name": labels.get(t) or t,
            "bytes": k["bytes"], "files": k["files"], "state": k["state"],
            "placement": placement,
            "strands": keep_strands(t),
            "action": {"tool": "run_forget", "calls": [{"target": t}]},
        })

    def sandbox_line(t: str) -> None:
        inv = invs.get(t)
        j = jobs.get(t)
        if not inv or (j and j["state"] in RUNNING_STATES):
            return
        try:
            entries = json.loads(inv["entries"] or "[]")
        except json.JSONDecodeError:
            entries = []
        useful = [e for e in entries if not e.get("scaffold")
                  and e.get("path") not in SCAFFOLD_NAMES]
        if not useful:
            return
        lines.append({
            "tier": "sandbox", "site": inv["site"], "target": t,
            "name": labels.get(t) or t,
            "bytes": sum(e.get("bytes") or 0 for e in useful),
            "files": len(useful), "recorded_at": inv["recorded_at"],
            "action": {"tool": "run_discard", "calls": [{"target": t}]},
        })

    def env_lines(targets: list[str]) -> None:
        real_by = {(r["env_id"], r["site"]): r for r in reals}
        pairs: set[tuple[str, str]] = set()
        for t in targets:
            j = jobs.get(t) or {}
            e = (j.get("man") or {}).get("env_id")
            if e and (e, j.get("site")) in real_by:
                pairs.add((e, j["site"]))
        tset = set(targets)
        for e, site in sorted(pairs):
            r = real_by[(e, site)]
            others = sum(1 for jid, j in jobs.items()
                         if jid not in tset and j.get("site") == site
                         and (j.get("man") or {}).get("env_id") == e)
            lines.append({
                "tier": "env", "site": site, "env_id": e,
                "bytes": r["bytes"], "state": r["state"], "shared": others,
                "action": {"tool": "env_evict",
                           "calls": [{"env_id": e, "site": site}]},
            })

    def copies_lines(refs: set[str], only_site: str | None = None) -> None:
        by_site: dict[str, list[dict]] = {}
        ext_by_site: dict[str, list[dict]] = {}
        for ref in sorted(refs):
            for x in locs.get(ref, ()):
                if not x["present"] or x["site"] == "@workspace":
                    continue
                if only_site and x["site"] != only_site:
                    continue
                entry = {"ref": ref, "bytes": drefs[ref]["bytes"] or 0}
                if str(x["path"] or "").startswith("external:"):
                    ext_by_site.setdefault(x["site"], []).append(entry)
                else:
                    by_site.setdefault(x["site"], []).append(entry)
        for site, es in sorted(by_site.items()):
            lines.append({
                "tier": "copies", "site": site,
                "bytes": sum(e["bytes"] for e in es), "count": len(es),
                "refs": [e["ref"] for e in es],
                "action": {"tool": "data_evict",
                           "calls": [{"ref": e["ref"], "at": site}
                                     for e in es]},
            })
        for site, es in sorted(ext_by_site.items()):
            lines.append({  # not weft's to delete — informational, no action
                "tier": "external", "site": site,
                "bytes": sum(e["bytes"] for e in es), "count": len(es),
                "refs": [e["ref"] for e in es],
            })

    def cache_line(refs: set[str]) -> None:
        have = [r for r in sorted(refs) if cas_local(r)]
        if have:
            lines.append({
                "tier": "cache", "site": "@workspace",
                "bytes": sum(drefs[r]["bytes"] or 0 for r in have),
                "count": len(have), "refs": have,
                "action": {"tool": "data_evict",
                           "calls": [{"ref": r, "at": "@workspace"}
                                     for r in have]},
            })

    def records_line(targets: list[str]) -> None:
        n = 0
        for t in targets:
            j = jobs.get(t) or {}
            n += len(json.dumps(j.get("task") or {}))
            n += len(json.dumps(j.get("man") or {}))
            inv = invs.get(t)
            if inv:
                n += len(inv["entries"] or "")
        lines.append({"tier": "records", "bytes": n})

    if kind == "run":
        title = labels.get(arg) or arg
        keep_line(arg)
        sandbox_line(arg)
        env_lines([arg])
        refs = run_refs(arg)
        copies_lines(refs)
        cache_line(refs)
        records_line([arg])
    elif kind == "campaign":
        title = arg
        targets = sorted({t for t, x in labels.items() if x == arg}
                         | {t for t, k in retained.items()
                            if k.get("label") == arg})
        for t in targets:
            keep_line(t)
            sandbox_line(t)
        env_lines(targets)
        refs: set[str] = set()
        for t in targets:
            refs |= run_refs(t)
        copies_lines(refs)
        cache_line(refs)
        records_line(targets)
    elif kind == "site":
        title = arg
        for t, k in sorted(retained.items()):
            if k["site"] == arg:
                keep_line(t)
        for t, inv in sorted(invs.items()):
            if inv["site"] == arg and t not in retained:
                sandbox_line(t)
        for r in sorted(reals, key=lambda x: x["env_id"]):
            if r["site"] != arg:
                continue
            users = sum(1 for j in jobs.values() if j.get("site") == arg
                        and (j.get("man") or {}).get("env_id") == r["env_id"])
            lines.append({"tier": "env", "site": arg, "env_id": r["env_id"],
                          "bytes": r["bytes"], "state": r["state"],
                          "shared": users,
                          "action": {"tool": "env_evict",
                                     "calls": [{"env_id": r["env_id"],
                                                "site": arg}]}})
        copies_lines(set(drefs), only_site=arg)
    else:  # local: weft's cache is releasable; saved files are the user's
        title = "workspace"
        cache_line(set(drefs))
        saved: list[dict] = []
        data_dir = Path(weft.workspace) / "data"
        if data_dir.is_dir():
            for p in sorted(data_dir.rglob("*")):
                if p.is_file():
                    saved.append({
                        "path": str(p.relative_to(weft.workspace)),
                        "bytes": p.stat().st_size})
        if saved:
            lines.append({"tier": "saved",
                          "bytes": sum(s["bytes"] for s in saved),
                          "count": len(saved), "entries": saved[:200]})

    return {"scope": scope, "title": title, "lines": lines,
            "total_bytes": sum(x.get("bytes") or 0 for x in lines
                               if x["tier"] != "records")}


def build_router(weft: Any) -> APIRouter:
    router = APIRouter(prefix="/api/ui")
    follows: dict[str, int] = {}  # client host -> open follow count
    index_cache: dict[str, Any] = {"at": 0.0, "rows": []}

    @router.get("/envs/{env_id}/packages")
    async def env_packages(env_id: str):
        """The env's actual resolved packages — no PUBLIC_TOOL returns the
        list wholesale yet (env_status carries counts, env_why is
        per-package); upstream ask on file (round 23). Reads the stored
        canonical resolution; merged across platforms."""
        row = await to_thread.run_sync(lambda: weft.store.get_env(env_id))
        if not row:
            return JSONResponse(
                {"error": {"code": "unknown_env", "detail": env_id}},
                status_code=404)
        c = row.get("canonical") or {}
        merged: dict[tuple, set] = {}
        # newer format: layers[eco].records[]; at-rest format:
        # platforms[plat] = [{name, version, kind, …}]
        for eco, layer in (c.get("layers") or {}).items():
            for rec in layer.get("records", []) if isinstance(layer, dict) else []:
                key = (rec.get("name"), rec.get("version"), rec.get("kind", eco))
                merged.setdefault(key, set())
        for plat, recs in (c.get("platforms") or {}).items():
            if not isinstance(recs, list):
                continue
            for rec in recs:
                if not isinstance(rec, dict):
                    continue
                key = (rec.get("name"), rec.get("version"), rec.get("kind", "?"))
                merged.setdefault(key, set()).add(plat)
        packages = [
            {"name": n or "?", "version": v, "kind": k,
             "platforms": sorted(plats)}
            for (n, v, k), plats in sorted(merged.items(),
                                           key=lambda kv: str(kv[0][0]).lower())
        ]
        return {"env_id": env_id, "count": len(packages), "packages": packages}

    @router.get("/data")
    async def data_list():
        """Every DataRef the workspace knows, with where copies live —
        the Data tab's list. No PUBLIC_TOOL enumerates datarefs yet
        (data_describe is per-ref); upstream ask on file (round 24).
        Reads the store the same way env_packages does."""
        def read():
            refs = weft.store._rows(
                "SELECT ref, kind, bytes, meta FROM datarefs")
            locs = weft.store._rows(
                "SELECT ref, site, path, present, verified_at FROM locations")
            by_ref: dict[str, list] = {}
            for loc in locs:
                by_ref.setdefault(loc["ref"], []).append(
                    {"site": loc["site"], "path": loc["path"],
                     "present": bool(loc["present"]),
                     "verified_at": loc["verified_at"]})
            out = []
            for r in refs:
                meta = r["meta"]
                if isinstance(meta, str):
                    try:
                        meta = json.loads(meta)
                    except json.JSONDecodeError:
                        meta = {}
                out.append({"ref": r["ref"], "kind": r["kind"],
                            "bytes": r["bytes"], "meta": meta or {},
                            "locations": by_ref.get(r["ref"], [])})
            return out
        rows = await to_thread.run_sync(read)
        return {"count": len(rows), "data": rows}

    @router.get("/footprint")
    async def footprint(scope: str):
        """what does <scope> occupy, everywhere — see build_footprint"""
        out = await to_thread.run_sync(lambda: build_footprint(weft, scope))
        return JSONResponse(out, status_code=400 if out.get("error") else 200)

    @router.get("/data/index")
    async def data_index(q: str = "", tier: str = "", site: str = "",
                         local: int = 0, limit: int = 500, offset: int = 0,
                         fresh: int = 0):
        """The aggregated Data page's list: every dataset, keep, and
        remains row the store knows, filterable, with FILE-DEEP search
        (q matches names, labels, ids, origins AND per-file rels from
        inventories / tree manifests — matches surface as `hits`).
        Counts are facet counts: computed after q+site, before
        tier/local, so the chips stay informative while filtering."""
        now = time.monotonic()
        if fresh or now - index_cache["at"] > INDEX_TTL_S:
            index_cache["rows"] = await to_thread.run_sync(
                lambda: build_index(weft))
            index_cache["at"] = now
        rows = index_cache["rows"]

        ql = q.lower().strip()
        matched = []
        for r in rows:
            hits: list[dict] = []
            hit_total = 0
            if ql:
                hay = " ".join(filter(None, (
                    r["name"], r.get("campaign"), r["id"],
                    r.get("origin")))).lower()
                if r["tier"] == "outputs":  # member refs stay findable
                    hay += " " + " ".join(
                        k["ref"] for k in r["outputs"]).lower()
                rel_hits = [(rel, b) for rel, b in r["_rels"]
                            if ql in rel.lower()]
                hit_total = len(rel_hits)
                hits = [{"rel": rel, "bytes": b}
                        for rel, b in rel_hits[:INDEX_HIT_CAP]]
                if ql not in hay and not hits:
                    continue
            if site and site not in r["sites"] and \
                    not (site == "@workspace" and r["local"]):
                continue
            out = {k: v for k, v in r.items() if k != "_rels"}
            if ql:
                out["hits"] = hits
                out["hit_total"] = hit_total
            matched.append(out)

        counts = {"dataset": 0, "keep": 0, "remains": 0,
                  "local": 0, "local_bytes": 0}
        for r in matched:
            if r["tier"] == "outputs":  # a view over N datasets — count them
                counts["dataset"] += r.get("n_refs", 1)
            else:
                counts[r["tier"]] += 1
            if r["local"]:
                counts["local"] += 1
                counts["local_bytes"] += r.get("bytes") or 0

        tiers = {t for t in tier.split(",") if t}
        shown = [r for r in matched
                 if (not tiers or r["tier"] in tiers
                     or (r["tier"] == "outputs" and "dataset" in tiers))
                 and (not local or r["local"])]
        total = len(shown)
        bytes_shown = sum(r.get("bytes") or 0 for r in shown)
        page = shown[offset:offset + limit]
        return {"total": total, "shown": len(page),
                "bytes_shown": bytes_shown, "counts": counts,
                "truncated": offset + limit < total, "rows": page}

    def _download_response(read_range, name: str):
        """Stream a WHOLE file through the controller by looping the
        ranged verb — no site-side temp files, no whole-file buffering.
        read_range(offset, length) is the sync tool call. Beyond
        DOWNLOAD_MAX the honest answer is a 413: fetch the object local
        (data_fetch) and take it from the workspace on disk."""
        first = read_range(0, DOWNLOAD_CHUNK)
        if "error" in first:
            return JSONResponse({"error": {"code": first["error"],
                                           "detail": first.get("detail")}},
                                status_code=404)
        size = first.get("size", 0)
        if size > DOWNLOAD_MAX:
            return JSONResponse(
                {"error": {"code": "download.too_big",
                           "detail": f"{size} bytes exceeds the "
                           f"{DOWNLOAD_MAX}-byte streaming cap — fetch it "
                           "to the workspace (data_fetch) and take it "
                           "from disk"}}, status_code=413)

        async def gen() -> AsyncIterator[bytes]:
            chunk = base64.b64decode(first.get("bytes_b64") or "")
            yield chunk
            off = len(chunk)
            eof = bool(first.get("eof"))
            while not eof:
                r = await to_thread.run_sync(
                    lambda o=off: read_range(o, DOWNLOAD_CHUNK))
                if "error" in r:  # mid-stream loss: stop short — the
                    return        # Content-Length mismatch is the signal
                chunk = base64.b64decode(r.get("bytes_b64") or "")
                if not chunk and not r.get("eof"):
                    return
                yield chunk
                off += len(chunk)
                eof = bool(r.get("eof"))

        fname = (name.rsplit("/", 1)[-1] or "download").replace('"', "")
        return StreamingResponse(
            gen(),
            media_type=mimetypes.guess_type(name)[0]
            or "application/octet-stream",
            headers={"Content-Length": str(size),
                     "Content-Disposition": f'attachment; filename="{fname}"',
                     "Cache-Control": "no-cache"})

    def _bytes_response(r: dict, name: str, *, total: int,
                        eof: bool) -> Response:
        """Decoded bytes + sniffed content type over either read verb —
        one header vocabulary for the client's peek: X-Weft-At (which
        copy served it), X-Weft-Total-Bytes (the whole file), X-Weft-Eof
        (did this read reach the end — the pager's signal)."""
        data = base64.b64decode(r.get("bytes_b64") or "")
        ctype = mimetypes.guess_type(name)[0] or "text/plain"
        if ctype.startswith("text/"):
            ctype += "; charset=utf-8"
        return Response(
            data, media_type=ctype,
            headers={"X-Weft-At": str(r.get("at", "")),
                     "X-Weft-Total-Bytes": str(total),
                     "X-Weft-Eof": "1" if eof else "0",
                     "X-Weft-Truncated": "0" if eof else "1",
                     "Cache-Control": "no-cache"})

    @router.get("/runs/{target}/file")
    async def run_file(target: str, rel: str, max_bytes: int = 262144,
                       offset: int = 0, download: int = 0):
        if download:
            return await to_thread.run_sync(lambda: _download_response(
                lambda o, n: weft.run_file_read_range(
                    target, rel, offset=o, length=n), rel))
        """Size-capped preview of one file from a run, by the (run,
        relpath) key — served from the sandbox or the run's keep,
        wherever the bytes now live (X-Weft-At says which). A browser-
        friendly face on ⌁ run_file_read (offset=0) / run_file_read_range
        (offset>0 — the "Show more" pager): decoded bytes with a sniffed
        content type, so <img>/<pre> render directly. A preview channel,
        not a transport — the range verb caps per call, the client loops."""
        if offset > 0:
            r = await to_thread.run_sync(
                lambda: weft.run_file_read_range(
                    target, rel, offset=offset, length=max_bytes))
            if "error" in r:
                return JSONResponse({"error": {"code": r["error"],
                                               "detail": r.get("detail")}},
                                    status_code=404)
            return _bytes_response(r, rel, total=r.get("size", 0),
                                   eof=bool(r.get("eof")))
        r = await to_thread.run_sync(
            lambda: weft.run_file_read(target, rel, max_bytes=max_bytes))
        if "error" in r:
            return JSONResponse({"error": {"code": r["error"],
                                           "detail": r.get("detail")}},
                                status_code=404)
        total = r.get("bytes_total", 0)
        return _bytes_response(r, rel, total=total,
                               eof=not r.get("truncated"))

    @router.get("/data/{ref}/file")
    async def data_file(ref: str, rel: str | None = None,
                        max_bytes: int = 262144, offset: int = 0,
                        name: str | None = None, download: int = 0):
        if download:
            return await to_thread.run_sync(lambda: _download_response(
                lambda o, n: weft.data_read_range(
                    ref, rel=rel, offset=o, length=n),
                rel or name or ref[5:17]))
        """Ranged preview of a dataset's bytes — ⌁ data_read_range behind
        the same browser face as the run peek. Tree refs take rel= (a
        member path); file refs none. name= only helps the content-type
        sniff when the ref itself has no filename (file refs)."""
        r = await to_thread.run_sync(
            lambda: weft.data_read_range(ref, rel=rel, offset=offset,
                                         length=max_bytes))
        if "error" in r:
            return JSONResponse({"error": {"code": r["error"],
                                           "detail": r.get("detail")}},
                                status_code=404)
        return _bytes_response(r, rel or name or "", total=r.get("size", 0),
                               eof=bool(r.get("eof")))

    @router.get("/data/{ref}/members")
    async def data_members(ref: str):
        """A tree ref's member manifest — what data_read_range's rel=
        addresses. No PUBLIC_TOOL lists members yet (upstream ask on
        file, round 25); reads the CAS manifest the way /data reads the
        store."""
        from weft.errors import WeftError

        def read():
            try:
                return {"members": weft.cas.tree_manifest(ref)}
            except WeftError as e:
                return {"error": e.to_dict()}
        r = await to_thread.run_sync(read)
        if "error" in r:
            err = r["error"]
            return JSONResponse(
                {"error": {"code": err.get("error", "data.missing"),
                           "detail": err.get("detail")}},
                status_code=404)
        members = [m for m in r["members"] if m.get("kind") == "file"]
        return {"ref": ref, "count": len(members), "members": members}

    @router.get("/jobs/{job_id}/logs/stream")
    async def log_stream(job_id: str, request: Request):
        """SSE sub-stream: tail once, then follow at 1 s while non-terminal."""
        client = request.client.host if request.client else "?"
        if follows.get(client, 0) >= MAX_FOLLOWS_PER_CLIENT:
            return JSONResponse(
                {"error": {"code": "too_many_follows",
                           "detail": f"max {MAX_FOLLOWS_PER_CLIENT} live log panes"}},
                status_code=429)

        async def sse() -> AsyncIterator[str]:
            follows[client] = follows.get(client, 0) + 1
            try:
                cursor = 0
                while True:
                    r = await to_thread.run_sync(
                        lambda c=cursor: weft.task_logs(job_id, follow_cursor=c))
                    if await request.is_disconnected():
                        return
                    if "error" in r:
                        yield f"data: {json.dumps(r)}\n\n"
                        return
                    if r["log"]:
                        yield f"data: {json.dumps(r)}\n\n"
                    cursor = r["cursor"]
                    if r["state"] not in RUNNING_STATES:
                        yield f"data: {json.dumps({'eof': True, 'state': r['state']})}\n\n"
                        return
                    await asyncio.sleep(LOG_POLL_S)
            finally:
                follows[client] -= 1

        return StreamingResponse(sse(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache"})

    return router
