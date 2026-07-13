/**
 * Detail pane for a single job: header, error card (FAILED), live log
 * (active), manifest (DONE), timeline from job.state events, task facts,
 * actions with their ⌁ call names.
 */

import { useEffect, useState } from "react";
import type { JobRow, SubmitPlan, TaskStatusRow } from "@shared/types";
import { TERMINAL_STATES } from "@shared/types";
import { wtool } from "../api/client";
import { Api, fmtAsk, fmtBytes, fmtClock, fmtDur, GradeChip, Id, Pill } from "../bits";
import { act, useApp } from "../state";
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

/** plan echo (mockup 01 §10): what submit promised vs what happened —
 * calibrates trust in the next plan. Plans persist upstream (weft ≥9a30cdb),
 * so this renders for any job, restarts included. */
function PlanEcho({ job }: { job: JobRow }) {
  const { stagedBytes } = useApp();
  const [plan, setPlan] = useState<SubmitPlan | null>(null);

  useEffect(() => {
    let alive = true;
    setPlan(null);
    wtool<TaskStatusRow[]>("task_status", { job_id: job.job_id }).then((rows) => {
      if (alive && Array.isArray(rows) && rows[0]?.plan) setPlan(rows[0].plan);
    });
    return () => {
      alive = false;
    };
  }, [job.job_id]);

  if (!plan) return null;
  const staged = stagedBytes.get(job.job_id);
  const peak = job.manifest?.max_rss_gb;
  const notObserved = <span className="unknown">not observed this session</span>;
  return (
    <>
      <hr className="hr" />
      <div className="echo">
        <span className="h"></span>
        <span className="h">plan promised</span>
        <span className="h">actual</span>
        <span className="dim">staging</span>
        <span className="prom">
          {fmtBytes(plan.staging.bytes_to_move)}
          {plan.staging.estimate_s > 1 ? ` · ~${fmtDur(plan.staging.estimate_s)}` : ""}
        </span>
        <span>{staged != null ? fmtBytes(staged) : notObserved}</span>
        <span className="dim">env</span>
        <span className="prom">{plan.env.action}</span>
        <span>{job.manifest ? (job.manifest.env_id ? "realized" : "bare (0s)") : "—"}</span>
        <span className="dim">memory</span>
        <span className="prom">{plan.resources.mem_gb ? `${plan.resources.mem_gb} GB ask` : "no ask"}</span>
        <span>{peak != null ? `${peak.toFixed(2)} GB peak` : "—"}</span>
        <span className="dim">queue</span>
        <span className="prom">{plan.queue}</span>
        <span>—</span>
      </div>
    </>
  );
}

export function JobDetail({ job }: { job: JobRow }) {
  const { stagedBytes } = useApp();
  const active = !TERMINAL_STATES.has(job.state);
  const staged = stagedBytes.get(job.job_id);

  const cancel = () => void act("task_cancel", { job_id: job.job_id });
  const resubmit = () => void act("task_submit", { task: job.task, force: true });

  return (
    <div className="card detail">
      <div className="pane-h">
        <Pill state={job.state} />
        {job.label && <b style={{ fontSize: 13 }}>{job.label}</b>}
        <span className="id">{job.job_id}</span>
        <span className="dim small">
          {job.site} · {TERMINAL_STATES.has(job.state) ? "finished" : "updated"} {fmtClock(job.updated_at)}
        </span>
        {job.superseded_by && (
          <span className="chip quiet" title="this attempt was replaced by a retry">
            superseded by <span className="mono">{job.superseded_by}</span>
          </span>
        )}
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
        <PlanEcho job={job} />
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
