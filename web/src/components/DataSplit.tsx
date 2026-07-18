/**
 * Data tab (workspace view): every DataRef the workspace knows — the
 * datasets jobs consume and produce. Identity is content (the ref IS the
 * hash); origin says where the bytes came from (a URL, a path, a
 * producing job or retained run — the last two click through, and
 * provenance() recurses THROUGH refs into the runs that made them).
 * Locations say which sites hold a copy right now.
 */

import { useState } from "react";
import type { DataRefRow, SiteSummary } from "@shared/types";
import { Api, fmtBytes, fmtWhen, Th } from "../bits";
import type { SortState } from "../bits";
import { navigate } from "../router";
import { act } from "../state";

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

export function dataMatches(d: DataRefRow, q: string, site: string): boolean {
  if (site !== "any" && !d.locations.some((l) => l.site === site)) return false;
  if (!q) return true;
  return `${d.ref} ${d.kind} ${String(d.meta.origin ?? "")} ${String(d.meta.trust ?? "")} ${d.locations
    .map((l) => l.site)
    .join(" ")}`
    .toLowerCase()
    .includes(q.toLowerCase());
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

function RegisterDisclose({ sites, onChanged }: { sites: SiteSummary[]; onChanged: () => void }) {
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

function DataDetail({ d, onChanged }: { d: DataRefRow; onChanged: () => void }) {
  const [toPath, setToPath] = useState(`data/${d.ref.replace(/^dref:/, "").slice(0, 12)}`);
  const [busy, setBusy] = useState(false);
  const o = parseOrigin(d.meta);

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
        <span className="chip quiet">{d.kind}</span>
        <b style={{ fontSize: 12.5 }}>{short(d.ref)}</b>
        <span className="num dim">{fmtBytes(d.bytes)}</span>
        <span className="right-al">
          <button className="btn sm ghost" title="the full production chain — env identity, inputs, the runs behind them ⌁ provenance"
                  onClick={() => navigate(["provenance", d.ref])}>
            Provenance
          </button>
        </span>
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
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">
          Copies
          <span className="right"><Api>locations (store)</Api></span>
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
                  <td>{l.site}</td>
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

export function DataSplit({
  rows,
  anyAtAll,
  sites,
  selected,
  onSelect,
  sort,
  onSort,
  onChanged,
}: {
  rows: DataRefRow[];
  anyAtAll: boolean;
  sites: SiteSummary[];
  selected: string | null;
  onSelect: (ref: string) => void;
  sort: SortState;
  onSort: (k: string, first?: "asc" | "desc") => void;
  onChanged: () => void;
}) {
  const sel = rows.find((d) => d.ref === selected);
  const totalBytes = rows.reduce((n, d) => n + (d.bytes ?? 0), 0);
  return (
    <div className="split">
      <div className="card tablecard" style={{ paddingBottom: 10 }}>
        <div className="row" style={{ padding: "10px 14px 2px", gap: 10 }}>
          <b style={{ fontSize: 12.5 }}>
            {rows.length} dataset{rows.length === 1 ? "" : "s"} · {fmtBytes(totalBytes)}
          </b>
          <span className="right-al">
            <Api>⌁ uiapi /data (no list tool yet)</Api>
          </span>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <Th k="ref" sort={sort} onSort={onSort}>Ref</Th>
              <Th k="origin" sort={sort} onSort={onSort}>Origin</Th>
              <Th k="bytes" first="desc" className="r" sort={sort} onSort={onSort}>Size</Th>
              <Th k="sites" first="desc" sort={sort} onSort={onSort} title="sites holding a live copy">Sites</Th>
              <Th k="verified" first="desc" className="r" sort={sort} onSort={onSort}>Verified</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr
                key={d.ref}
                data-rowid={d.ref}
                className={selected === d.ref ? "sel" : undefined}
                onClick={() => onSelect(d.ref)}
              >
                <td>
                  <span className="chip quiet">{d.kind}</span>{" "}
                  <a className="id plain mono" title={d.ref}>{short(d.ref)}</a>
                </td>
                <td><OriginCell meta={d.meta} /></td>
                <td className="r num">{fmtBytes(d.bytes)}</td>
                <td>
                  {d.locations.filter((l) => l.present).map((l) => (
                    <span className="chip quiet" key={l.site} style={{ marginRight: 4 }}>{l.site}</span>
                  ))}
                  {!d.locations.some((l) => l.present) && <span className="dim small">cas only</span>}
                </td>
                <td className="r num dim">
                  {fmtWhen(Math.max(0, ...d.locations.map((l) => l.verified_at ?? 0)) || undefined)}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="dim" style={{ padding: 24, textAlign: "center" }}>
                  {anyAtAll
                    ? "no datasets match the filters"
                    : "no datasets yet — register a path or URL below, or let a task's inputs mint refs as they stage"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <RegisterDisclose sites={sites} onChanged={onChanged} />
      </div>
      {sel ? (
        <DataDetail d={sel} onChanged={onChanged} />
      ) : (
        <div className="card detail">
          <div className="empty-detail">select a dataset to see where its copies live</div>
        </div>
      )}
    </div>
  );
}

/** sort keys shared with JobsPage's memo */
export function dataSortKeys() {
  return {
    ref: (d: DataRefRow) => d.ref,
    origin: (d: DataRefRow) => parseOrigin(d.meta).label,
    bytes: (d: DataRefRow) => d.bytes ?? 0,
    sites: (d: DataRefRow) => d.locations.filter((l) => l.present).length,
    verified: (d: DataRefRow) => Math.max(0, ...d.locations.map((l) => l.verified_at ?? 0)),
  };
}
