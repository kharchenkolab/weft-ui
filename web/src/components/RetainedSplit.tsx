/**
 * Retained tab (workspace view): every retained run's holdings across
 * all sites, grouped by label — the cross-cutting "what's holding bytes,
 * anywhere?" reclaim surface. Rows click through to their run. The
 * "sandbox remains" disclose covers the other half: terminal runs never
 * triaged, fetched per site from gc_plan on demand.
 */

import { useEffect, useState } from "react";
import type { RetainedRun, SiteSummary } from "@shared/types";
import { wtool } from "../api/client";
import { Api, fmtBytes, fmtWhen } from "../bits";
import { navigate } from "../router";
import { act } from "../state";
import { forgetTitle, placementWord, retainedStatePill } from "./RunRetention";

/** what a retained run kept, from the selection recorded at retain time */
function keptChips(r: RetainedRun): string[] {
  try {
    const sel = JSON.parse(r.selection ?? "null");
    const inc = sel?.include as string[] | null;
    if (!inc || !inc.length) return ["everything"];
    return inc.slice(0, 4).concat(inc.length > 4 ? [`+${inc.length - 4} more`] : []);
  } catch {
    return [];
  }
}

export function retainedMatches(r: RetainedRun, q: string, site: string): boolean {
  if (site !== "any" && r.site !== site) return false;
  if (!q) return true;
  return `${r.target} ${r.label ?? ""} ${r.site} ${r.location} ${r.state}`
    .toLowerCase()
    .includes(q.toLowerCase());
}

/** open the retained run's own detail — jobs and kernels route differently */
function openRun(target: string) {
  navigate(target.startsWith("krn_") ? ["jobs", "kernels", target] : ["jobs", target]);
}

interface Remains {
  site: string;
  entries: { target?: string; bytes?: number; [k: string]: unknown }[];
  policy_days?: number;
  error?: string;
}

function SandboxRemains({ sites }: { sites: SiteSummary[] }) {
  const [rows, setRows] = useState<Remains[] | null>(null);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (!opened || rows) return;
    Promise.all(
      sites
        .filter((s) => s.health === "ok")
        .map(async (s) => {
          try {
            const r = await wtool<Record<string, any>>("gc_plan", { site: s.name });
            const per = r?.sites?.[s.name] ?? {};
            return {
              site: s.name,
              entries: per.run_remains ?? [],
              policy_days: per.run_remains_days_policy,
            } as Remains;
          } catch {
            return { site: s.name, entries: [], error: "unreachable" } as Remains;
          }
        }),
    ).then(setRows);
  }, [opened, rows, sites]);

  const total = (rows ?? []).reduce((n, r) => n + r.entries.length, 0);
  return (
    <details className="disclose" style={{ marginTop: 10 }} onToggle={(e) => (e.target as HTMLDetailsElement).open && setOpened(true)}>
      <summary>
        Sandbox remains
        <span className="peek">
          {rows == null
            ? "terminal runs never retained or discarded — checks every site on open"
            : `${total} past-TTL sandbox${total === 1 ? "" : "es"} across ${rows.length} site${rows.length === 1 ? "" : "s"}`}
        </span>
      </summary>
      <div className="disc-body">
        {rows == null ? (
          <span className="faint small">asking each site’s gc_plan…</span>
        ) : total === 0 ? (
          <div className="faint small">
            {rows.some((r) => r.policy_days != null)
              ? `nothing past the TTL — sandboxes younger than the policy (${rows.find((r) => r.policy_days != null)?.policy_days} days) are not listed; gc_sweep on the compute page executes the eviction plan`
              : "nothing listed — the sandbox TTL is opt-in and no site sets one (a default that deletes what you forgot to retain would be silent loss); reclaim explicitly with Discard sandbox on a run, or set policy run_remains_days on a site"}
          </div>
        ) : (
          rows
            .filter((r) => r.entries.length)
            .map((r) => (
              <div key={r.site} style={{ marginBottom: 6 }}>
                <div className="small" style={{ fontWeight: 600 }}>{r.site}</div>
                {r.entries.map((e, i) => (
                  <div className="row small" key={i} style={{ gap: 8, padding: "1.5px 0" }}>
                    {e.target ? (
                      <a className="id" onClick={() => openRun(String(e.target))}>{String(e.target)}</a>
                    ) : (
                      <span className="mono small">{JSON.stringify(e).slice(0, 60)}</span>
                    )}
                    {e.bytes != null && <span className="num dim">{fmtBytes(Number(e.bytes))}</span>}
                  </div>
                ))}
              </div>
            ))
        )}
        <div className="faint small" style={{ marginTop: 4 }}>
          <Api>gc_plan per site</Api>
        </div>
      </div>
    </details>
  );
}

const RUNS_PER_GROUP = 8; // biggest groups are pipelines — cap, expand on demand

