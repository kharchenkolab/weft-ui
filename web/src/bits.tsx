/** Small shared pieces: pills, chips, grades, ⌁ captions, formatters. */

import type { Grade, JobRow, Resources, SiteLoadInfo, WeftErrorPayload } from "@shared/types";
import { errorClass, GRADE_RANK } from "@shared/types";
import type { SiteLoadSample } from "./state";

/** how busy a site is for NEW work: scheduler sites = share of cores not
 * idle (down/drained nodes count as busy — they can't take jobs); single
 * nodes = the measured load fraction. null = the sample can't say. */
export function siteBusyFraction(load: SiteLoadInfo): number | null {
  const parts = Object.values(load.partitions ?? {});
  if (parts.length) {
    let total = 0;
    let idle = 0;
    for (const p of parts) {
      total += p.cpus_total;
      idle += p.cpus_idle;
    }
    return total > 0 ? 1 - idle / total : null;
  }
  const f = load.load_fraction;
  return typeof f === "number" ? Math.min(1, f) : null;
}

const LOAD_STALE_MS = 180_000; // mirrors Store.LOAD_STALE_MS

/** the five-state site dot: green/amber/red fill = capacity spectrum,
 * gray fill = reachable but no fresh load sample, hollow = unreachable.
 * Color is a claim — the tooltip always carries the actual numbers. */
export function SiteDot({
  name,
  health,
  sample,
  now,
}: {
  name: string;
  health?: string | null;
  sample?: SiteLoadSample;
  /** store clock, seconds — drives honest staleness without per-dot timers */
  now: number;
}) {
  if (health && health !== "ok")
    return <span className="dot hollow" title={`${name}: ${health} — weft could not reach it`} />;
  const fresh = sample != null && now * 1000 - sample.ts < LOAD_STALE_MS;
  if (!fresh || !sample?.load) {
    const tip =
      sample?.load == null && sample != null
        ? `${name}: load probe failed — site may be unreachable (weft hasn't marked it yet)`
        : `${name}: reachable — ${sample == null ? "no load sample yet" : "load sample is stale"}`;
    return <span className="dot nosample" title={tip} />;
  }
  const busy = siteBusyFraction(sample.load);
  if (busy == null)
    return (
      <span className="dot nosample" title={`${name}: reachable — load sample has no core figures`} />
    );
  const cls = busy > 0.9 ? "hot" : busy > 0.7 ? "warm" : "ok";
  const word = busy > 0.9 ? "saturated — new work will wait" : busy > 0.7 ? "busy" : "capacity available";
  const parts = Object.values(sample.load.partitions ?? {});
  let detail: string;
  if (parts.length) {
    let total = 0;
    let idle = 0;
    let pending = 0;
    for (const p of parts) {
      total += p.cpus_total;
      idle += p.cpus_idle;
      pending += p.pending_jobs;
    }
    detail = `${idle.toLocaleString()} idle of ${total.toLocaleString()} cores${pending ? ` · ${pending.toLocaleString()} jobs pending` : ""}`;
  } else {
    detail = `1-min load ${Math.round(busy * 100)}% of ${String(sample.load.cpus ?? "?")} cores`;
  }
  return (
    <span
      className={`dot ${cls}`}
      title={`${name}: ${word} (${Math.round(100 * busy)}% busy) — ${detail}`}
    />
  );
}

export function Pill({ state, asOf }: { state: string; asOf?: string }) {
  const cls = state === "DONE" ? "s-done"
    : state === "RUNNING" || state === "COLLECTING" ? "s-running"
    : state === "QUEUED" || state === "SUBMITTED" ? "s-queued"
    : state === "FAILED" ? "s-failed"
    : state === "CANCELLED" ? "s-cancelled"
    : state === "STAGING" || state === "RESOLVING_ENV" ? "s-staging"
    : "s-pending";
  return (
    <span className={`pill ${cls}`} title={asOf ? `frozen at last received event — ${asOf}` : undefined}>
      {state}
    </span>
  );
}

export function Id({ id, onClick }: { id: string; onClick?: () => void }) {
  return (
    <a className="id" onClick={onClick}>
      {id}
    </a>
  );
}

export function ErrorChip({ err }: { err: WeftErrorPayload }) {
  return <span className={`chip code ${errorClass(err)}`}>{err.error}</span>;
}

export function GradeChip({ grade }: { grade: Grade | string }) {
  const rank = GRADE_RANK[grade as Grade];
  if (!rank) return <span className="chip quiet">{grade}</span>;
  return (
    <span className={`grade g${rank}`}>
      {grade}
      <span className="rungs"><b /><b /><b /><b /><b /></span>
    </span>
  );
}

/** the peer principle: every action names the API call it makes */
export function Api({ children }: { children: React.ReactNode }) {
  // the peer-principle caption, not a control: every section/button names
  // the weft tool calls behind it — the same calls the agent makes
  return (
    <span
      className="api"
      title="the weft API calls behind this section — the agent uses exactly the same tools (nothing here is UI-only)"
    >
      {children}
    </span>
  );
}

// ---- formatters -------------------------------------------------------------

export function fmtBytes(n: number | undefined | null): string {
  if (n == null) return "—";
  if (n === 0) return "0";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} K`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} M`;
  return `${(n / 1024 ** 3).toFixed(1)} G`;
}

export function fmtDur(seconds: number): string {
  if (seconds < 0 || !isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** within-run precision (timeline events, live ticker): seconds matter */
export function fmtClock(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** "when did this happen" columns: minutes are enough, and anything not
 * from today carries its date — "15:23" / "Jul 13, 15:23" / "2025 Jul 13" */
export function fmtWhen(ts: number | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.toDateString() === now.toDateString()) return hm;
  const md = d.toLocaleDateString([], { month: "short", day: "numeric" });
  if (d.getFullYear() === now.getFullYear()) return `${md}, ${hm}`;
  return `${d.getFullYear()} ${md}`;
}

export function fmtAsk(res: Resources | undefined, each = false): string {
  if (!res || (!res.cpus && !res.mem_gb && !res.gpus)) return "defaults";
  const parts = [];
  if (res.cpus) parts.push(`${res.cpus}c`);
  if (res.mem_gb) parts.push(`${res.mem_gb}G`);
  if (res.gpus) parts.push(`${res.gpus} gpu`);
  return parts.join(" / ") + (each ? " each" : "");
}

export function elapsed(job: JobRow, now: number): string {
  const end = ["DONE", "FAILED", "CANCELLED"].includes(job.state) ? job.updated_at : now;
  return fmtDur(end - job.created_at);
}
