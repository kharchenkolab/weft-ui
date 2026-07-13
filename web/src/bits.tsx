/** Small shared pieces: pills, chips, grades, ⌁ captions, formatters. */

import type { Grade, JobRow, Resources, WeftErrorPayload } from "@shared/types";
import { errorClass, GRADE_RANK } from "@shared/types";

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
  return <span className="api">{children}</span>;
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

export function fmtClock(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
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
