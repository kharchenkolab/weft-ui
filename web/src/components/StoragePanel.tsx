/**
 * Storage panel (site detail): what occupies the site and every lever
 * that reclaims it, in one place — realized envs (evict above), the
 * shared package cache (consequential: clearing trades seconds-offline
 * rebuilds for disk), the data cache (re-stages on demand), orphan dirs
 * no record claims, and the gc_plan/gc_sweep pair for the rest. Nothing
 * deletes implicitly: every destructive lever plans first, then confirms.
 */

import { useState } from "react";
import type { FootprintInfo } from "@shared/types";
import { wtool } from "../api/client";
import { Api, fmtBytes } from "../bits";
import { act } from "../state";

interface GcPlanSite {
  idle_days_policy?: number;
  evictable_realizations?: { env_id: string; bytes?: number }[];
  evictable_refs?: { ref: string; bytes: number; pinned_locally?: boolean }[];
  run_remains_days_policy?: number | null;
  run_remains?: { target: string; age_days: number }[];
  session_idle_days_policy?: number | null;
  idle_sessions?: { session_id: string; idle_days: number }[];
  reclaimable_bytes?: number;
}

interface PkgPlan {
  cache_bytes?: number;
  cache_bytes_note?: string;
  ready_realizations?: number;
  note?: string;
  error?: string;
  detail?: string;
}