export function RetainedSplit({
  rows,
  anyAtAll,
  sites,
  onChanged,
}: {
  rows: RetainedRun[];
  anyAtAll: boolean;
  sites: SiteSummary[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [allRuns, setAllRuns] = useState<Set<string>>(new Set());

  const groups = new Map<string, RetainedRun[]>();
  for (const r of rows) groups.set(r.label || "", [...(groups.get(r.label || "") ?? []), r]);
  const totalBytes = rows.reduce((n, r) => n + (r.bytes ?? 0), 0);
  const bySite = new Map<string, number>();
  for (const r of rows) bySite.set(r.site, (bySite.get(r.site) ?? 0) + (r.bytes ?? 0));

  const forget = async (key: string, args: Record<string, unknown>) => {
    setBusy(key);
    await act("run_forget", { ...args, _confirm: true });
    onChanged();
    setBusy(null);
  };

  return (
    <div className="split" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
      <div className="card tablecard" style={{ padding: "0 0 10px" }}>
        <div className="row" style={{ padding: "10px 14px 6px", gap: 10 }}>
          <b style={{ fontSize: 12.5 }}>
            {rows.length} retained run{rows.length === 1 ? "" : "s"} · {fmtBytes(totalBytes)}
          </b>
          {[...bySite.entries()].map(([s, b]) => (
            <span className="chip quiet" key={s}>
              {s} {fmtBytes(b)}
            </span>
          ))}
          <span className="right-al">
            <Api>retained_runs · run_forget</Api>
          </span>
        </div>

        {rows.length === 0 && (
          <div className="dim" style={{ padding: "8px 14px" }}>
            {anyAtAll
              ? "no retained runs match the filters"
              : "nothing retained yet — a run detail's Files section is where files graduate from sandbox to holdings"}
          </div>
        )}

        {[...groups.entries()].map(([label, rs]) => {
          const gkey = label || "(unlabeled)";
          const opened = open.has(gkey);
          const gsites = [...new Set(rs.map((r) => r.site))];
          const cap = allRuns.has(gkey) ? rs.length : RUNS_PER_GROUP;
          return (
            <div key={gkey} style={{ padding: "4px 14px" }}>
              <div
                className="row small"
                style={{ gap: 8, padding: "3px 0", borderBottom: "1px solid var(--line2)", cursor: "pointer" }}
                onClick={() => setOpen((s2) => { const n = new Set(s2); if (n.has(gkey)) n.delete(gkey); else n.add(gkey); return n; })}
              >
                <span className="chev">{opened ? "▾" : "▸"}</span>
                {label ? <span className="chip quiet">{label}</span> : <span className="dim">unlabeled</span>}
                <span className="num dim">
                  {rs.length} run{rs.length === 1 ? "" : "s"} ·{" "}
                  {rs.reduce((n, r) => n + (r.files ?? 0), 0).toLocaleString()} files ·{" "}
                  {fmtBytes(rs.reduce((n, r) => n + (r.bytes ?? 0), 0))}
                </span>
                <span className="dim small">{gsites.join(" · ")}</span>
                {label && (
                  <span className="right-al" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="btn sm"
                      disabled={busy != null}
                      title="release every retention under this label — marks are unmarked (nothing deleted), copies are deleted, itemized receipt; inventories survive ⌁ run_forget(label)"
                      onClick={() => void forget(`label:${label}`, { label })}
                    >
                      {busy === `label:${label}` ? "Forgetting…" : "Forget label"}
                    </button>
                  </span>
                )}
              </div>
              {opened && rs.slice(0, cap).map((r) => (
                <div className="row small" key={`${r.target}:${r.location}`} style={{ gap: 8, padding: "2.5px 0 2.5px 18px" }}>
                  <span className={`pill ${retainedStatePill(r.state)}`}>{r.state.toUpperCase()}</span>
                  <a className="id" onClick={() => openRun(r.target)}>{r.target}</a>
                  <span className="dim">{r.site}</span>
                  <span
                    className="chip quiet"
                    title={
                      r.in_place
                        ? "the files stayed on the site's durable storage — retention is a record, not a transfer"
                        : "the files were transferred off the site"
                    }
                  >
                    {placementWord(r)}
                  </span>
                  {keptChips(r).map((c) => (
                    <span className="chip quiet mono" key={c} title="what this run's retention kept (recorded at retain time)">
                      {c}
                    </span>
                  ))}
                  <span className="num dim nowrap">
                    {r.files} file{r.files === 1 ? "" : "s"} · {fmtBytes(r.bytes)} · {fmtWhen(r.retained_at)}
                  </span>
                  <span className="right-al">
                    <button
                      className="btn sm"
                      disabled={busy != null}
                      title={forgetTitle(r)}
                      onClick={() => void forget(r.target, { target: r.target })}
                    >
                      {busy === r.target ? "Forgetting…" : "Forget"}
                    </button>
                  </span>
                </div>
              ))}
              {opened && rs.length > cap && (
                <div className="dim small" style={{ padding: "2px 0 2px 18px" }}>
                  <a className="id plain" onClick={() => setAllRuns((s2) => new Set(s2).add(gkey))}>
                    show {rs.length - cap} more run{rs.length - cap === 1 ? "" : "s"}
                  </a>
                </div>
              )}
            </div>
          );
        })}

        <div style={{ padding: "0 14px" }}>
          <SandboxRemains sites={sites} />
        </div>
      </div>
    </div>
  );
}
