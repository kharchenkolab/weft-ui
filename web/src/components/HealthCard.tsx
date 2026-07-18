/**
 * Workspace health (Activity page): doctor's self-diagnostics — per-site
 * shim reachability (multi-hop sites name WHICH hop died), stale
 * nonterminal jobs, idle kernels — plus the two repair levers: reconcile
 * (resume what a dead process dropped: pins, queued retains, stuck jobs)
 * and event-log pruning when the store grows past its comfort.
 */

import { useCallback, useEffect, useState } from "react";
import { wtool } from "../api/client";
import { Api, fmtWhen } from "../bits";
import { navigate } from "../router";
import { store } from "../state";

interface HopCheck {
  hop: string;
  ok: boolean | null;
}

interface SiteCheck {
  site: string;
  ok: boolean;
  shim?: string;
  error?: string;
  hops?: HopCheck[];
  diagnosis?: string;
}

interface DoctorReport {
  error?: string;
  detail?: string;
  sites: SiteCheck[];
  nonterminal_jobs: { job_id: string; state: string; site: string }[];
  idle_kernels?: { kernel_id: string; site: string; idle_s: number }[] | null;
  events_rows?: number | null;
  suggestion?: string | null;
}

export function HealthCard() {
  const [doc, setDoc] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actions, setActions] = useState<Record<string, unknown>[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const check = useCallback(async () => {
    setBusy("doctor");
    const r = await wtool<DoctorReport>("doctor");
    setDoc(r);
    setCheckedAt(Date.now() / 1000);
    setBusy(null);
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const reconcile = async () => {
    setBusy("reconcile");
    const r = await wtool<Record<string, unknown>[]>("reconcile");
    if (Array.isArray(r)) {
      setActions(r);
      store.toast("ok", `⌁ reconcile: ${r.length ? `${r.length} action(s)` : "nothing to fix"}`);
    } else {
      store.toast("err", `⌁ reconcile: ${(r as { error?: string })?.error ?? "failed"}`);
    }
    setBusy(null);
    void check();
  };

  const prune = async () => {
    setBusy("prune");
    const r = await wtool<{ pruned?: number; remaining?: number; error?: string }>(
      "gc_events", { older_than_days: 30 });
    store.toast(r.error ? "err" : "ok",
      r.error ? `⌁ gc_events: ${r.error}` : `⌁ gc_events: pruned ${r.pruned ?? 0}, ${r.remaining ?? "?"} remain`);
    setBusy(null);
    void check();
  };

  const bad = (doc?.sites ?? []).filter((s) => !s.ok);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="sec">
        <div className="sec-h">
          Workspace health
          <span className="right">
            <Api>doctor · reconcile · gc_events</Api>
          </span>
        </div>

        {doc == null ? (
          <span className="faint small">checking every site&apos;s shim…</span>
        ) : doc.error ? (
          <span className="chip code">{doc.error} — {doc.detail ?? ""}</span>
        ) : (
          <>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {(doc.sites ?? []).map((s) => (
                <span
                  key={s.site}
                  className={`chip ${s.ok ? "quiet" : "code user"}`}
                  title={
                    s.ok
                      ? `shim v${s.shim ?? "?"} answered`
                      : `${s.error ?? "unreachable"}${s.diagnosis ? ` — ${s.diagnosis}` : ""}` +
                        (s.hops ? ` · hops: ${s.hops.map((h) => `${h.hop} ${h.ok ? "✓" : h.ok === false ? "✗" : "?"}`).join(" → ")}` : "")
                  }
                >
                  {s.site} {s.ok ? "✓" : "✗"}
                </span>
              ))}
              {checkedAt && <span className="faint small">checked {fmtWhen(checkedAt)}</span>}
            </div>

            <div className="row small" style={{ gap: 12, marginTop: 8, flexWrap: "wrap" }}>
              <span>
                <b className="num">{(doc.nonterminal_jobs ?? []).length}</b>{" "}
                <span className="dim">non-terminal job{(doc.nonterminal_jobs ?? []).length === 1 ? "" : "s"}</span>
                {(doc.nonterminal_jobs ?? []).slice(0, 4).map((j) => (
                  <a key={j.job_id} className="id" style={{ marginLeft: 6 }}
                     onClick={() => navigate(["jobs", j.job_id])}>
                    {j.job_id}
                  </a>
                ))}
              </span>
              {(doc.idle_kernels ?? [])?.length ? (
                <span>
                  <b className="num">{doc.idle_kernels!.length}</b>{" "}
                  <span className="dim">kernel{doc.idle_kernels!.length === 1 ? "" : "s"} idle &gt;1h</span>
                  <a className="id plain" style={{ marginLeft: 6 }} onClick={() => navigate(["jobs", "kernels"])}>
                    → kernels
                  </a>
                </span>
              ) : null}
              {doc.events_rows != null && (
                <span>
                  <b className="num">{doc.events_rows.toLocaleString()}</b>{" "}
                  <span className="dim">event rows in the store</span>
                  <button className="btn sm" style={{ marginLeft: 6 }} disabled={busy != null}
                          title="prune events older than 30 days — terminal digests and failures are kept ⌁ gc_events"
                          onClick={() => void prune()}>
                    {busy === "prune" ? "Pruning…" : "Prune >30d"}
                  </button>
                </span>
              )}
            </div>

            {doc.suggestion && (
              <div className="dim small" style={{ marginTop: 6 }}>{doc.suggestion}</div>
            )}
            {bad.length === 0 && (doc.nonterminal_jobs ?? []).length === 0 && !doc.idle_kernels?.length && (
              <div className="dim small" style={{ marginTop: 6 }}>
                every site answers and nothing looks stuck
              </div>
            )}

            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              <button className="btn sm" disabled={busy != null} onClick={() => void check()}>
                {busy === "doctor" ? "Checking…" : "Re-check"}
              </button>
              <button
                className="btn sm"
                disabled={busy != null}
                title="resume what a dead process dropped: settle missed pins, re-queue interrupted retains, re-poll stuck jobs ⌁ reconcile"
                onClick={() => void reconcile()}
              >
                {busy === "reconcile" ? "Reconciling…" : "Reconcile"}
              </button>
            </div>

            {actions != null && (
              <div className="small" style={{ marginTop: 6 }}>
                {actions.length === 0 ? (
                  <span className="dim">reconcile found nothing to fix</span>
                ) : (
                  actions.slice(0, 8).map((a, i) => (
                    <div className="mono small dim" key={i}>
                      {Object.entries(a).map(([k, v]) => `${k}=${String(v)}`).join(" · ")}
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
