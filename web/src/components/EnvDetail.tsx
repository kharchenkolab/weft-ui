/**
 * Environments tab (workspace view): every solved env from list_envs,
 * detail from env_status — identity + grade components, realizations per
 * site with management controls (evict / repair), and the jobs that used
 * it. Site catalogs (env_published) live on the Compute page — this tab
 * answers "what do I have?", not "what does the cluster offer?".
 */

import { useCallback, useEffect, useState } from "react";
import type { EnvListRow, EnvRealization, EnvStatus, JobRow } from "@shared/types";
import { wtool } from "../api/client";
import { Api, fmtBytes, fmtWhen, GradeChip, Pill } from "../bits";
import { act, useApp } from "../state";

/** occupying = a realization holds bytes there (ready/building/failed) */
export function occupying(reals: EnvRealization[] | undefined): EnvRealization[] {
  return (reals ?? []).filter((r) => r.state !== "missing" && r.state !== "evicted");
}

export function envMatches(e: EnvListRow, q: string, reals?: EnvRealization[]): boolean {
  if (!q) return true;
  const sites = occupying(reals)
    .map((r) => r.site)
    .join(" ");
  const hay = `${e.name ?? ""} ${e.env_id} ${e.platforms.join(" ")} ${sites}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

function StatePill({ state, readOnly }: { state: string; readOnly?: boolean }) {
  const cls =
    state === "ready" ? "s-done" : state === "building" ? "s-running" : state === "failed" ? "s-failed" : "s-pending";
  return (
    <>
      <span className={`pill ${cls}`}>{state.toUpperCase()}</span>
      {readOnly && (
        <span className="chip quiet" title="adopted from an institutional read-only tree — not GC-managed">
          ro
        </span>
      )}
    </>
  );
}

function EnvDetail({
  env,
  jobsUsing,
  onOpenJob,
}: {
  env: EnvListRow;
  jobsUsing: JobRow[];
  onOpenJob: (jobId: string) => void;
}) {
  const [status, setStatus] = useState<EnvStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "evict:<site>" | "repair:<site>" | "revise"

  const load = useCallback(() => {
    wtool<EnvStatus>("env_status", { env_id: env.env_id }).then((s) => setStatus(s.error ? null : s));
  }, [env.env_id]);

  useEffect(() => {
    setStatus(null);
    load();
  }, [load]);

  const run = async (key: string, tool: string, args: Record<string, unknown>) => {
    setBusy(key);
    await act(tool, args);
    load();
    setBusy(null);
  };

  const sum = status?.summary;
  const comps = sum?.reproducibility_components ?? [];
  return (
    <div className="card detail">
      <div className="pane-h">
        {sum?.reproducibility && <GradeChip grade={sum.reproducibility} />}
        <b style={{ fontSize: 13 }}>{env.name ?? "unnamed env"}</b>
        <span className="id plain">{env.env_id.slice(0, 28)}…</span>
        <span className="dim small">{env.platforms.join(" · ")}</span>
      </div>

      {status == null ? (
        <div className="sec">
          <span className="faint small">reading env_status…</span>
        </div>
      ) : (
        <>
          <div className="sec">
            <div className="sec-h">
              Identity
              <span className="right">
                <Api>env_status</Api>
              </span>
            </div>
            {sum?.reproducibility_meaning && (
              <div className="dim small" style={{ marginBottom: 6 }}>{sum.reproducibility_meaning}</div>
            )}
            <dl className="kv">
              <dt>packages</dt>
              <dd className="num">
                {Object.entries(sum?.packages_per_platform ?? {})
                  .map(([p, n]) => `${p}: ${n}`)
                  .join(" · ") || "—"}
              </dd>
              {(sum?.modules?.length ?? 0) > 0 && (
                <>
                  <dt>site modules</dt>
                  <dd>
                    {sum!.modules!.map((m) => (
                      <span className="chip quiet" key={m}>
                        {m}
                      </span>
                    ))}
                  </dd>
                </>
              )}
              <dt>created</dt>
              <dd className="num dim">{fmtWhen(env.created_at)}</dd>
            </dl>
            {comps.length > 0 && (
              <table className="tbl parts-tbl" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>component</th>
                    <th>grade</th>
                    <th>why</th>
                  </tr>
                </thead>
                <tbody>
                  {comps.map((c) => (
                    <tr key={c.component}>
                      <td className="mono">{c.component}</td>
                      <td>
                        <GradeChip grade={c.grade} />
                      </td>
                      <td className="dim small">{c.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(sum?.notes?.length ?? 0) > 0 && (
              <ul className="small dim" style={{ marginTop: 6, paddingLeft: 16 }}>
                {sum!.notes!.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="sec">
            <div className="sec-h">
              Realizations
              <span className="right">
                <Api>env_evict · env_repair</Api>
              </span>
            </div>
            {status.realizations.length === 0 ? (
              <div className="faint small">
                not realized anywhere yet — the first job that uses this env materializes it on its site
              </div>
            ) : (
              <table className="tbl parts-tbl">
                <thead>
                  <tr>
                    <th>site</th>
                    <th>state</th>
                    <th>strategy</th>
                    <th className="r">size</th>
                    <th className="r">idle</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {status.realizations.map((r) => (
                    <tr key={r.site}>
                      <td>{r.site}</td>
                      <td>
                        <StatePill state={r.state} readOnly={r.read_only} />
                      </td>
                      <td className="dim small">{r.strategy ?? "—"}</td>
                      <td className="r num">{r.bytes != null ? fmtBytes(r.bytes) : "—"}</td>
                      <td className="r num dim">{r.idle_days != null ? `${r.idle_days} d` : "—"}</td>
                      <td className="r">
                        {r.state === "ready" && !r.read_only && (
                          <button
                            className="btn sm"
                            disabled={busy != null}
                            title="drop the realized prefix and reclaim its disk — the site's package cache stays warm, so re-materialization is seconds and needs no network ⌁ env_evict"
                            onClick={() => void run(`evict:${r.site}`, "env_evict", { env_id: env.env_id, site: r.site })}
                          >
                            {busy === `evict:${r.site}` ? "Evicting…" : "Evict"}
                          </button>
                        )}
                        {r.state === "failed" && (
                          <button
                            className="btn sm"
                            disabled={busy != null}
                            title="re-materialize from the recorded lock on this site ⌁ env_repair"
                            onClick={() => void run(`repair:${r.site}`, "env_repair", { env_id: env.env_id, site: r.site })}
                          >
                            {busy === `repair:${r.site}` ? "Repairing…" : "Repair"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {status.realizations
              .filter((r) => r.state === "failed" && r.log_tail)
              .map((r) => (
                <div key={r.site} style={{ marginTop: 6 }}>
                  <div className="dim small">build log tail — {r.site}</div>
                  <pre className="blk-out" style={{ maxHeight: 160 }}>{r.log_tail}</pre>
                </div>
              ))}
          </div>

          <div className="sec">
            <div className="sec-h">Used by</div>
            {jobsUsing.length === 0 ? (
              <div className="faint small">no jobs in this workspace reference this env yet</div>
            ) : (
              jobsUsing.slice(0, 8).map((j) => (
                <div className="row small" key={j.job_id} style={{ gap: 8, padding: "2.5px 0" }}>
                  <Pill state={j.state} />
                  <a className="id" onClick={() => onOpenJob(j.job_id)}>
                    {j.label || j.job_id}
                  </a>
                  <span className="dim">{j.site}</span>
                  <span className="right-al num dim">{fmtWhen(j.updated_at)}</span>
                </div>
              ))
            )}
            {jobsUsing.length > 8 && (
              <div className="faint small" style={{ marginTop: 3 }}>
                +{jobsUsing.length - 8} more — filter the jobs tab by this env id
              </div>
            )}
          </div>

          <div className="sec row">
            <button
              className="btn sm"
              disabled={busy != null}
              title="re-solve the original spec fresh and report the delta — mints a NEW env id, never redefines this one ⌁ env_revise"
              onClick={() => void run("revise", "env_revise", { env_id: env.env_id, reason: "requested from the envs panel" })}
            >
              {busy === "revise" ? "Revising…" : "Revise (re-solve)"}
            </button>
            <Api>env_revise</Api>
          </div>
        </>
      )}
    </div>
  );
}

export function EnvsSplit({
  envs,
  anyAtAll,
  selected,
  onSelect,
  onOpenJob,
}: {
  envs: EnvListRow[];
  anyAtAll: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenJob: (jobId: string) => void;
}) {
  const { jobs, envSites } = useApp();
  const usingByEnv = (envId: string) =>
    [...jobs.values()].filter((j) => j.task.env === envId).sort((a, b) => b.updated_at - a.updated_at);
  const sel = envs.find((e) => e.env_id === selected);
  return (
    <div className="split">
      <div className="card tablecard">
        <table className="tbl">
          <thead>
            <tr>
              <th>Environment</th>
              <th title="sites where a realization occupies space, with its recorded size">Sites</th>
              <th className="r">Jobs</th>
              <th className="r">Created</th>
            </tr>
          </thead>
          <tbody>
            {envs.map((e) => {
              const reals = occupying(envSites.get(e.env_id));
              return (
                <tr
                  key={e.env_id}
                  data-rowid={e.env_id}
                  className={selected === e.env_id ? "sel" : undefined}
                  onClick={() => onSelect(e.env_id)}
                >
                  <td>
                    <span style={{ fontWeight: 500 }}>{e.name ?? "unnamed"}</span>
                    <div className="arr-sub">
                      <a className="id plain">{e.env_id.slice(0, 30)}…</a> · {e.platforms.join(" · ")}
                    </div>
                  </td>
                  <td>
                    {reals.length ? (
                      reals.map((r) => (
                        <span
                          key={r.site}
                          className={`chip ${r.state === "failed" ? "code user" : "quiet"}`}
                          style={{ marginRight: 4 }}
                          title={`${r.state}${r.bytes != null ? ` · ${fmtBytes(r.bytes)}` : ""}${r.read_only ? " · read-only" : ""}`}
                        >
                          {r.site}
                          {r.bytes != null && <span className="num"> {fmtBytes(r.bytes)}</span>}
                        </span>
                      ))
                    ) : (
                      <span className="dim small">not realized</span>
                    )}
                  </td>
                  <td className="r num">{usingByEnv(e.env_id).length || "—"}</td>
                  <td className="r num dim">{fmtWhen(e.created_at)}</td>
                </tr>
              );
            })}
            {!envs.length && (
              <tr>
                <td colSpan={4} className="dim" style={{ padding: 18 }}>
                  {anyAtAll
                    ? "no environments match — with a site selected, only envs whose realizations still occupy space there are shown"
                    : "no environments yet — an env_ensure (or a task with an env spec) solves one; the first job using it realizes it on its site"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {sel ? (
        <EnvDetail env={sel} jobsUsing={usingByEnv(sel.env_id)} onOpenJob={onOpenJob} />
      ) : (
        <div className="card detail">
          <div className="empty-detail">select an environment — identity, realizations, and eviction live here</div>
        </div>
      )}
    </div>
  );
}
