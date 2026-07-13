/**
 * The structured-error renderer (mockup 01 §9): code · stage · hints ·
 * retryable, log excerpt with the classified signature highlighted, and
 * remediation buttons that are exactly the calls the agent would make.
 * Shared verbatim with the chat renderer when M3 lands.
 */

import type { JobRow, WeftErrorPayload } from "@shared/types";
import { errorClass } from "@shared/types";
import { act } from "../state";
import { Api, ErrorChip } from "../bits";

const CLASS_LABEL = { user: "user-code", infra: "infra", policy: "policy" } as const;

/** peak + 25% headroom, rounded up — never re-size down */
function bumpedMem(err: WeftErrorPayload, current: number | undefined): number | null {
  const alloc = err.hints?.failed_allocation ?? "";
  const m = /([\d.]+)\s*GiB/.exec(String(alloc));
  const peak = m ? parseFloat(m[1]) : null;
  if (peak == null) return null;
  const bumped = Math.ceil(peak * 1.25);
  return current != null && bumped <= current ? null : bumped;
}

export function ErrorCard({ job }: { job: JobRow }) {
  const err = job.error!;
  const cls = errorClass(err);
  const sig = err.hints?.log_signature;
  const excerpt = sig?.excerpt ?? err.hints?.log_tail ?? err.hints?.traceback_tail;
  const memBump = err.error === "job.oom" ? bumpedMem(err, job.task.resources?.mem_gb) : null;

  const resubmit = (memGb?: number) => {
    const task = memGb
      ? { ...job.task, resources: { ...(job.task.resources ?? {}), mem_gb: memGb } }
      : job.task;
    void act("task_submit", { task, force: true });
  };

  const hintRows = Object.entries(err.hints ?? {}).filter(
    ([k]) => !["log_signature", "log_tail", "traceback_tail"].includes(k),
  );

  return (
    <div className="error-card">
      <div className="eh">
        <ErrorChip err={err} />
        <span className="stage">stage: {err.stage}</span>
        <span className="retryable">
          {err.retryable ? "retryable" : "not retryable unchanged"}
        </span>
        <span className="right-al small" style={{ color: "#7e2622" }}>{CLASS_LABEL[cls]}</span>
      </div>
      <div className="detail">
        {err.detail} <span className="dim">— {err.meaning}</span>
      </div>
      {hintRows.length > 0 && (
        <div className="hints">
          <ul>
            {hintRows.map(([k, v]) => (
              <li key={k}>
                <span>
                  <b>{k}:</b> {typeof v === "string" ? v : JSON.stringify(v)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {excerpt && (
        <div className="sec" style={{ padding: "0 14px 12px", border: "none" }}>
          <div className="log-meta">
            <span>log excerpt{sig?.signature ? " · classified signature highlighted" : ""}</span>
            <span className="right-al api">task_logs</span>
          </div>
          <div className="log">
            {String(excerpt)
              .split("\n")
              .map((line, i) => {
                const hot =
                  sig?.signature &&
                  (line.includes("Error") || line.includes("error") || line.includes("oom"));
                return (
                  <span key={i} className={hot ? "hl-sig" : undefined}>
                    {line}
                    {"\n"}
                  </span>
                );
              })}
          </div>
        </div>
      )}
      <div className="fixes">
        {memBump != null && (
          <button className="btn sm primary" onClick={() => resubmit(memBump)}>
            Resubmit with mem_gb={memBump}
          </button>
        )}
        <button className="btn sm" onClick={() => resubmit()}>
          Resubmit (force)
        </button>
        <Api>task_submit(force=True)</Api>
      </div>
    </div>
  );
}
