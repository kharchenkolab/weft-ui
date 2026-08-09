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
            elif producer and rel_path:
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
