/**
 * Data tab (workspace view): every DataRef the workspace knows — the
 * datasets jobs consume and produce. Identity is content (the ref IS the
 * hash); origin says where the bytes came from (a URL, a path, a
 * producing job or retained run — the last two click through, and
 * provenance() recurses THROUGH refs into the runs that made them).
 * Locations say which sites hold a copy right now.
 */

import { useEffect, useState } from "react";
import type { DataRefRow, DataStatResult, SiteSummary, TreeMember } from "@shared/types";
import { api, dataFileUrl, wtool } from "../api/client";
import { Api, fmtBytes, fmtWhen } from "../bits";
import { navigate } from "../router";
import { act, useApp } from "../state";
import { CampaignTrail } from "./CampaignTrail";
import { PEEK_MAX, PeekView, usePeek } from "./peek";

export interface Origin {
  kind: "job" | "run" | "url" | "path" | "none";
  label: string;
  /** click-through target for job/run origins */
  target?: string;
}

export function parseOrigin(meta: DataRefRow["meta"]): Origin {
  const o = String(meta.origin ?? "");
  if (!o) return { kind: "none", label: "—" };
  if (o.startsWith("job:jobs/")) {
    const id = o.slice("job:jobs/".length);
    return { kind: "job", label: id, target: id };
  }
  if (o.startsWith("run:")) {
    const rest = o.slice(4);
    const cut = rest.indexOf("/");
    return {
      kind: "run",
      label: rest,
      target: cut > 0 ? rest.slice(0, cut) : rest,
    };
  }
  if (/^[a-z][a-z0-9+]*:\/\//i.test(o)) return { kind: "url", label: o };
  // absolute paths read by their tail — the workspace prefix is noise
  const segs = o.split("/").filter(Boolean);
  return { kind: "path", label: segs.length > 2 ? "…/" + segs.slice(-2).join("/") : o };
}

const short = (ref: string) => ref.replace(/^dref:/, "").slice(0, 12) + "…";

function openTarget(target: string) {
  navigate(target.startsWith("krn_") ? ["jobs", "kernels", target] : ["jobs", target]);
}

function OriginCell({ meta }: { meta: DataRefRow["meta"] }) {
  const o = parseOrigin(meta);
  if (o.kind === "none") return <span className="dim">—</span>;
  if (o.target)
    return (
      <span className="mono small" title={`produced by ${o.label} — click to open the run`}>
        <a className="id" onClick={(e) => { e.stopPropagation(); openTarget(o.target!); }}>
          {o.label.length > 34 ? o.label.slice(0, 34) + "…" : o.label}
        </a>
      </span>
    );
  return (
    <span
      className="mono small dim"
      style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}
      title={o.label}
    >
      {o.label}
    </span>
  );
}

