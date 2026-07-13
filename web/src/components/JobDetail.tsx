/**
 * Detail pane for a single job: header, error card (FAILED), live log
 * (active), manifest (DONE), timeline from job.state events, task facts,
 * actions with their ⌁ call names.
 */

import type { JobRow } from "@shared/types";
import { TERMINAL_STATES } from "@shared/types";
import { wtool } from "../api/client";
import { Api, fmtAsk, fmtBytes, fmtClock, fmtDur, GradeChip, Id, Pill } from "../bits";
import { store, useApp } from "../state";
import { ErrorCard } from "./ErrorCard";
import { LogPane } from "./LogPane";
import { ManifestView } from "./ManifestView";

function Timeline({ job }: { job: JobRow }) {
  const { timelines } = useApp();
  const tl = timelines.get(job.job_id) ?? [];
  if (!tl.length)
    return (
      <div className="faint small">
        no state events in this session’s replay window — job predates the cursor
      </div>
    );
  return (
    <ul className="tl">
      {tl.map((e, i) => {
        const next = tl[i + 1];
        const dur = next ? fmtDur(next.ts - e.ts) : "";
        const cls =
          e.state === "FAILED" ? "bad" : i === tl.length - 1 && !TERMINAL_STATES.has(e.state) ? "now" : "done";
        return (
          <li key={i} className={cls}>
            <span className="tld" />
            <span className="ts">{fmtClock(e.ts)}</span>
            <span>{e.state.toLowerCase().replace("_", " ")}</span>
            <span className="dur">{dur}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function JobDetail({ job }: { job: JobRow }) {
  const { stagedBytes } = useApp();
  const active = !TERMINAL_STATES.has(job.state);
  const staged = stagedBytes.get(job.job_id);

  const cancel = async () => {
    await wtool("task_cancel", { job_id: job.job_id });
    store.refresh();
  };
  const resubmit = async () => {
    await wtool("task_submit", { task: job.task, force: true });
    store.refresh();
  };

  return (
    <div className="card detail">
      <div className="pane-h">
        <Pill state={job.state} />
        <span className="id">{job.job_id}</span>
        <span className="dim small">
          {job.site} · {TERMINAL_STATES.has(job.state) ? "finished" : "updated"} {fmtClock(job.updated_at)}
        </span>
        <span className="right-al row">
          <button className="btn sm ghost" disabled title="chat arrives in M3">
            Ask the agent
          </button>
        </span>
      </div>

      {job.state === "FAILED" && job.error && (
        <div className="sec">
          <ErrorCard job={job} />
        </div>
      )}

      {active && (
        <div className="sec">
          <LogPane jobId={job.job_id} />
        </div>
      )}

      {job.state === "DONE" && job.manifest && <ManifestView manifest={job.manifest} />}

      <div className="sec">
        <div className="sec-h">
          Timeline
          <span className="right">
            <Api>job.state events</Api>
          </span>
        </div>
        <Timeline job={job} />
      </div>

      <div className="sec">
        <div className="sec-h">Task</div>
        <dl className="kv">
          <dt>command</dt>
          <dd className="mono small">{job.task.command}</dd>
          <dt>environment</dt>
          <dd>
            {job.task.env ? (
              <span className="id plain">{job.task.env}</span>
            ) : (
              <>
                bare <GradeChip grade="attested" />
              </>
            )}
          </dd>
          <dt>resources</dt>
          <dd>{fmtAsk(job.task.resources)}</dd>
          {staged != null && (
            <>
              <dt>staged</dt>
              <dd className="num">{fmtBytes(staged)}</dd>
            </>
          )}
          <dt>task_hash</dt>
          <dd className="mono small">{job.task_hash.slice(0, 24)}…</dd>
          {job.array_group && (
            <>
              <dt>array</dt>
              <dd>
                element {job.array_index} of <Id id={job.array_group} />
              </dd>
            </>
          )}
        </dl>
      </div>

      <div className="sec row">
        <button className="btn sm" disabled={!active} title={active ? undefined : "job is terminal"} onClick={cancel}>
          Cancel
        </button>
        <button className="btn sm" onClick={resubmit}>
          Resubmit (force)
        </button>
        <Api>task_cancel · task_submit(force=True)</Api>
      </div>
    </div>
  );
}
