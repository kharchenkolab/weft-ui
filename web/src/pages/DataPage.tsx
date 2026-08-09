/**
 * Data (top-level): one coherent view over everything weft knows about
 * remote data — DATASETS (identity), KEEPS (holdings), REMAINS
 * (knowledge) — aggregated server-side from the store alone (mockup 08).
 * Search is file-deep (rels inside inventories and tree manifests match
 * as nested hit rows); grouping is a lens, not a query. The three tiers
 * stay visibly distinct because their guarantees differ: a keep is a
 * promise, remains is a memory, a dataset is an identity.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DataIndexResponse, DataIndexRow, RetainedRun, RunInventory } from "@shared/types";
import { api, runFileUrl, wtool } from "../api/client";
import { Api, fmtBytes, fmtWhen, sortRows, Th, useSort } from "../bits";
import { DataDetail, RegisterDisclose } from "../components/DataSplit";
import { FootprintCard } from "../components/FootprintCard";
import { PEEK_MAX, PeekView, usePeek } from "../components/peek";
import { placementWord, SCAFFOLD } from "../components/RunRetention";
import { navigate, useRoute } from "../router";
import { store, useApp } from "../state";

type Group = "campaign" | "site" | "producer" | "none";

const TIER_PILL: Record<string, { cls: string; word: string; title: string }> = {
  dataset: { cls: "s-running", word: "DATASET",
             title: "content-addressed identity — the ref IS the hash; verifiable anywhere" },
  outputs: { cls: "s-running", word: "OUTPUTS",
             title: "the result files this campaign's runs wrote under their declared outputs= — each registered as a content-addressed dataset so later tasks can consume it by ref; one row stands for the set, the named members live in the detail" },
  keep: { cls: "s-done", word: "KEEP",
          title: "retained holdings — weft holds these bytes until you forget them" },
  remains: { cls: "s-cancelled", word: "REMAINS",
             title: "the recorded inventory of a terminal run — knowledge, not a promise; the sandbox may have been swept" },
};

function groupKey(r: DataIndexRow, g: Group): string {
  if (g === "campaign") return r.campaign || "unlabeled";
  if (g === "site") return r.sites[0] ?? (r.local ? "@workspace" : "(nowhere live)");
  if (g === "producer") return r.producer ?? r.target ?? "(registered)";
  return "";
}

function whereCell(r: DataIndexRow) {
  return (
    <>
      {r.sites.map((s) => (
        <span className="chip quiet" key={s} style={{ marginRight: 3, cursor: "pointer" }}
              title="the site's page — capacity, storage, policy"
              onClick={(e) => { e.stopPropagation(); navigate(["compute", s]); }}>{s}</span>
      ))}
      {r.local ? (
        <span className="loc-chip" title="a copy lives in the controller's workspace — the local mirror tier">
          ● local
        </span>
      ) : r.tier === "outputs" && (r.n_local ?? 0) > 0 ? (
        <span className="loc-chip" style={{ color: "var(--ink3)" }}
              title="some member refs have workspace copies">
          ◐ {r.n_local}/{r.n_refs} local
        </span>
      ) : (r.local_rels?.length ?? 0) > 0 ? (
        <span className="loc-chip" style={{ color: "var(--ink3)" }}
              title="some of this run's files have workspace copies — the detail shows which">
          ◐ {r.local_rels!.length} local
        </span>
      ) : null}
      {r.placement === "marked in place" && (
        <span className="dim small" style={{ marginLeft: 3 }} title="retained by marking — the files never moved">
          in place
        </span>
      )}
      {!r.sites.length && !r.local && <span className="dim small">—</span>}
    </>
  );
}

/** keep/remains detail — read + fetch focused; full retention management
 * stays on the run's own page (open run →) */