export function RegisterDisclose({ sites, onChanged }: { sites: SiteSummary[]; onChanged: () => void }) {
  const [path, setPath] = useState("");
  const [site, setSite] = useState("");
  const [inPlace, setInPlace] = useState(false);
  const [sha, setSha] = useState("");
  const [busy, setBusy] = useState(false);
  const isUrl = /^[a-z][a-z0-9+]*:\/\//i.test(path.trim());

  const register = async () => {
    if (busy) return;
    setBusy(true);
    await act("data_register", {
      path: path.trim(),
      ...(site ? { site } : {}),
      ...(inPlace && site ? { ingest: false } : {}),
      ...(sha.trim() ? { expected_sha256: sha.trim() } : {}),
    });
    setBusy(false);
    setPath("");
    onChanged();
  };

  return (
    <details className="disclose" style={{ margin: "8px 14px 0" }}>
      <summary>
        Register a dataset
        <span className="peek">a path, a URL, or a file already on a site — hashed into a ref</span>
      </summary>
      <div className="disc-body">
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <input
            className="mono"
            style={{ flex: "2 1 240px", fontSize: 11.5, padding: "3px 8px", border: "1px solid var(--line)", borderRadius: 6 }}
            placeholder="path on the workspace/site, or https:// / s3:// URL"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <select className="filter-select" value={site} onChange={(e) => setSite(e.target.value)}
                  title="where the path lives (or where a URL should be fetched); blank = the controller's workspace">
            <option value="">workspace</option>
            {sites.map((s) => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </select>
          <label className="dim small row" style={{ gap: 4 }}
                 title="reference-in-place: hash site-side, no copy — the path becomes the ref's durable home (big data on stable storage)">
            <input type="checkbox" checked={inPlace} disabled={!site || isUrl}
                   onChange={(e) => setInPlace(e.target.checked)} />
            in place
          </label>
          <input
            className="mono"
            style={{ flex: "1 1 140px", fontSize: 11.5, padding: "3px 8px", border: "1px solid var(--line)", borderRadius: 6 }}
            placeholder="expected sha256 (optional)"
            value={sha}
            onChange={(e) => setSha(e.target.value)}
          />
          <button className="btn sm" disabled={!path.trim() || busy} onClick={() => void register()}>
            {busy ? "Registering…" : "Register"}
          </button>
        </div>
        <div className="faint small" style={{ marginTop: 4 }}>
          <Api>data_register</Api> — hash-on-arrival is the identity; pass a checksum to verify against a published one
        </div>
      </div>
    </details>
  );
}

/** best display/sniff name for a bare file ref — the origin's filename tail */
function fileName(d: DataRefRow): string {
  const o = String(d.meta.origin ?? "");
  const tail = o.split("/").filter(Boolean).pop() ?? "";
  return /\.[a-z0-9]{1,8}$/i.test(tail) ? tail : short(d.ref);
}

const MEMBERS_SHOWN = 30;

/** dataset contents — the run peek's experience on refs (⌁ data_read_range) */
function ContentsSec({ d, openRel }: { d: DataRefRow; openRel?: string | null }) {
  const isTree = d.kind === "tree";
  const fname = fileName(d);
  const [members, setMembers] = useState<TreeMember[] | "loading" | "none">(
    isTree ? "loading" : "none");
  const [filter, setFilter] = useState("");
  const [all, setAll] = useState(false);
  const { peek, setPeek, doPeek, more } = usePeek((rel, offset, maxBytes) =>
    dataFileUrl(d.ref, isTree ? rel : null, maxBytes, offset, isTree ? undefined : fname));

  useEffect(() => {
    if (!isTree) return;
    api.dataMembers(d.ref)
      .then((r) => setMembers([...r.members].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))))
      .catch(() => setMembers("none"));
  }, [d.ref, isTree]);

  // a file-hit click lands ON the member: filter to it and open it
  useEffect(() => {
    if (!openRel || !isTree || !Array.isArray(members)) return;
    if (!members.some((m) => m.path === openRel)) return;
    setFilter(openRel);
    if (peek?.rel !== openRel) void doPeek(openRel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRel, members]);

  const rows =
    Array.isArray(members)
      ? members.filter((m) => !filter || m.path.toLowerCase().includes(filter.toLowerCase()))
      : [];
  const shown = all ? rows : rows.slice(0, MEMBERS_SHOWN);

  return (
    <div className="sec">
      <div className="sec-h">
        Contents
        <span className="right"><Api>data_read_range</Api></span>
      </div>
      {!isTree ? (
        <div className="row small" style={{ gap: 8 }}>
          <a className="id plain mono" title={`${fname} — file`} onClick={() => void doPeek(fname)}>
            {fname}
          </a>
          <span className="num dim">{fmtBytes(d.bytes)}</span>
          <a className="frow-act" title="preview inline — plots render, text shows its head"
             onClick={() => void doPeek(fname)}>view</a>
          <a className="frow-act" href={dataFileUrl(d.ref, null, 0, 0, fname) + "&download=1"}
             title="download the whole file through the controller">download</a>
        </div>
      ) : members === "loading" ? (
        <span className="faint small">reading the member manifest…</span>
      ) : members === "none" ? (
        <span className="dim small">member manifest not in the local CAS — fetch the tree to browse it</span>
      ) : (
        <>
          {members.length > MEMBERS_SHOWN && (
            <input
              className="mono"
              style={{ fontSize: 11.5, padding: "2px 8px", border: "1px solid var(--line)", borderRadius: 6, marginBottom: 4, width: "60%" }}
              placeholder={`filter ${members.length} members…`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {shown.map((m) => (
            <div key={m.path}>
              <div className="row small" style={{ gap: 8, padding: "1.5px 0" }}>
                <a className="id plain mono"
                   style={{ maxWidth: 230, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                   title={`${m.path} — file inside this folder`}
                   onClick={() => void doPeek(m.path)}>
                  {m.path}
                </a>
                <span className="right-al num dim">{m.size != null ? fmtBytes(m.size) : ""}</span>
                <a className="frow-act" title="preview inline"
                   onClick={() => void doPeek(m.path)}>view</a>
                <a className="frow-act" href={dataFileUrl(d.ref, m.path) + "&download=1"}
                   title="download the whole file through the controller">download</a>
              </div>
              {peek?.rel === m.path && (
                <PeekView peek={peek}
                          imgSrc={(rel) => dataFileUrl(d.ref, rel, PEEK_MAX * 8)}
                          api="data_read_range"
                          onClose={() => setPeek(null)}
                          onMore={(p) => void more(p)}
                          downloadHref={dataFileUrl(d.ref, m.path) + "&download=1"} />
              )}
            </div>
          ))}
          {rows.length > shown.length && (
            <a className="id plain small" onClick={() => setAll(true)}>
              show all {rows.length}
            </a>
          )}
        </>
      )}
      {!isTree && peek && (
        <PeekView peek={peek}
                  imgSrc={() => dataFileUrl(d.ref, null, PEEK_MAX * 8, 0, fname)}
                  api="data_read_range"
                  onClose={() => setPeek(null)}
                  onMore={(p) => void more(p)}
                  downloadHref={dataFileUrl(d.ref, null, 0, 0, fname) + "&download=1"} />
      )}
    </div>
  );
}

/** live observation vs the record (⌁ data_stat — non-mutating by contract) */
function LiveCheck({ d }: { d: DataRefRow }) {
  const [stat, setStat] = useState<DataStatResult | "checking" | null>(null);

  const run = async () => {
    if (stat === "checking") return;
    setStat("checking");
    const r = await wtool<DataStatResult>("data_stat", { ref: d.ref });
    setStat(r.error ? null : r);
  };

  const liveWord = (p: boolean | "unknown") =>
    p === true ? "present" : p === false ? "MISSING" : "unknown";

  return (
    <div style={{ marginTop: 6 }}>
      <a className="id plain small" title="observe where the bytes actually sit right now, versus the record — nothing is demoted ⌁ data_stat"
         onClick={() => void run()}>
        {stat === "checking" ? "checking…" : "Check now"}
      </a>
      {stat && stat !== "checking" && (
        <div style={{ marginTop: 6, border: "1px solid var(--line)", borderRadius: 6, padding: 8 }}>
          <div className="row small" style={{ gap: 8, marginBottom: 4 }}>
            <span className={`pill ${stat.divergent ? "s-failed" : "s-done"}`}>
              {stat.divergent ? "DIVERGENT" : "MATCHES RECORD"}
            </span>
            {stat.divergent && (
              <span className="dim small">a recorded copy observes absent — staging&apos;s verify fence acts on this; this is testimony</span>
            )}
          </div>
          <div className="row small" style={{ gap: 8, padding: "1.5px 0" }}>
            <span className="mono">workspace CAS</span>
            <span className={stat.workspace.present ? "dim" : "chip code"}>
              {stat.workspace.present ? "present" : "no local copy"}
            </span>
            {stat.workspace.members_checked != null && (
              <span className="faint small">
                {stat.workspace.members_present}/{stat.workspace.members_checked} members checked
                {stat.workspace.sampled ? " (sampled)" : ""}
              </span>
            )}
          </div>
          {stat.sites.map((s) => (
            <div className="row small" key={s.site} style={{ gap: 8, padding: "1.5px 0" }}>
              <span className="mono">{s.site}</span>
              {s.via && <span className="chip quiet">{s.via}</span>}
              <span className={s.present === false ? "chip code" : "dim"}>
                {liveWord(s.present)}
                {s.reason ? ` — ${s.reason}` : ""}
              </span>
              {s.members_checked != null && (
                <span className="faint small">
                  {s.members_present}/{s.members_checked} members{s.sampled ? " (sampled)" : ""}
                </span>
              )}
            </div>
          ))}
          <div className="faint small" style={{ marginTop: 4 }}>{stat.note}</div>
        </div>
      )}
    </div>
  );
}

export function DataDetail({ d, onChanged, openRel }: { d: DataRefRow; onChanged: () => void; openRel?: string | null }) {
  const [toPath, setToPath] = useState(`data/${d.ref.replace(/^dref:/, "").slice(0, 12)}`);
  const [busy, setBusy] = useState(false);
  const o = parseOrigin(d.meta);
  // track-back: the producing run's campaign label, when the origin is a run
  const { jobs } = useApp();
  const originLabel = o.target ? jobs.get(o.target)?.label ?? null : null;

  const fetchHome = async () => {
    if (busy) return;
    setBusy(true);
    await act("data_fetch", { ref: d.ref, to_path: toPath.trim() });
    setBusy(false);
    onChanged();
  };

  return (
    <div className="card detail">
      <div className="pane-h">
        <span className="chip quiet" title={d.kind === "tree" ? "a whole folder of files under one ref (weft calls it a tree)" : "a single file"}>
          {d.kind === "tree" ? "folder" : "file"}
        </span>
        <b style={{ fontSize: 12.5 }}>{short(d.ref)}</b>
        <span className="num dim">{fmtBytes(d.bytes)}</span>
        <span className="right-al">
          <button className="btn sm ghost" title="the full production chain — env identity, inputs, the runs behind them ⌁ provenance"
                  onClick={() => navigate(["provenance", d.ref])}>
            Provenance
          </button>
        </span>
        <div className="dim small" style={{ flexBasis: "100%" }}>
          {d.kind === "tree"
            ? "a folder-shaped dataset — its identity is the content hash of every file in it"
            : "a file-shaped dataset — its identity is its content hash"}
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">Identity</div>
        <div className="mono small" style={{ wordBreak: "break-all", color: "var(--ink2)" }}>{d.ref}</div>
        <div className="row small" style={{ gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          {d.meta.trust != null && (
            <span className="chip quiet" title="first-fetch: hash-on-arrival minted the identity; verified: it matched a caller-supplied checksum">
              trust: {String(d.meta.trust)}
            </span>
          )}
          <span className="dim small">origin:</span>
          <OriginCell meta={d.meta} />
          {o.kind === "run" && (
            <span className="faint small" title="a retained file re-entering compute — provenance walks THROUGH it into the producing run">
              (retained file)
            </span>
          )}
          {originLabel && (
            <span className="small">
              <span className="dim">campaign:</span> <CampaignTrail label={originLabel} />
            </span>
          )}
        </div>
      </div>

      <ContentsSec key={`c:${d.ref}`} d={d} openRel={openRel} />

      <div className="sec">
        <div className="sec-h">
          Copies
          <span className="right"><Api>locations (store) · data_stat</Api></span>
        </div>
        {d.locations.length === 0 ? (
          <div className="dim small">
            no site holds a copy — the bytes live in the controller&apos;s CAS; staging puts them where a task runs
          </div>
        ) : (
          <table className="tbl parts-tbl">
            <thead>
              <tr><th>site</th><th>state</th><th>verified</th><th>path</th></tr>
            </thead>
            <tbody>
              {d.locations.map((l) => (
                <tr key={l.site}>
                  <td>
                    <a className="id plain" title="the site's page — capacity, storage, policy"
                       onClick={() => navigate(["compute", l.site])}>{l.site}</a>
                  </td>
                  <td>
                    <span className={`pill ${l.present ? "s-done" : "s-cancelled"}`}>
                      {l.present ? "PRESENT" : "GONE"}
                    </span>
                  </td>
                  <td className="num dim">{l.verified_at ? fmtWhen(l.verified_at) : "—"}</td>
                  <td className="mono small dim" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.path ?? ""}>
                    {l.path ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <LiveCheck key={`s:${d.ref}`} d={d} />
      </div>

      <div className="sec">
        <div className="sec-h">
          Fetch
          <span className="right"><Api>data_fetch</Api></span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <input
            className="mono"
            style={{ flex: 1, fontSize: 11.5, padding: "3px 8px", border: "1px solid var(--line)", borderRadius: 6 }}
            value={toPath}
            onChange={(e) => setToPath(e.target.value)}
            title="destination, relative to the controller's workspace"
          />
          <button className="btn sm" disabled={busy || !toPath.trim()} onClick={() => void fetchHome()}>
            {busy ? "Fetching…" : "Fetch to workspace"}
          </button>
        </div>
        <div className="faint small" style={{ marginTop: 4 }}>
          pulls the bytes to the controller — hash-verified on arrival; evicted copies re-obtain from keeps
        </div>
      </div>
    </div>
  );
}