export function StoragePanel({
  site,
  footprint,
  onChanged,
}: {
  site: string;
  footprint: FootprintInfo | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [pkgPlan, setPkgPlan] = useState<PkgPlan | null>(null);
  const [plan, setPlan] = useState<GcPlanSite | null>(null);
  const [showOrphans, setShowOrphans] = useState(false);

  if (!footprint || footprint.error) return null;
  const n = (k: string) => (typeof footprint[k] === "number" ? (footprint[k] as number) : 0);
  const orphans = (footprint.orphans as { area: string; name: string; bytes: number }[]) ?? [];
  const realBytes = (footprint.realizations ?? []).reduce((s, r) => s + ((r.bytes as number) ?? 0), 0);

  const run = async (key: string, tool: string, args: Record<string, unknown>) => {
    setBusy(key);
    await act(tool, args);
    setBusy(null);
    onChanged();
  };

  return (
    <div className="sec">
      <div className="sec-h">
        Footprint &amp; reclaim
        <span className="right">
          <Api>site_footprint · gc_plan · gc_packages · gc_orphans · gc_sweep</Api>
        </span>
      </div>
      <div className="dim small" style={{ marginBottom: 6 }}>
        {fmtBytes(n("free_bytes"))} free on the filesystem — area sizes are apparent (du) and
        share hardlinked blocks, so they can sum to more than they occupy
      </div>

      <table className="tbl parts-tbl">
        <tbody>
          <tr>
            <td>environments</td>
            <td className="r num">{fmtBytes(realBytes || n("prefixes_bytes"))}</td>
            <td className="dim small">
              {(footprint.realizations ?? []).length} realization
              {(footprint.realizations ?? []).length === 1 ? "" : "s"} — evict individually in
              Environments above; rebuilds are seconds while the package cache is warm
            </td>
            <td />
          </tr>
          <tr>
            <td>package cache</td>
            <td className="r num">{fmtBytes(n("package_cache_bytes"))}</td>
            <td className="dim small">
              shared across envs — keeps rebuilds offline-fast; clearing makes evicted envs
              need index access to come back
            </td>
            <td className="r">
              {pkgPlan == null ? (
                <button
                  className="btn sm"
                  disabled={busy != null}
                  title="dry-run first: what clearing would free, and what it would cost ⌁ gc_packages"
                  onClick={async () => {
                    setBusy("pkg-plan");
                    setPkgPlan(await wtool<PkgPlan>("gc_packages", { site }));
                    setBusy(null);
                  }}
                >
                  Clear…
                </button>
              ) : (
                <button
                  className="btn sm danger"
                  disabled={busy != null}
                  title={pkgPlan.note ?? ""}
                  onClick={() =>
                    void run("pkg", "gc_packages", { site, confirm: true, _confirm: true }).then(() =>
                      setPkgPlan(null),
                    )
                  }
                >
                  {busy === "pkg" ? "Clearing…" : `Confirm clear ${fmtBytes(pkgPlan.cache_bytes ?? 0)}`}
                </button>
              )}
            </td>
          </tr>
          {pkgPlan && (
            <tr>
              <td />
              <td colSpan={3} className="dim small">
                {pkgPlan.error
                  ? `${pkgPlan.error} — ${pkgPlan.detail ?? ""}`
                  : `${pkgPlan.ready_realizations ?? 0} ready realization(s) keep their prefixes; ${pkgPlan.cache_bytes_note ?? ""} `}
                <a className="id plain" onClick={() => setPkgPlan(null)}>cancel</a>
              </td>
            </tr>
          )}
          <tr>
            <td>data cache</td>
            <td className="r num">{fmtBytes(n("data_cache_bytes"))}</td>
            <td className="dim small">staged inputs — swept below; re-stage on next use</td>
            <td />
          </tr>
          <tr>
            <td>
              orphans
              {orphans.length > 0 && (
                <a className="id plain small" style={{ marginLeft: 6 }} onClick={() => setShowOrphans(!showOrphans)}>
                  {showOrphans ? "hide" : "list"}
                </a>
              )}
            </td>
            <td className="r num">{fmtBytes(n("orphan_bytes"))}</td>
            <td className="dim small">
              {orphans.length
                ? `${orphans.length} dir${orphans.length === 1 ? "" : "s"} no record claims (crashed sessions, stale kernel sandboxes)`
                : "none — every directory is accounted for"}
            </td>
            <td className="r">
              {orphans.length > 0 && (
                <button
                  className="btn sm danger"
                  disabled={busy != null}
                  title="remove directories no record claims — bytes nothing else can reclaim ⌁ gc_orphans(confirm)"
                  onClick={() => void run("orphans", "gc_orphans", { site, confirm: true, _confirm: true })}
                >
                  {busy === "orphans" ? "Removing…" : "Remove"}
                </button>
              )}
            </td>
          </tr>
          {showOrphans &&
            orphans.map((o) => (
              <tr key={`${o.area}/${o.name}`}>
                <td />
                <td colSpan={3} className="mono small dim">
                  {o.area}/{o.name} · {fmtBytes(o.bytes)}
                </td>
              </tr>
            ))}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: "wrap" }}>
        {plan == null ? (
          <button
            className="btn sm"
            disabled={busy != null}
            title="dry-run eviction plan: idle realizations, stale cached refs, past-TTL sandboxes — free to call ⌁ gc_plan"
            onClick={async () => {
              setBusy("plan");
              const r = await wtool<{ sites?: Record<string, GcPlanSite> }>("gc_plan", { site });
              setPlan(r?.sites?.[site] ?? {});
              setBusy(null);
            }}
          >
            {busy === "plan" ? "Planning…" : "Plan reclaim"}
          </button>
        ) : (
          <>
            <span className="small">
              plan: <b className="num">{fmtBytes(plan.reclaimable_bytes ?? 0)}</b> in stale cached refs
              ({(plan.evictable_refs ?? []).length}) · {(plan.evictable_realizations ?? []).length} idle env
              {(plan.evictable_realizations ?? []).length === 1 ? "" : "s"} past policy
              {plan.run_remains_days_policy != null
                ? ` · ${(plan.run_remains ?? []).length} sandbox(es) past the ${plan.run_remains_days_policy}d TTL`
                : " · sandbox TTL off (opt-in)"}
              {(plan.idle_sessions ?? []).length > 0 && ` · ${(plan.idle_sessions ?? []).length} idle session(s)`}
            </span>
            <button
              className="btn sm danger"
              disabled={busy != null}
              title="execute the plan — evicted content re-stages/rebuilds on next use ⌁ gc_sweep(confirm)"
              onClick={() => void run("sweep", "gc_sweep", { site, confirm: true, _confirm: true }).then(() => setPlan(null))}
            >
              {busy === "sweep" ? "Sweeping…" : "Sweep"}
            </button>
            <a className="id plain small" onClick={() => setPlan(null)}>cancel</a>
          </>
        )}
      </div>
      <p className="small faint" style={{ marginTop: 5 }}>
        nothing deletes implicitly — every lever plans first, then confirms; retained files and
        inventories are never candidates
      </p>
    </div>
  );
}