function RunDataFace({ target, row, openRel }: { target: string; row?: DataIndexRow; openRel?: string | null }) {
  const { data } = useApp();
  const [inv, setInv] = useState<RunInventory | null>(null);
  const [kept, setKept] = useState<RetainedRun | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [localBusy, setLocalBusy] = useState<string | null>(null);
  const { peek, setPeek, doPeek, more } = usePeek(
    (rel, offset, maxBytes) => runFileUrl(target, rel, maxBytes, offset));

  // which of this run's files are already saved to the workspace — the
  // persistent answer to "did my click work?". Two sources: the index
  // (declared outputs whose refs sit in the workspace CAS) and the
  // store's run-origin datasets (undeclared files saved via the chain)
  const savedRels = useMemo(() => {
    const saved = new Set<string>(row?.local_rels ?? []);
    const prefix = `run:${target}/`;
    for (const d of data) {
      const o = String(d.meta.origin ?? "");
      if (o.startsWith(prefix)) saved.add(o.slice(prefix.length));
    }
    return saved;
  }, [data, target, row]);

  // "local": mint identity for the (run, relpath) file, then pull the
  // bytes home — mirroring a run file UPGRADES it into a dataset
  const bringLocal = async (rel: string) => {
    if (localBusy) return;
    setLocalBusy(rel);
    const reg = await wtool<{ ref?: string; error?: string; detail?: string }>(
      "data_register", { run: target, rel });
    if (reg.error || !reg.ref) {
      const vanished = String(reg.detail ?? "").includes("no existing file");
      store.toast("err", vanished
        ? `${rel} no longer exists — the sandbox was cleaned and it wasn't retained; only the record remains`
        : `register failed: ${reg.detail ?? reg.error}`);
    } else {
      const dest = `data/${target}/${rel.split("/").pop()}`;
      const f = await wtool<{ error?: string; detail?: string }>(
        "data_fetch", { ref: reg.ref, to_path: dest });
      store.toast(f.error ? "err" : "ok",
        f.error ? `fetch failed: ${f.detail ?? f.error}` : `${rel} → ${dest} (hash-verified)`);
    }
    setLocalBusy(null);
    void store.refreshData();
  };

  // per-rel liveness — the inventory is a RECORD; one batched stat says
  // which files still have bytes (sandbox or keep) and which are gone
  const [live, setLive] = useState<Record<string, { exists?: boolean; at?: string }> | null>(null);

  useEffect(() => {
    setInv(null);
    setKept(null);
    setShowAll(false);
    setLive(null);
    setPeek(null);
    wtool<RunInventory>("run_inventory", { target }).then((r) => {
      if (r.error) return;
      setInv(r);
      const rels = (r.entries ?? [])
        .filter((e) => !e.scaffold && !SCAFFOLD.has(e.path))
        .map((e) => e.path)
        .slice(0, 500);
      if (rels.length)
        void wtool<{ files?: Record<string, { exists?: boolean; at?: string }> }>(
          "run_file_stat", { target, rels }).then((s) => {
          if (s.files) setLive(s.files);
        });
    });
    wtool<RetainedRun[]>("retained_runs", {}).then((rows) => {
      if (Array.isArray(rows)) setKept(rows.find((x) => x.target === target) ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const files = useMemo(
    () =>
      (inv?.entries ?? [])
        .filter((e) => !e.scaffold && !SCAFFOLD.has(e.path))
        .sort((a, b) => b.bytes - a.bytes),
    [inv],
  );
  const goneCount = useMemo(
    () => (live ? files.filter((e) => live[e.path]?.exists === false).length : 0),
    [files, live],
  );
  const shown = showAll ? files : files.slice(0, 40);
  const tier = kept ? "keep" : "remains";

  // a file-hit click (or deep link) lands ON the file: uncap if needed,
  // open its preview, scroll it into view
  useEffect(() => {
    if (!openRel || inv == null) return;
    const idx = files.findIndex((e) => e.path === openRel);
    if (idx === -1) return;
    if (idx >= 40) setShowAll(true);
    if (peek?.rel !== openRel) void doPeek(openRel);
    setTimeout(() => {
      document.querySelector(`[data-rel="${CSS.escape(openRel)}"]`)
        ?.scrollIntoView({ block: "center" });
    }, 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRel, inv]);

  return (
    <div className="card detail">
      <div className="pane-h">
        <span className={`pill ${TIER_PILL[tier].cls}`} title={TIER_PILL[tier].title}>{TIER_PILL[tier].word}</span>
        <b style={{ fontSize: 12.5 }}>{row?.name ?? target}</b>
        <span className="id plain">{target}</span>
        <span className="right-al">
          <button
            className="btn sm ghost"
            title="the run's own page — retention management (retain/discard/forget) lives there"
            onClick={() => navigate(target.startsWith("krn_") ? ["jobs", "kernels", target] : ["jobs", target])}
          >
            open run →
          </button>
        </span>
        <div className="dim small" style={{ flexBasis: "100%" }}>
          {kept
            ? "files this run retained — weft holds them until you forget"
            : "files this run left behind, as recorded when it finished — nothing is promised to still exist"}
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">
          {kept ? "Holding" : "Recorded remains"}
          <span className="right"><Api>{kept ? "retained_runs" : "run_inventory"}</Api></span>
        </div>
        <dl className="kv">
          {kept ? (
            <>
              <dt>placement</dt>
              <dd>
                {placementWord(kept)} —{" "}
                <a className="id plain" title="the site's page — capacity, storage, policy"
                   onClick={() => navigate(["compute", kept.site])}><b>{kept.site}</b></a>
              </dd>
              {kept.label && (
                <>
                  <dt>campaign</dt>
                  <dd>{kept.label}</dd>
                </>
              )}
              <dt>state</dt>
              <dd>{kept.state}</dd>
              <dt>holds</dt>
              <dd className="num">{kept.files} files · {fmtBytes(kept.bytes)}</dd>
            </>
          ) : (
            <>
              <dt>site</dt>
              <dd>
                {(() => {
                  const s = row?.sites[0] ?? inv?.site;
                  return s ? (
                    <a className="id plain" title="the site's page — capacity, storage, policy"
                       onClick={() => navigate(["compute", s])}>{s}</a>
                  ) : "—";
                })()}
              </dd>
              <dt>recorded</dt>
              <dd className="num">{fmtWhen(row?.when ?? undefined)}</dd>
              <dt>files</dt>
              <dd className="num">
                {files.length} · {fmtBytes(files.reduce((n, e) => n + e.bytes, 0))}
                {row?.recorded_truncated && (
                  <span className="dim small"> (inventory truncated — the biggest are listed)</span>
                )}
              </dd>
            </>
          )}
        </dl>
        {!kept && (
          <div className="faint small" style={{ marginTop: 4 }}>
            knowledge, not holdings — the sandbox may have been swept; a peek proves which copy still answers
          </div>
        )}
      </div>

      <div className="sec">
        <div className="sec-h">
          Files
          <span className="right"><Api>run_file_read · run_file_read_range</Api></span>
        </div>
        {kept && files.length !== (kept.files ?? 0) && (
          <div className="faint small" style={{ marginBottom: 5 }}>
            the run recorded {files.length} files; this keep holds {kept.files} of them (a selective
            retain) — each view names which copy answered
          </div>
        )}
        {goneCount > 0 && (
          <div className="faint small" style={{ marginBottom: 5 }}>
            {goneCount} of the recorded files no longer exist anywhere (dimmed) — the sandbox was
            cleaned; what remains is the record
          </div>
        )}
        {inv == null ? (
          <span className="faint small">reading the inventory…</span>
        ) : !files.length ? (
          <span className="dim small">nothing beyond weft&apos;s own scaffold</span>
        ) : (
          <>
            {shown.map((e) => {
              const gone = live != null && live[e.path]?.exists === false;
              if (gone)
                return (
                  <div className="row small" key={e.path} data-rel={e.path}
                       style={{ gap: 8, padding: "1.5px 0", opacity: 0.55 }}>
                    <span className="mono"
                          style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={`${e.path} — recorded when the run finished; the bytes no longer exist anywhere`}>
                      {e.path}
                    </span>
                    <span className="right-al num dim">{fmtBytes(e.bytes)}</span>
                    <span className="faint small"
                          title="the sandbox was cleaned and this file wasn't retained — the record survives; re-derive it via the run's provenance">
                      gone
                    </span>
                  </div>
                );
              return (
              <div key={e.path} data-rel={e.path}>
                <div className="row small" style={{ gap: 8, padding: "1.5px 0" }}>
                  <a
                    className="id plain mono"
                    style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={`${e.path} — file`}
                    onClick={() => void doPeek(e.path)}
                  >
                    {e.path}
                  </a>
                  <span className="right-al num dim">{fmtBytes(e.bytes)}</span>
                  <a className="frow-act" title="preview inline — plots render, text shows its head"
                     onClick={() => void doPeek(e.path)}>view</a>
                  <a className="frow-act" href={runFileUrl(target, e.path, PEEK_MAX) + "&download=1"}
                     title="download the whole file through the controller">download</a>
                  {savedRels.has(e.path) ? (
                    <span className="loc-chip"
                          title={`a copy lives in the workspace under data/${target}/`}>
                      ● local
                    </span>
                  ) : localBusy === e.path ? (
                    <span className="frow-saved" style={{ color: "var(--ink3)" }}>saving…</span>
                  ) : (
                    <a className="frow-act"
                       title="save a copy to the workspace: registers this file as a dataset, then fetches it ⌁ data_register(run=,rel=) → data_fetch"
                       onClick={() => void bringLocal(e.path)}>
                      save
                    </a>
                  )}
                </div>
                {peek?.rel === e.path && (
                  <PeekView
                    peek={peek}
                    imgSrc={(rel) => runFileUrl(target, rel, PEEK_MAX * 8)}
                    api="run_file_read"
                    onClose={() => setPeek(null)}
                    onMore={(p) => void more(p)}
                    downloadHref={runFileUrl(target, e.path, PEEK_MAX) + "&download=1"}
                    onLocal={() => void bringLocal(e.path)}
                    localBusy={localBusy === e.path}
                    localDone={savedRels.has(e.path)}
                  />
                )}
              </div>
              );
            })}
            {files.length > shown.length && (
              <a className="id plain small" onClick={() => setShowAll(true)}>
                show all {files.length}
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** OUTPUTS rollup detail: the campaign's member refs, biggest-first —
 * each clicks through to its full dataset face */
function OutputsFace({ row }: { row: DataIndexRow }) {
  const kids = row.outputs ?? [];
  const producers = new Set(kids.map((k) => k.producer).filter(Boolean));
  return (
    <div className="card detail">
      <div className="pane-h">
        <span className={`pill ${TIER_PILL.outputs.cls}`} title={TIER_PILL.outputs.title}>OUTPUTS</span>
        <b style={{ fontSize: 12.5 }}>{row.name}</b>
        <span className="num dim">{row.n_refs} refs · {fmtBytes(row.bytes ?? 0)}</span>
      </div>
      <div className="sec">
        <div className="sec-h">Rollup</div>
        <dl className="kv">
          <dt>refs</dt>
          <dd className="num">{row.n_refs} · {row.files ?? "?"} files · {fmtBytes(row.bytes ?? 0)}</dd>
          <dt>produced by</dt>
          <dd>
            {producers.size === 1 ? (
              <a className="id plain" title="the producing run's page"
                 onClick={() => {
                   const t = [...producers][0]!;
                   navigate(t.startsWith("krn_") ? ["jobs", "kernels", t] : ["jobs", t]);
                 }}>
                {[...producers][0]}
              </a>
            ) : (
              `${producers.size} runs in this campaign`
            )}
          </dd>
          <dt>local</dt>
          <dd className="num">{row.n_local}/{row.n_refs} refs have workspace copies</dd>
        </dl>
        <div className="faint small" style={{ marginTop: 4 }}>
          these are the campaign&apos;s result files (declared outputs=, registered as datasets at completion —
          identity by content is what lets later tasks consume them by ref, verified); pick one for its copies and contents
        </div>
      </div>
      <div className="sec">
        <div className="sec-h">Members — biggest first</div>
        {kids.slice(0, 60).map((k) => (
          <div className="row small" key={k.ref} style={{ gap: 8, padding: "1.5px 0" }}>
            <a className="id plain mono"
               style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
               title={`${k.rel ?? "(path not recorded)"} — ${k.kind === "tree" ? "folder" : "file"} — ${k.ref}`}
               onClick={() => navigate(["data", k.ref], { replace: true })}>
              {k.rel ?? k.ref.slice(5, 17) + "…"}
            </a>
            {k.kind === "tree" && (
              <span className="chip quiet" title="a whole folder of files under one ref (weft calls it a tree)">folder</span>
            )}
            {k.local && <span className="loc-chip">● local</span>}
            <span className="right-al num dim">{k.bytes != null ? fmtBytes(k.bytes) : ""}</span>
            <a className="frow-act" title="the dataset's copies, contents, and actions"
               onClick={() => navigate(["data", k.ref], { replace: true })}>open</a>
          </div>
        ))}
        {kids.length > 60 && (
          <div className="faint small">first 60 of {kids.length} — narrow with search</div>
        )}
      </div>
    </div>
  );
}

const QUIET_S = 30 * 24 * 3600; // untouched this long → the group starts collapsed

/** CAMPAIGN face (M11.3a): the middle layer of threads → campaigns →
 * runs/files. One label's whole story: its runs, its data rows, and the
 * footprint of everything it occupies. Chats that drove it arrive with
 * the declaration flow (M11.3b). */
function CampaignFace({ label, rows }: { label: string; rows: DataIndexRow[] }) {
  const { jobs, kernels, now } = useApp();
  const runs = useMemo(() => {
    const js = [...jobs.values()]
      .filter((j) => j.label === label && !j.superseded_by)
      .map((j) => ({ id: j.job_id, kind: "job" as const, state: j.state,
                     site: j.site, when: j.updated_at }));
    const ks = kernels
      .filter((k) => k.label === label)
      .map((k) => ({ id: k.kernel_id, kind: "kernel" as const, state: k.state,
                     site: k.site, when: k.last_used }));
    return [...js, ...ks].sort((a, b) => (b.when ?? 0) - (a.when ?? 0));
  }, [jobs, kernels, label]);
  const kids = rows.filter((r) => (r.campaign || "unlabeled") === label);
  const lastTouch = Math.max(...runs.map((r) => r.when ?? 0),
                             ...kids.map((r) => r.when ?? 0), 0);
  const quiet = lastTouch > 0 && now - lastTouch > QUIET_S;
  const [showRuns, setShowRuns] = useState(false);
  const shownRuns = showRuns ? runs : runs.slice(0, 10);

  return (
    <div className="card detail">
      <div className="pane-h">
        <span className="pill s-queued"
              title="a campaign: every run and file wearing this label — one piece of work">
          CAMPAIGN
        </span>
        <b style={{ fontSize: 12.5 }}>{label}</b>
        <span className="dim small">
          {runs.length} run{runs.length === 1 ? "" : "s"}
          {lastTouch > 0 && <> · {quiet ? "quiet since" : "last touched"} {fmtWhen(lastTouch)}</>}
        </span>
        <div className="dim small" style={{ flexBasis: "100%" }}>
          one piece of work, wherever it lives — the runs that did it, the files that
          resulted, and what it all occupies
        </div>
      </div>

      <div className="sec">
        <div className="sec-h">Runs</div>
        {!runs.length && <span className="dim small">no runs wear this label (keeps only)</span>}
        {shownRuns.map((r) => (
          <div className="row small" key={r.id} style={{ gap: 8, padding: "1.5px 0" }}>
            <span className="dim" style={{ width: 62 }}>{String(r.state).toLowerCase()}</span>
            <a className="id plain mono" title={r.kind === "kernel" ? "the kernel's page" : "the run's page"}
               onClick={() => navigate(r.kind === "kernel" ? ["jobs", "kernels", r.id] : ["jobs", r.id])}>
              {r.id}
            </a>
            <a className="id plain" title="the site's page"
               onClick={() => navigate(["compute", r.site])}>{r.site}</a>
            <span className="right-al num dim">{fmtWhen(r.when ?? undefined)}</span>
          </div>
        ))}
        {runs.length > shownRuns.length && (
          <a className="id plain small" onClick={() => setShowRuns(true)}>
            show all {runs.length}
          </a>
        )}
      </div>

      <div className="sec">
        <div className="sec-h">Data</div>
        {!kids.length && <span className="dim small">no data rows under this label</span>}
        {kids.slice(0, 12).map((r) => (
          <div className="row small" key={r.id} style={{ gap: 8, padding: "1.5px 0" }}>
            <span className={`pill ${TIER_PILL[r.tier].cls}`}
                  title={TIER_PILL[r.tier].title}>{TIER_PILL[r.tier].word}</span>
            <a className="id plain" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 210 }}
               onClick={() => navigate(["data", r.id], { replace: true })}>{r.name}</a>
            <span className="right-al num dim">
              {r.files != null ? `${r.files} · ` : ""}{fmtBytes(r.bytes ?? 0)}
            </span>
          </div>
        ))}
        {kids.length > 12 && (
          <div className="faint small">first 12 of {kids.length} — the table groups them all</div>
        )}
      </div>

      <FootprintCard scope={`campaign:${label}`} showRunNames />
    </div>
  );
}

export function DataPage() {
  const { sites, data, cursor } = useApp();
  const route = useRoute(); // ["data", id?, rel?] — rel = a file to auto-open
  const sel = route[1] ?? null;
  const selRel = route[2] ?? null;

  const [q, setQ] = useState("");
  const [tiers, setTiers] = useState<Set<string>>(new Set());
  const [localOnly, setLocalOnly] = useState(false);
  const [site, setSite] = useState("any");

  // entry intent: #/data/at:<site> presets the site filter (Compute's
  // "data here →" lands here), then the URL normalizes to #/data
  useEffect(() => {
    if (sel?.startsWith("at:")) {
      setSite(sel.slice(3));
      navigate(["data"], { replace: true });
    }
  }, [sel]);
  const [group, setGroup] = useState<Group>("campaign");
  const [idx, setIdx] = useState<DataIndexResponse | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const fetchSeq = useRef(0);

  const refetch = useCallback((fresh = false) => {
    const seq = ++fetchSeq.current;
    void api
      .dataIndex({
        q: q.trim() || undefined,
        tier: tiers.size ? [...tiers].join(",") : undefined,
        site: site !== "any" ? site : undefined,
        local: localOnly,
        fresh,
      })
      .then((r) => {
        if (seq === fetchSeq.current) setIdx(r);
      });
  }, [q, tiers, site, localOnly]);

  // params → debounced fetch (cache-friendly); SSE cursor bumps trail
  // behind with fresh=1 so post-action truth lands, not the TTL echo
  useEffect(() => {
    const t = setTimeout(refetch, 250);
    return () => clearTimeout(t);
  }, [refetch]);
  // through a ref: a cursor-trailing refetch must honor filters set AFTER
  // the bump (a stale closure here silently un-filters the view)
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  useEffect(() => {
    const t = setTimeout(() => refetchRef.current(true), 1200);
    return () => clearTimeout(t);
  }, [cursor]);

  const sorter = useSort();
  const groups = useMemo(() => {
    const m = new Map<string, DataIndexRow[]>();
    for (const r of idx?.rows ?? []) {
      const k = groupKey(r, group);
      m.get(k)?.push(r) ?? m.set(k, [r]);
    }
    const keys = {
      name: (r: DataIndexRow) => r.name,
      files: (r: DataIndexRow) => r.files ?? null,
      bytes: (r: DataIndexRow) => r.bytes ?? null,
      when: (r: DataIndexRow) => r.when ?? null,
    };
    return [...m.entries()]
      .map(([k, rows]) => [k, sortRows(rows, sorter.sort, keys)] as const)
      .sort(
        (a, b) =>
          b[1].reduce((n, r) => n + (r.bytes ?? 0), 0) -
          a[1].reduce((n, r) => n + (r.bytes ?? 0), 0),
      );
  }, [idx, group, sorter.sort]);

  // groups untouched for a month start collapsed (once, on first load) —
  // a year of campaigns must not bury this week's work; searching
  // force-opens everything (collapsed hits would lie)
  const quietSeeded = useRef(false);
  useEffect(() => {
    if (quietSeeded.current || !idx || q.trim()) return;
    quietSeeded.current = true;
    const nowS = Date.now() / 1000;
    const quiet = new Set<string>();
    for (const [g, rows] of groups)
      if (g && rows.every((r) => (r.when ?? 0) < nowS - QUIET_S)) quiet.add(g);
    if (quiet.size) setClosed(quiet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, groups]);

  const toggleTier = (t: string) =>
    setTiers((old) => {
      const next = new Set(old);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const selRow = idx?.rows.find((r) => r.id === sel);
  const selDataset = sel?.startsWith("dref:") ? data.find((d) => d.ref === sel) : undefined;
  const counts = idx?.counts;

  // filter-scoped mirror lever: every SHOWN dataset ref without a live
  // workspace copy — rollup members included (keeps/remains mirror
  // per-file via their detail)
  const fetchable = useMemo(() => {
    const refs: { ref: string; bytes: number }[] = [];
    for (const r of idx?.rows ?? []) {
      if (r.tier === "dataset" && !r.local) refs.push({ ref: r.id, bytes: r.bytes ?? 0 });
      else if (r.tier === "outputs")
        for (const k of r.outputs ?? [])
          if (!k.local) refs.push({ ref: k.ref, bytes: k.bytes ?? 0 });
    }
    return refs;
  }, [idx]);
  const fetchableBytes = fetchable.reduce((n, r) => n + r.bytes, 0);
  const [confirmFetch, setConfirmFetch] = useState(false);
  const [fetching, setFetching] = useState<string | null>(null);

  const bulkFetch = async () => {
    setConfirmFetch(false);
    let failed = 0;
    for (let i = 0; i < fetchable.length; i++) {
      setFetching(`${i + 1}/${fetchable.length}`);
      const r = fetchable[i];
      const out = await wtool<{ error?: string }>("data_fetch", {
        ref: r.ref, to_path: `data/${r.ref.slice(5, 17)}`,
      });
      if (out.error) failed++;
    }
    setFetching(null);
    store.toast(failed ? "err" : "ok",
      failed
        ? `${fetchable.length - failed} fetched, ${failed} failed — see Activity`
        : `${fetchable.length} datasets fetched → workspace/data/ (hash-verified)`);
    void store.refreshData();
    refetch(true);
  };

  return (
    <>
      <div className="row wrap" style={{ padding: "10px 14px 4px", gap: 8 }}>
        <span className="search" style={{ width: 260 }}>
          <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="9" cy="9" r="5.5" />
            <path d="m13.5 13.5 4 4" strokeLinecap="round" />
          </svg>
          <input
            placeholder="search names, labels, refs — and files inside"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </span>
        {(["dataset", "keep", "remains"] as const).map((t) => (
          <span
            key={t}
            className={`chip fchip${!tiers.size || tiers.has(t) ? " on" : ""}`}
            title={TIER_PILL[t].title}
            onClick={() => toggleTier(t)}
          >
            {t === "remains" ? "remains" : `${t}s`}{" "}
            <span className="n">{counts ? counts[t] : "…"}</span>
          </span>
        ))}
        <span
          className={`chip fchip${localOnly ? " on" : ""}`}
          title="objects with a live copy in the controller's workspace — your local mirror coverage"
          onClick={() => setLocalOnly(!localOnly)}
        >
          local <span className="n">{counts ? `${counts.local} · ${fmtBytes(counts.local_bytes)}` : "…"}</span>
        </span>
        <select className="filter-select" value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="any">site: any</option>
          {sites.map((s) => (
            <option key={s.name} value={s.name}>{s.name}</option>
          ))}
        </select>
        <select className="filter-select" value={group} onChange={(e) => setGroup(e.target.value as Group)}
                title="grouping is a lens over the same rows — campaign for the science view, site for the operator view">
          <option value="campaign">group: campaign</option>
          <option value="site">group: site</option>
          <option value="producer">group: producer</option>
          <option value="none">group: none</option>
        </select>
        <span className="right-al">
          <Api>⌁ uiapi /data/index — the store IS the index; no site round-trips</Api>
        </span>
      </div>

      <div className="split">
        <div className="card tablecard" style={{ paddingBottom: 10 }}>
          <div className="row" style={{ padding: "10px 14px 2px", gap: 10 }}>
            <b style={{ fontSize: 12.5 }}>
              {idx ? `${idx.total} rows · ${fmtBytes(idx.bytes_shown)}` : "reading the index…"}
            </b>
            {idx && (
              <span className="dim small">
                {new Set(idx.rows.map((r) => r.campaign || "unlabeled")).size} campaigns ·{" "}
                {new Set(idx.rows.flatMap((r) => r.sites)).size} sites
              </span>
            )}
            {q.trim() && idx && (
              <span className="dim small">
                {idx.rows.reduce((n, r) => n + (r.hit_total ?? 0), 0)} file hits
              </span>
            )}
            {idx?.truncated && <span className="dim small">first 500 shown — narrow the filters</span>}
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 74 }}>Tier</th>
                <Th k="name" sort={sorter.sort} onSort={sorter.toggle}>Name</Th>
                <th>Where</th>
                <Th k="files" first="desc" className="r" sort={sorter.sort} onSort={sorter.toggle}>Files</Th>
                <Th k="bytes" first="desc" className="r" sort={sorter.sort} onSort={sorter.toggle}>Size</Th>
                <Th k="when" first="desc" className="r" sort={sorter.sort} onSort={sorter.toggle}>When</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map(([g, rows]) => (
                <GroupRows
                  key={g || "(all)"}
                  label={g}
                  rows={rows}
                  onOpen={group === "campaign" && g && g !== "unlabeled"
                    ? () => navigate(["data", `campaign:${g}`], { replace: true })
                    : undefined}
                  collapsed={!q.trim() && closed.has(g)}
                  onToggle={() =>
                    setClosed((old) => {
                      const next = new Set(old);
                      if (next.has(g)) next.delete(g);
                      else next.add(g);
                      return next;
                    })
                  }
                  selected={sel}
                  onSelect={(id) => navigate(["data", id], { replace: true })}
                  q={q.trim()}
                />
              ))}
              {idx && !idx.rows.length && (
                <tr>
                  <td colSpan={6} className="dim" style={{ padding: 24, textAlign: "center" }}>
                    nothing matches — data appears here as runs record inventories, retains hold files, and refs register
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {fetchable.length > 0 && (
            <div className="row" style={{ padding: "8px 14px 0", gap: 10, alignItems: "center" }}>
              {fetching ? (
                <span className="small">fetching {fetching}… <span className="dim">(hash-verified on arrival; evicted copies re-obtain from keeps)</span></span>
              ) : !confirmFetch ? (
                <button
                  className="btn sm"
                  title="pull a workspace copy of every dataset the current filters show — the local-mirror lever; a bookmarked filter + this button IS a mirror"
                  onClick={() => setConfirmFetch(true)}
                >
                  Fetch {fetchable.length} shown → workspace ({fmtBytes(fetchableBytes)})…
                </button>
              ) : (
                <>
                  <button className="btn sm primary" onClick={() => void bulkFetch()}>
                    Confirm — fetch {fetchable.length} ({fmtBytes(fetchableBytes)})
                  </button>
                  <a className="id plain small" onClick={() => setConfirmFetch(false)}>cancel</a>
                </>
              )}
              <span className="right-al"><Api>data_fetch</Api></span>
            </div>
          )}
          <RegisterDisclose sites={sites} onChanged={() => void store.refreshData()} />
        </div>

        {sel?.startsWith("campaign:") ? (
          <CampaignFace label={sel.slice(9)} rows={idx?.rows ?? []} />
        ) : selRow?.tier === "outputs" ? (
          <OutputsFace row={selRow} />
        ) : selRow?.tier === "dataset" || selDataset ? (
          selDataset ? (
            <DataDetail d={selDataset} onChanged={() => void store.refreshData()} openRel={selRel} />
          ) : (
            <div className="card detail">
              <div className="empty-detail">this ref is not in the workspace record anymore</div>
            </div>
          )
        ) : sel && !sel.startsWith("dref:") ? (
          <RunDataFace target={sel} row={selRow} openRel={selRel} />
        ) : (
          <div className="card detail">
            <div className="empty-detail">
              select an object — datasets show copies and contents; keeps and remains show their files
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const GROUP_ROW_CAP = 12; // an array pipeline mints dozens of sibling
                          // output refs — cap keeps every group scannable

function GroupRows({
  label,
  rows,
  collapsed,
  onToggle,
  selected,
  onSelect,
  q,
  onOpen,
}: {
  label: string;
  rows: DataIndexRow[];
  collapsed: boolean;
  onToggle: () => void;
  selected: string | null;
  onSelect: (id: string) => void;
  q: string;
  /** campaign grouping: the header links to the campaign's face */
  onOpen?: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const bytes = rows.reduce((n, r) => n + (r.bytes ?? 0), 0);
  const nLocal = rows.filter((r) => r.local).length;
  // keep the selected row visible even when the cap would hide it
  const shown =
    showAll || rows.length <= GROUP_ROW_CAP
      ? rows
      : rows.slice(0, GROUP_ROW_CAP).concat(
          rows.slice(GROUP_ROW_CAP).filter((r) => r.id === selected));
  return (
    <>
      {label && (
        <tr className="grp-row" onClick={onToggle} style={{ cursor: "pointer" }}>
          <td colSpan={6}>
            <span className="chev" style={{ marginRight: 5 }}>{collapsed ? "▸" : "▾"}</span>
            <b>{label}</b>
            {onOpen && (
              <a className="id plain small" style={{ marginLeft: 8 }}
                 title="the campaign's page — its runs, its data, its footprint"
                 onClick={(e) => { e.stopPropagation(); onOpen(); }}>
                open →
              </a>
            )}
            <span className="right-al num dim small" style={{ float: "right" }}>
              {rows.length} object{rows.length === 1 ? "" : "s"} · {fmtBytes(bytes)}
              {nLocal > 0 && ` · ${nLocal} local`}
            </span>
          </td>
        </tr>
      )}
      {!collapsed &&
        shown.map((r) => (
          <Row key={r.id} r={r} groupLabel={label} selected={selected === r.id} onSelect={() => onSelect(r.id)} q={q} />
        ))}
      {!collapsed && shown.length < rows.length && (
        <tr>
          <td />
          <td colSpan={5} style={{ padding: "3px 8px" }}>
            <a className="id plain small" onClick={() => setShowAll(true)}>
              show all {rows.length}
            </a>
          </td>
        </tr>
      )}
    </>
  );
}

function Row({ r, groupLabel, selected, onSelect, q }: { r: DataIndexRow; groupLabel: string; selected: boolean; onSelect: () => void; q: string }) {
  const pill = TIER_PILL[r.tier];
  // inside its campaign group, repeating the campaign in every row name
  // is noise — an exact echo reads as the row's ROLE instead
  const ROLE: Record<string, string> = {
    outputs: "outputs", remains: "the run", keep: "the keep", dataset: r.name,
  };
  const name =
    groupLabel && r.name === groupLabel
      ? ROLE[r.tier]
      : groupLabel && r.name.startsWith(groupLabel)
        ? r.name.slice(groupLabel.length).replace(/^\s*·\s*/, "") || r.name
        : r.name;
  return (
    <>
      <tr data-rowid={r.id} className={selected ? "sel" : undefined} onClick={onSelect}>
        <td><span className={`pill ${pill.cls}`} title={pill.title}>{pill.word}</span></td>
        <td className="name-cell" title={`${r.name} — ${r.id}`}>
          <span style={{ fontSize: 12 }}>{name}</span>{" "}
          {r.tier === "outputs" ? (
            <span className="chip quiet">{r.n_refs} refs</span>
          ) : (
            <span className="mono faint">
              {r.tier === "dataset" ? r.id.slice(5, 15) + "…" : r.id}
            </span>
          )}
          {r.kind === "tree" && (
            <span className="chip quiet" style={{ marginLeft: 4 }}
                  title="a whole folder of files under one ref (weft calls it a tree)">folder</span>
          )}
        </td>
        <td className="where-cell">{whereCell(r)}</td>
        <td className="r num">{r.files ?? "—"}</td>
        <td className="r num">{r.bytes != null ? fmtBytes(r.bytes) : "—"}</td>
        <td className="r num dim">{fmtWhen(r.when ?? undefined)}</td>
      </tr>
      {q &&
        (r.hits ?? []).map((h) => (
          <tr key={h.rel} className="hit-row" style={{ cursor: "pointer" }}
              title="open the object with this file in view"
              onClick={() => navigate(["data", r.id, h.rel], { replace: true })}>
            <td />
            <td colSpan={5} style={{ padding: "3.5px 8px" }}>
              <span className="row" style={{ gap: 9, alignItems: "center" }}>
                <span className="faint" style={{ fontSize: 10 }}>↳</span>
                <a className="id plain mono small">{h.rel}</a>
                {(r.local_rels?.includes(h.rel) || (r.tier === "dataset" && r.local)) && (
                  <span className="loc-chip" title="a copy lives in the workspace">● local</span>
                )}
                <span className="right-al num dim small">{fmtBytes(h.bytes)}</span>
              </span>
            </td>
          </tr>
        ))}
      {q && (r.hit_total ?? 0) > (r.hits?.length ?? 0) && (
        <tr className="hit-row">
          <td />
          <td colSpan={5} className="faint small" style={{ padding: "2px 8px 4px 30px" }}>
            +{(r.hit_total ?? 0) - (r.hits?.length ?? 0)} more matching files — open the object
          </td>
        </tr>
      )}
    </>
  );
}
