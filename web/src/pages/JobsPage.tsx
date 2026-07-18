/**
 * Jobs panel (mockup 01): load header, transfers strip, three tabs —
 * jobs (array-digest rows), kernels (transcript notebooks), services
 * (tunneled endpoints) — each with a sticky detail pane; provenance is a
 * focused full-width view. Keyboard: j/k navigate the active tab, ⏎
 * opens, / searches.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobRow, KernelRow, RetainedRun, ServiceRow } from "@shared/types";
import { TERMINAL_STATES } from "@shared/types";
import { Api, elapsed, ErrorChip, fmtAsk, fmtBytes, fmtClock, fmtDur, fmtWhen, GradeChip, Pill, sortRows, Th, useSort } from "../bits";
import type { SortState } from "../bits";
import { CountsLine, DigestBar, groupCounts, type GroupRow } from "../components/ArrayDetail";
import { ArrayDetail } from "../components/ArrayDetail";
import { envMatches, EnvsSplit, occupying } from "../components/EnvDetail";
import { dataMatches, DataSplit, dataSortKeys } from "../components/DataSplit";
import { BundleImport } from "../components/BundleImport";
import { JobDetail } from "../components/JobDetail";
import { KernelDetail, KernelPill } from "../components/KernelDetail";
import { LoadStrip } from "../components/LoadStrip";
import { ProvenanceView } from "../components/ProvenanceView";
import { retainedMatches, RetainedSplit } from "../components/RetainedSplit";
import { ServiceDetail, ServicePill } from "../components/ServiceDetail";
import { navigate, useRoute } from "../router";
import { store, useApp } from "../state";
import { wtool } from "../api/client";

type Tab = "jobs" | "kernels" | "services" | "envs" | "retained" | "data";

type Row =
  | { kind: "job"; id: string; job: JobRow; sortKey: number }
  | { kind: "group"; id: string; group: GroupRow; sortKey: number };

function buildRows(jobs: ReadonlyMap<string, JobRow>): Row[] {
  const singles: JobRow[] = [];
  const groups = new Map<string, JobRow[]>();
  const supersededByGroup = new Map<string, number>();
  for (const j of jobs.values()) {
    if (j.superseded_by) {
      // a retried element's old row: folded under the group's history,
      // never a top-level "duplicate". The old row is detached from the
      // group upstream, so attribute it via its successor.
      const group = j.array_group ?? jobs.get(j.superseded_by)?.array_group;
      if (group) supersededByGroup.set(group, (supersededByGroup.get(group) ?? 0) + 1);
      continue;
    }
    if (j.array_group) {
      const g = groups.get(j.array_group) ?? [];
      g.push(j);
      groups.set(j.array_group, g);
    } else singles.push(j);
  }
  const rows: Row[] = singles.map((j) => ({ kind: "job", id: j.job_id, job: j, sortKey: j.created_at }));
  for (const [gid, els] of groups) {
    const counts = groupCounts(els);
    const active = counts.running + counts.queued + counts.other > 0;
    const state = active ? "RUNNING" : counts.failed ? "FAILED" : "DONE";
    rows.push({
      kind: "group",
      id: gid,
      group: {
        group: gid,
        site: els[0].site,
        elements: els,
        counts,
        state,
        superseded: supersededByGroup.get(gid) ?? 0,
      },
      sortKey: Math.min(...els.map((e) => e.created_at)),
    });
  }
  return rows.sort((a, b) => b.sortKey - a.sortKey);
}

function rowMatches(row: Row, q: string, state: string, site: string): boolean {
  const jobs = row.kind === "job" ? [row.job] : row.group.elements;
  if (site !== "any" && jobs[0].site !== site) return false;
  if (state !== "any") {
    const s = row.kind === "job" ? row.job.state : row.group.state;
    if (state === "active" ? TERMINAL_STATES.has(s) : s !== state) return false;
  }
  if (q) {
    const hay = `${row.id} ${jobs[0].site} ${jobs[0].task.command} ${jobs[0].label ?? ""}`.toLowerCase();
    if (!hay.includes(q.toLowerCase())) return false;
  }
  return true;
}

function TransfersStrip() {
  const { transfers } = useApp();
  const active = [...transfers.values()];
  if (!active.length) return null;
  return (
    <div className="xfer-strip">
      <span className="faint" style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em" }}>
        TRANSFERS
      </span>
      {active.map((t) => (
        <span className="xfer" key={t.jobId}>
          → {t.site}
          <span
            className="prog"
            title={
              t.done
                ? "staging complete"
                : `${Math.round((100 * t.bytesDone) / Math.max(t.bytesTotal, 1))}% staged to ${t.site}`
            }
          >
            <b
              className={t.done ? "p-done" : "p-running"}
              style={{ width: `${(100 * t.bytesDone) / Math.max(t.bytesTotal, 1)}%` }}
            />
          </span>
          <span className="num dim">
            {t.done
              ? `${fmtBytes(t.bytesTotal)} · done`
              : `${fmtBytes(t.bytesDone)} of ${fmtBytes(t.bytesTotal)}` +
                (t.rateMbps ? ` · ${t.rateMbps.toFixed(0)} MB/s · ETA ${fmtDur(t.etaS)}` : "")}
          </span>
          <span className="faint">for</span> <span className="id">{t.jobId}</span>
        </span>
      ))}
      <span className="right-al">
        <Api>transfer.progress</Api>
      </span>
    </div>
  );
}

function Ticker() {
  const { ticker } = useApp();
  if (!ticker.length) return null;
  return (
    <div className="ticker">
      <span className="faint" style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em" }}>
        EVENTS
      </span>
      {ticker.slice(0, 4).map((ev) => (
        <span className="ev" key={ev.seq}>
          <b>{fmtClock(ev.ts)}</b> {ev.kind}{" "}
          {(ev.label as string) ??
            ev.job_id ??
            (ev.kernel as string) ??
            (ev.service as string) ??
            (ev.site as string) ??
            ""}{" "}
          {(ev.state as string) ?? ""}
        </span>
      ))}
      <span className="right-al" style={{ flex: "none" }}>
        <Api>GET /api/events (SSE)</Api>
      </span>
    </div>
  );
}

function AskCell({ job }: { job: JobRow }) {
  if (job.state === "FAILED" && job.error) return <ErrorChip err={job.error} />;
  if (job.state === "DONE" && job.manifest)
    return <GradeChip grade={job.manifest.reproducibility} />;
  if (job.state === "CANCELLED")
    return <span className="dim small">cancelled {fmtWhen(job.updated_at)}</span>;
  return <span className="nowrap dim">{fmtAsk(job.task.resources)}</span>;
}

function kernelMatches(k: KernelRow, q: string, site: string): boolean {
  if (site !== "any" && k.site !== site) return false;
  if (!q) return true;
  return `${k.kernel_id} ${k.lang} ${k.site} ${k.env_id ?? ""} ${k.state} ${k.label ?? ""}`
    .toLowerCase()
    .includes(q.toLowerCase());
}

function serviceMatches(s: ServiceRow, q: string, site: string): boolean {
  if (site !== "any" && s.site !== site) return false;
  if (!q) return true;
  return `${s.service_id} ${s.site} ${s.task.command} ${s.ports.join(" ")} ${s.state}`
    .toLowerCase()
    .includes(q.toLowerCase());
}

export function JobsPage() {
  const { jobs, sites, now, stagedBytes, kernels, services, envs, envSites, data } = useApp();
  // page/tab/selection live in the URL (R1): #/jobs/kernels/krn_x is a
  // deep link a host app can open directly. Selection changes replace
  // history (j/k must not spam it); tab moves and cross-object jumps push.
  const route = useRoute();
  const prov = route[0] === "provenance" ? (route[1] ?? null) : null;
  const SUBTABS = ["kernels", "services", "envs", "retained", "data"] as const;
  const tab: Tab =
    route[0] === "jobs" && (SUBTABS as readonly string[]).includes(route[1]) ? (route[1] as Tab) : "jobs";
  const selected = route[0] === "jobs" && tab === "jobs" ? (route[1] ?? null) : null;
  const selKernel = tab === "kernels" ? (route[2] ?? null) : null;
  const selService = tab === "services" ? (route[2] ?? null) : null;
  const selEnv = tab === "envs" ? (route[2] ?? null) : null;
  const selData = tab === "data" ? (route[2] ?? null) : null;
  const setTab = (t: Tab) => navigate(["jobs", t === "jobs" ? null : t]);
  const setSelected = (id: string | null) => navigate(["jobs", id], { replace: true });
  const setSelKernel = (id: string | null) => navigate(["jobs", "kernels", id], { replace: true });
  const setSelService = (id: string | null) => navigate(["jobs", "services", id], { replace: true });
  const setSelEnv = (id: string | null) => navigate(["jobs", "envs", id], { replace: true });
  const setSelData = (id: string | null) => navigate(["jobs", "data", id], { replace: true });
  // remember the jobs-tab selection so "◂ jobs" from provenance restores it
  const lastJobsSel = useRef<string | null>(null);
  if (selected) lastJobsSel.current = selected;
  const setProv = (target: string | null) =>
    target ? navigate(["provenance", target]) : navigate(["jobs", lastJobsSel.current]);
  const [q, setQ] = useState("");
  const [stateFilter, setStateFilter] = useState("any");
  const [siteFilter, setSiteFilter] = useState("any");
  const searchRef = useRef<HTMLInputElement>(null);
  // one sort per tab (header-click; also the j/k walking order)
  const jobSort = useSort();
  const kernelSort = useSort();
  const serviceSort = useSort();
  const envSort = useSort();
  const dataSort = useSort();

  const { ticker } = useApp();
  const [retained, setRetained] = useState<RetainedRun[]>([]);
  const refetchRetained = useCallback(() => {
    void wtool<RetainedRun[]>("retained_runs", {}).then(
      (r) => Array.isArray(r) && setRetained(r),
      () => undefined, // transient failure: keep the last good list
    );
  }, []);
  useEffect(refetchRetained, [refetchRetained]);
  const lastRetainEv = ticker.find((e) => e.kind.startsWith("retain."))?.seq;
  useEffect(() => {
    if (lastRetainEv != null) refetchRetained();
  }, [lastRetainEv, refetchRetained]);

  const rows = useMemo(() => buildRows(jobs), [jobs]);
  const visible = useMemo(
    () =>
      sortRows(rows.filter((r) => rowMatches(r, q, stateFilter, siteFilter)), jobSort.sort, {
        state: (r) => (r.kind === "job" ? r.job.state : r.group.state),
        job: (r) =>
          r.kind === "job" ? (r.job.label ?? r.job.job_id) : (r.group.elements[0].label ?? r.group.group),
        site: (r) => (r.kind === "job" ? r.job.site : r.group.site),
        command: (r) => (r.kind === "job" ? r.job.task.command : r.group.elements[0].task.command),
        elapsed: (r) =>
          r.kind === "job"
            ? (TERMINAL_STATES.has(r.job.state) ? r.job.updated_at : now) - r.job.created_at
            : Math.max(...r.group.elements.map((e) => e.updated_at)) -
              Math.min(...r.group.elements.map((e) => e.created_at)),
        staged: (r) => (r.kind === "job" ? (stagedBytes.get(r.job.job_id) ?? null) : null),
      }),
    [rows, q, stateFilter, siteFilter, jobSort.sort, now, stagedBytes],
  );
  const visKernels = useMemo(
    () =>
      sortRows([...kernels].reverse().filter((k) => kernelMatches(k, q, siteFilter)), kernelSort.sort, {
        state: (k) => k.state,
        kernel: (k) => k.label || k.lang,
        site: (k) => k.site,
        env: (k) => k.env_id ?? null,
        blocks: (k) => k.blocks_run,
        // ordering by "idle for" == reverse ordering by last_used (running only)
        idle: (k) => (k.state === "running" ? -k.last_used : null),
        started: (k) => k.created_at,
      }),
    [kernels, q, siteFilter, kernelSort.sort],
  );
  const visServices = useMemo(
    () =>
      sortRows([...services].reverse().filter((s) => serviceMatches(s, q, siteFilter)), serviceSort.sort, {
        state: (s) => s.state,
        service: (s) => s.task.label ?? s.service_id,
        site: (s) => s.site,
        command: (s) => s.task.command,
        ports: (s) => s.ports[0] ?? null,
        up: (s) => s.created_at,
      }),
    [services, q, siteFilter, serviceSort.sort],
  );
  // site facet: an env is "on" a site while a realization occupies space
  // there (ready/building/failed — evicted and missing don't). With a site
  // selected, biggest-on-that-site first: the reclaim-space ordering.
  // Search covers name, id, platforms, and occupying sites.
  const visRetained = useMemo(
    () => retained.filter((r) => retainedMatches(r, q, siteFilter)),
    [retained, q, siteFilter],
  );
  const visEnvs = useMemo(() => {
    const bytesOn = (envId: string, site: string) =>
      occupying(envSites.get(envId))
        .filter((r) => site === "any" || r.site === site)
        .reduce((s, r) => s + (r.bytes ?? 0), 0);
    const jobCount = new Map<string, number>();
    for (const j of jobs.values())
      if (j.task.env) jobCount.set(j.task.env, (jobCount.get(j.task.env) ?? 0) + 1);
    const list = envs.filter(
      (e) =>
        envMatches(e, q, envSites.get(e.env_id)) &&
        (siteFilter === "any" || occupying(envSites.get(e.env_id)).some((r) => r.site === siteFilter)),
    );
    const ordered =
      siteFilter === "any"
        ? list
        : [...list].sort((a, b) => bytesOn(b.env_id, siteFilter) - bytesOn(a.env_id, siteFilter));
    return sortRows(ordered, envSort.sort, {
      env: (e) => e.name ?? "unnamed",
      // "Sites" orders by occupied bytes (on the filtered site when one is set)
      sites: (e) => bytesOn(e.env_id, siteFilter),
      jobs: (e) => jobCount.get(e.env_id) ?? 0,
      created: (e) => e.created_at,
    });
  }, [envs, envSites, jobs, q, siteFilter, envSort.sort]);
  const visData = useMemo(
    () => sortRows(data.filter((d) => dataMatches(d, q, siteFilter)), dataSort.sort, dataSortKeys()),
    [data, q, siteFilter, dataSort.sort],
  );

  // keyboard: j/k navigate the active tab, ⏎ opens (selection == open), / searches
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "j" || e.key === "k") {
        const ids =
          tab === "jobs"
            ? visible.map((r) => r.id)
            : tab === "kernels"
              ? visKernels.map((k) => k.kernel_id)
              : tab === "services"
                ? visServices.map((s) => s.service_id)
                : tab === "envs"
                  ? visEnvs.map((v) => v.env_id)
                  : tab === "data"
                    ? visData.map((d) => d.ref)
                    : [];
        const sel =
          tab === "jobs" ? selected : tab === "kernels" ? selKernel
            : tab === "services" ? selService : tab === "data" ? selData : selEnv;
        const setSel =
          tab === "jobs" ? setSelected : tab === "kernels" ? setSelKernel
            : tab === "services" ? setSelService : tab === "data" ? setSelData : setSelEnv;
        let idx = ids.indexOf(sel ?? "");
        if (idx === -1 && tab === "jobs" && selected) {
          // an array element is open — j/k re-enters the table at its group row
          const group = jobs.get(selected)?.array_group;
          if (group) idx = ids.indexOf(group);
        }
        const next = e.key === "j" ? Math.min(idx + 1, ids.length - 1) : Math.max(idx - 1, 0);
        if (ids[next]) {
          setSel(ids[next]);
          document
            .querySelector(`tr[data-rowid="${CSS.escape(ids[next])}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, visible, visKernels, visServices, visEnvs, visData, selected, selKernel, selService, selEnv, selData, jobs]);

  const selectedRow = visible.find((r) => r.id === selected);
  const selectedJob = !selectedRow && selected ? jobs.get(selected) : undefined;
  const unreachable = sites.filter((s) => s.health !== "ok");

  // provenance is a focused reading view — it replaces the table split
  if (prov)
    return (
      <>
        <LoadStrip />
        <ProvenanceView target={prov} onBack={() => setProv(null)} />
        <Ticker />
      </>
    );

  return (
    <>
      {unreachable.map((s) => (
        <div className="banner warn" key={s.name}>
          <b>{s.name} {s.health}</b>&nbsp;— submitted jobs live on the site’s scheduler; the
          poller keeps retrying
          <span className="act">
            <Api>site.unreachable</Api>
          </span>
        </div>
      ))}
      <LoadStrip />
      <TransfersStrip />

      <div className="toolbar">
        <span className="tabs">
          <a className={tab === "jobs" ? "on" : undefined} onClick={() => setTab("jobs")}>
            Jobs <span className="n">{visible.length}</span>
          </a>
          <a className={tab === "kernels" ? "on" : undefined} onClick={() => setTab("kernels")}>
            Kernels <span className="n">{tab === "kernels" ? visKernels.length : kernels.length}</span>
          </a>
          <a className={tab === "services" ? "on" : undefined} onClick={() => setTab("services")}>
            Services <span className="n">{tab === "services" ? visServices.length : services.length}</span>
          </a>
          <a className={tab === "envs" ? "on" : undefined} onClick={() => setTab("envs")}>
            Envs <span className="n">{tab === "envs" ? visEnvs.length : envs.length}</span>
          </a>
          <a className={tab === "retained" ? "on" : undefined} onClick={() => setTab("retained")}>
            Retained <span className="n">{tab === "retained" ? visRetained.length : retained.length}</span>
          </a>
          <a className={tab === "data" ? "on" : undefined} onClick={() => setTab("data")}>
            Data <span className="n">{tab === "data" ? visData.length : data.length}</span>
          </a>
        </span>
        <span className="search">
          <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="9" cy="9" r="5.5" />
            <path d="m13.5 13.5 4 4" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            placeholder="search command, id, site…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="kbd">/</span>
        </span>
        {tab === "jobs" && (
          <select className="filter-select" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="any">state: any</option>
            <option value="active">active</option>
            <option value="RUNNING">running</option>
            <option value="QUEUED">queued</option>
            <option value="FAILED">failed</option>
            <option value="DONE">done</option>
            <option value="CANCELLED">cancelled</option>
          </select>
        )}
        <select
          className="filter-select"
          value={siteFilter}
          title={tab === "envs" ? "envs with a realization occupying space on this site — biggest first" : undefined}
          onChange={(e) => setSiteFilter(e.target.value)}
        >
          <option value="any">site: any</option>
          {sites.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="kbd-hints">
          <span className="kbd">j</span>
          <span className="kbd">k</span> navigate · <span className="kbd">/</span> search
        </span>
      </div>

      {tab === "kernels" ? (
        <KernelsSplit
          kernels={visKernels}
          anyAtAll={kernels.length > 0}
          selected={selKernel}
          onSelect={setSelKernel}
          now={now}
          onOpenJob={(id) => navigate(["jobs", id])}
          sort={kernelSort.sort}
          onSort={kernelSort.toggle}
        />
      ) : tab === "services" ? (
        <ServicesSplit
          services={visServices}
          anyAtAll={services.length > 0}
          selected={selService}
          onSelect={setSelService}
          now={now}
          sort={serviceSort.sort}
          onSort={serviceSort.toggle}
        />
      ) : tab === "retained" ? (
        <RetainedSplit
          rows={visRetained}
          anyAtAll={retained.length > 0}
          sites={sites}
          onChanged={refetchRetained}
        />
      ) : tab === "data" ? (
        <DataSplit
          rows={visData}
          anyAtAll={data.length > 0}
          sites={sites}
          selected={selData}
          onSelect={setSelData}
          sort={dataSort.sort}
          onSort={dataSort.toggle}
          onChanged={() => void store.refreshData()}
        />
      ) : tab === "envs" ? (
        <EnvsSplit
          envs={visEnvs}
          anyAtAll={envs.length > 0}
          selected={selEnv}
          onSelect={setSelEnv}
          onOpenJob={(id) => navigate(["jobs", id])}
          sort={envSort.sort}
          onSort={envSort.toggle}
        />
      ) : (
      <div className="split">
        <div className="card tablecard">
          <table className="tbl">
            <thead>
              <tr>
                <Th k="state" sort={jobSort.sort} onSort={jobSort.toggle}>State</Th>
                <Th k="job" sort={jobSort.sort} onSort={jobSort.toggle}>Job</Th>
                <Th k="site" sort={jobSort.sort} onSort={jobSort.toggle}>Site</Th>
                <Th k="command" sort={jobSort.sort} onSort={jobSort.toggle}>Command</Th>
                <Th k="elapsed" first="desc" className="r" sort={jobSort.sort} onSort={jobSort.toggle}>Elapsed</Th>
                <Th k="staged" first="desc" className="r" sort={jobSort.sort} onSort={jobSort.toggle}>Staged</Th>
                <th title="mixed outcomes (asked resources, error, grade) — not sortable">Ask</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.id}
                  data-rowid={r.id}
                  className={selected === r.id ? "sel" : undefined}
                  onClick={() => setSelected(r.id)}
                >
                  {r.kind === "job" ? (
                    <>
                      <td>
                        <Pill state={r.job.state} />
                      </td>
                      <td>
                        {r.job.label ? (
                          <>
                            <span style={{ fontWeight: 500 }}>{r.job.label}</span>
                            <div className="arr-sub">
                              <a className="id plain">{r.job.job_id}</a>
                            </div>
                          </>
                        ) : (
                          <a className="id">{r.job.job_id}</a>
                        )}
                        {r.job.manifest && r.job.manifest.job_id !== r.job.job_id && (
                          <span className="memo" title="memoized — identical task_hash; manifest returned without re-running">
                            {" "}↺
                          </span>
                        )}
                      </td>
                      <td>{r.job.site}</td>
                      <td className="cmd" title={r.job.task.command}>
                        {r.job.task.command}
                      </td>
                      <td className="r num dim">{elapsed(r.job, now)}</td>
                      <td className="r num">{fmtBytes(stagedBytes.get(r.job.job_id) ?? null)}</td>
                      <td>
                        <AskCell job={r.job} />
                      </td>
                      <td></td>
                    </>
                  ) : (
                    <>
                      <td>
                        <Pill state={r.group.state} />
                      </td>
                      <td>
                        {r.group.elements[0].label ? (
                          <>
                            <span style={{ fontWeight: 500 }}>{r.group.elements[0].label}</span>
                            <div className="arr-sub">
                              <a className="id plain">{r.group.group}</a> · array ·{" "}
                              {r.group.elements.length.toLocaleString()} elements
                            </div>
                          </>
                        ) : (
                          <>
                            <a className="id">{r.group.group}</a>
                            <div className="arr-sub">array · {r.group.elements.length.toLocaleString()} elements</div>
                          </>
                        )}
                      </td>
                      <td>{r.group.site}</td>
                      <td className="cmd">
                        {r.group.elements[0].task.command}
                        <DigestBar counts={r.group.counts} total={r.group.elements.length} />
                        <CountsLine counts={r.group.counts} />
                      </td>
                      <td className="r num dim">
                        {fmtDur(
                          Math.max(...r.group.elements.map((e) => e.updated_at)) -
                            Math.min(...r.group.elements.map((e) => e.created_at)),
                        )}
                      </td>
                      <td className="r num">—</td>
                      <td>
                        <span className="nowrap dim">{fmtAsk(r.group.elements[0].task.resources, true)}</span>
                      </td>
                      <td></td>
                    </>
                  )}
                </tr>
              ))}
              {!visible.length && (
                <tr>
                  <td colSpan={8} className="dim" style={{ padding: 24, textAlign: "center" }}>
                    {jobs.size ? "nothing matches the filters" : "no jobs yet — submit one and it appears here live"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <BundleImport sites={sites} />
        </div>

        {selectedRow?.kind === "group" ? (
          <ArrayDetail row={selectedRow.group} onSelectJob={setSelected} />
        ) : selectedRow?.kind === "job" ? (
          <JobDetail job={selectedRow.job} onSelect={setSelected} onProvenance={setProv} />
        ) : selectedJob ? (
          <JobDetail job={selectedJob} onSelect={setSelected} onProvenance={setProv} />
        ) : (
          <div className="card detail">
            <div className="empty-detail">select a job to inspect it</div>
          </div>
        )}
      </div>
      )}

      <Ticker />
    </>
  );
}

function KernelsSplit({
  kernels,
  anyAtAll,
  selected,
  onSelect,
  onOpenJob,
  now,
  sort,
  onSort,
}: {
  kernels: KernelRow[];
  anyAtAll: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenJob: (jobId: string) => void;
  now: number;
  sort: SortState;
  onSort: (k: string, first?: "asc" | "desc") => void;
}) {
  const sel = kernels.find((k) => k.kernel_id === selected);
  return (
    <div className="split">
      <div className="card tablecard">
        <table className="tbl">
          <thead>
            <tr>
              <Th k="state" sort={sort} onSort={onSort}>State</Th>
              <Th k="kernel" sort={sort} onSort={onSort}>Kernel</Th>
              <Th k="site" sort={sort} onSort={onSort}>Site</Th>
              <Th k="env" sort={sort} onSort={onSort}>Environment</Th>
              <Th k="blocks" first="desc" className="r" sort={sort} onSort={onSort}>Blocks</Th>
              <Th k="idle" first="desc" className="r" sort={sort} onSort={onSort} title="longest idle first — running kernels only">Idle</Th>
              <Th k="started" first="desc" className="r" sort={sort} onSort={onSort}>Started</Th>
            </tr>
          </thead>
          <tbody>
            {kernels.map((k) => (
              <tr
                key={k.kernel_id}
                data-rowid={k.kernel_id}
                className={selected === k.kernel_id ? "sel" : undefined}
                onClick={() => onSelect(k.kernel_id)}
              >
                <td>
                  <KernelPill state={k.state} />
                </td>
                <td>
                  <span style={{ fontWeight: 500 }}>{k.label || k.lang}</span>
                  <div className="arr-sub">
                    <a className="id plain">{k.kernel_id}</a>
                    {k.label ? ` · ${k.lang}` : ""}
                  </div>
                </td>
                <td>{k.site}</td>
                <td>
                  {k.env_id ? (
                    <span className="id plain" title={k.env_id}>
                      {k.env_id.slice(0, 20)}…
                    </span>
                  ) : (
                    <span className="dim">bare</span>
                  )}
                </td>
                <td className="r num">{k.blocks_run}</td>
                <td className="r num dim">{k.state === "running" ? fmtDur(now - k.last_used) : "—"}</td>
                <td className="r num dim">{fmtWhen(k.created_at)}</td>
              </tr>
            ))}
            {!kernels.length && (
              <tr>
                <td colSpan={7} className="dim" style={{ padding: 24, textAlign: "center" }}>
                  {anyAtAll
                    ? "nothing matches the filters"
                    : "no kernels — a persistent interpreter for exploration; the agent starts one with ⌁ kernel_start, then promotes the good blocks into the record"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {sel ? (
        <KernelDetail kernel={sel} onSelectKernel={onSelect} onOpenJob={onOpenJob} />
      ) : (
        <div className="card detail">
          <div className="empty-detail">select a kernel to see its transcript</div>
        </div>
      )}
    </div>
  );
}

function ServicesSplit({
  services,
  anyAtAll,
  selected,
  onSelect,
  now,
  sort,
  onSort,
}: {
  services: ServiceRow[];
  anyAtAll: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  now: number;
  sort: SortState;
  onSort: (k: string, first?: "asc" | "desc") => void;
}) {
  const sel = services.find((s) => s.service_id === selected);
  return (
    <div className="split">
      <div className="card tablecard">
        <table className="tbl">
          <thead>
            <tr>
              <Th k="state" sort={sort} onSort={onSort}>State</Th>
              <Th k="service" sort={sort} onSort={onSort}>Service</Th>
              <Th k="site" sort={sort} onSort={onSort}>Site</Th>
              <Th k="command" sort={sort} onSort={onSort}>Command</Th>
              <Th k="ports" sort={sort} onSort={onSort}>Ports</Th>
              <Th k="up" className="r" sort={sort} onSort={onSort} title="longest-running first">Up</Th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => (
              <tr
                key={s.service_id}
                data-rowid={s.service_id}
                className={selected === s.service_id ? "sel" : undefined}
                onClick={() => onSelect(s.service_id)}
              >
                <td>
                  <ServicePill state={s.state} />
                </td>
                <td>
                  {s.task.label ? (
                    <>
                      <span style={{ fontWeight: 500 }}>{s.task.label}</span>
                      <div className="arr-sub">
                        <a className="id plain">{s.service_id}</a>
                      </div>
                    </>
                  ) : (
                    <a className="id">{s.service_id}</a>
                  )}
                </td>
                <td>{s.site}</td>
                <td className="cmd" title={s.task.command}>
                  {s.task.command}
                </td>
                <td className="num dim">{s.ports.join(", ")}</td>
                <td className="r num dim">
                  {s.state === "ready" || s.state === "starting" ? fmtDur(now - s.created_at) : fmtWhen(s.created_at)}
                </td>
              </tr>
            ))}
            {!services.length && (
              <tr>
                <td colSpan={6} className="dim" style={{ padding: 24, textAlign: "center" }}>
                  {anyAtAll
                    ? "nothing matches the filters"
                    : "no services — a long-lived process whose result is a live endpoint (dashboard, notebook server); started with ⌁ service_start, reached through an ssh tunnel"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {sel ? (
        <ServiceDetail service={sel} />
      ) : (
        <div className="card detail">
          <div className="empty-detail">select a service to see its endpoints</div>
        </div>
      )}
    </div>
  );
}
