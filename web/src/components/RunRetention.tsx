/**
 * "What did this run leave behind?" — weft's retention tiers on a
 * terminal run (job or kernel):
 *   knowledge  — run_inventory, recorded at terminal state, survives all
 *   sandbox    — the run dir on the site (run_discard reclaims it now)
 *   holdings   — retained plain files (run_retain … run_forget)
 * The section is honest about what each action deletes and what survives.
 */

import { useCallback, useEffect, useState } from "react";
import type { RetainedRun, RunInventory } from "@shared/types";
import { wtool } from "../api/client";
import { Api, fmtBytes, fmtWhen } from "../bits";
import { act } from "../state";

const SHOW = 8; // biggest-first preview; the count line carries the rest

export function RunRetention({ target }: { target: string }) {
  const [inv, setInv] = useState<RunInventory | "none" | null>(null);
  const [retained, setRetained] = useState<RetainedRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    wtool<RunInventory>("run_inventory", { target }).then((r) =>
      setInv(r && !r.error ? r : "none"),
    );
    wtool<RetainedRun[]>("retained_runs", {}).then(
      (rows) => Array.isArray(rows) && setRetained(rows.filter((r) => r.target === target)),
    );
  }, [target]);

  useEffect(() => {
    setInv(null);
    setRetained([]);
    load();
  }, [load]);

  const run = async (key: string, tool: string, args: Record<string, unknown>) => {
    setBusy(key);
    await act(tool, args);
    load();
    setBusy(null);
  };

  if (inv === null) return null; // still fetching — the section appears when it knows
  const entries = inv === "none" ? [] : [...inv.entries].sort((a, b) => b.bytes - a.bytes);
  const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);

  return (
    <div className="sec">
      <div className="sec-h">
        Left behind
        <span className="right">
          <Api>run_inventory · run_retain · run_forget</Api>
        </span>
      </div>

      {inv === "none" ? (
        <div className="faint small">
          no inventory recorded — runs finished before weft&apos;s retention tier have none
        </div>
      ) : (
        <>
          <table className="tbl parts-tbl">
            <thead>
              <tr>
                <th>file</th>
                <th className="r">size</th>
                <th className="r">modified</th>
              </tr>
            </thead>
            <tbody>
              {entries.slice(0, SHOW).map((e) => (
                <tr key={e.path}>
                  <td className="mono small" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.path}>
                    {e.path}
                  </td>
                  <td className="r num">{fmtBytes(e.bytes)}</td>
                  <td className="r num dim">{fmtWhen(e.mtime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="dim small" style={{ marginTop: 4 }}>
            {inv.total_files.toLocaleString()} file{inv.total_files === 1 ? "" : "s"} ·{" "}
            {fmtBytes(totalBytes)}
            {entries.length > SHOW ? ` · showing the ${SHOW} largest` : ""}
            {inv.truncated ? " · inventory hit its recording budget (counts are honest, the list is not exhaustive)" : ""}
            {" · recorded "}{fmtWhen(inv.recorded_at)}
          </div>
          <div className="row" style={{ marginTop: 8, gap: 6 }}>
            <button
              className="btn sm"
              disabled={busy != null}
              title="copy everything the run left into <workspace>/runs/<target>/ as plain files (background transfer for remote sites) ⌁ run_retain"
              onClick={() => void run("retain", "run_retain", { target })}
            >
              {busy === "retain" ? "Retaining…" : "Retain files"}
            </button>
            <button
              className="btn sm"
              disabled={busy != null}
              title="delete the run's sandbox on the site NOW — retained files and this inventory survive ⌁ run_discard"
              onClick={() => void run("discard", "run_discard", { target })}
            >
              {busy === "discard" ? "Discarding…" : "Discard sandbox"}
            </button>
          </div>
        </>
      )}

      {retained.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="dim small" style={{ marginBottom: 4 }}>retained</div>
          {retained.map((r) => (
            <div className="row small" key={`${r.site}:${r.location}`} style={{ gap: 8, padding: "2px 0" }}>
              <span className={`pill ${["ready", "done"].includes(r.state) ? "s-done" : r.state === "failed" ? "s-failed" : "s-running"}`}>
                {r.state.toUpperCase()}
              </span>
              <span className="mono small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 }} title={r.location}>
                {r.location}
              </span>
              {r.label && <span className="chip quiet">{r.label}</span>}
              <span className="num dim nowrap">
                {r.files} file{r.files === 1 ? "" : "s"} · {fmtBytes(r.bytes)}
              </span>
              <span className="right-al">
                <button
                  className="btn sm"
                  disabled={busy != null}
                  title="delete the retained bytes and drop them from the index — the inventory record survives ⌁ run_forget"
                  onClick={() => void run("forget", "run_forget", { target, _confirm: true })}
                >
                  {busy === "forget" ? "Forgetting…" : "Forget"}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
