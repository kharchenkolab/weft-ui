/**
 * Jobs panel (mockup 01): load header, transfers strip, filterable table
 * with array-digest rows, sticky detail pane, event ticker. Keyboard:
 * j/k navigate, ⏎ opens, / searches.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { JobRow } from "@shared/types";
import { TERMINAL_STATES } from "@shared/types";
import { Api, elapsed, ErrorChip, fmtAsk, fmtBytes, fmtClock, fmtDur, GradeChip, Pill } from "../bits";
import { CountsLine, DigestBar, groupCounts, type GroupRow } from "../components/ArrayDetail";
import { ArrayDetail } from "../components/ArrayDetail";
import { JobDetail } from "../components/JobDetail";
import { useApp } from "../state";

type Row =
  | { kind: "job"; id: string; job: JobRow; sortKey: number }
  | { kind: "group"; id: string; group: GroupRow; sortKey: number };

function buildRows(jobs: ReadonlyMap<string, JobRow>): Row[] {
  const singles: JobRow[] = [];
  const groups = new Map<string, JobRow[]>();
  for (const j of jobs.values()) {
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
      group: { group: gid, site: els[0].site, elements: els, counts, state },
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
    const hay = `${row.id} ${jobs[0].site} ${jobs[0].task.command}`.toLowerCase();
    if (!hay.includes(q.toLowerCase())) return false;
  }
  return true;
}

function LoadStrip() {
  const { sites } = useApp();
  if (!sites.length) return null;
  return (
    <div className="load-strip">
      {sites.map((s) => (
        <span className="site-mini" key={s.name}>
          <span className={`dot ${s.health === "ok" ? "ok" : "bad"}`} />
          <span className="nm">{s.name}</span>
          <span className="sub">
            {s.health !== "ok"
              ? s.health
              : [
                  s.cpus ? `${s.cpus}c` : null,
                  s.mem_gb ? `${s.mem_gb}G` : null,
                  s.gpus ? `${s.gpus} gpu` : null,
                  s.scheduler && s.scheduler !== "none" ? s.scheduler : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || s.kind}
          </span>
        </span>
      ))}
      <span className="right-al api">sites_list · site_load</span>
    </div>
  );
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
          <span className="prog">
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
      <span className="right-al api">transfer.progress</span>
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
          <b>{fmtClock(ev.ts)}</b> {ev.kind} {ev.job_id ?? (ev.site as string) ?? ""}{" "}
          {(ev.state as string) ?? ""}
        </span>
      ))}
      <span className="right-al api" style={{ flex: "none" }}>
        GET /api/events (SSE)
      </span>
    </div>
  );
}

function AskCell({ job }: { job: JobRow }) {
  if (job.state === "FAILED" && job.error) return <ErrorChip err={job.error} />;
  if (job.state === "DONE" && job.manifest)
    return <GradeChip grade={job.manifest.reproducibility} />;
  if (job.state === "CANCELLED")
    return <span className="dim small">cancelled {fmtClock(job.updated_at)}</span>;
  return <span className="nowrap dim">{fmtAsk(job.task.resources)}</span>;
}

export function JobsPage() {
  const { jobs, sites, now, stagedBytes } = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [stateFilter, setStateFilter] = useState("any");
  const [siteFilter, setSiteFilter] = useState("any");
  const searchRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => buildRows(jobs), [jobs]);
  const visible = useMemo(
    () => rows.filter((r) => rowMatches(r, q, stateFilter, siteFilter)),
    [rows, q, stateFilter, siteFilter],
  );

  // keyboard: j/k navigate, ⏎ opens (selection == open here), / searches
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "j" || e.key === "k") {
        const idx = visible.findIndex((r) => r.id === selected);
        const next = e.key === "j" ? Math.min(idx + 1, visible.length - 1) : Math.max(idx - 1, 0);
        if (visible[next]) {
          setSelected(visible[next].id);
          document
            .querySelector(`tr[data-rowid="${CSS.escape(visible[next].id)}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selected]);

  const selectedRow = visible.find((r) => r.id === selected);
  const selectedJob = !selectedRow && selected ? jobs.get(selected) : undefined;
  const unreachable = sites.filter((s) => s.health !== "ok");

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
          <a className="on">
            Jobs <span className="n">{visible.length}</span>
          </a>
          <a title="kernels arrive in M4" style={{ opacity: 0.45, cursor: "default" }}>
            Kernels
          </a>
          <a title="services arrive in M4" style={{ opacity: 0.45, cursor: "default" }}>
            Services
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
        <select className="filter-select" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
          <option value="any">state: any</option>
          <option value="active">active</option>
          <option value="RUNNING">running</option>
          <option value="QUEUED">queued</option>
          <option value="FAILED">failed</option>
          <option value="DONE">done</option>
          <option value="CANCELLED">cancelled</option>
        </select>
        <select className="filter-select" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
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

      <div className="split">
        <div className="card tablecard">
          <table className="tbl">
            <thead>
              <tr>
                <th>State</th>
                <th>Job</th>
                <th>Site</th>
                <th>Command</th>
                <th className="r">Elapsed</th>
                <th className="r">Staged</th>
                <th>Ask</th>
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
                        <a className="id">{r.job.job_id}</a>
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
                        <a className="id">{r.group.group}</a>
                        <div className="arr-sub">array · {r.group.elements.length.toLocaleString()} elements</div>
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
        </div>

        {selectedRow?.kind === "group" ? (
          <ArrayDetail row={selectedRow.group} onSelectJob={setSelected} />
        ) : selectedRow?.kind === "job" ? (
          <JobDetail job={selectedRow.job} />
        ) : selectedJob ? (
          <JobDetail job={selectedJob} />
        ) : (
          <div className="card detail">
            <div className="empty-detail">select a job to inspect it</div>
          </div>
        )}
      </div>

      <Ticker />
    </>
  );
}
