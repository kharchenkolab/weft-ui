/**
 * "What did this run leave behind?" — weft's retention tiers on a run:
 *   knowledge  — run_inventory, recorded at terminal state, survives all
 *   sandbox    — the run dir on the site (run_discard reclaims it now)
 *   holdings   — retained plain files (run_retain … run_forget)
 * Triage is the point: per-file checkboxes, a glob quick-select, and a
 * label that groups runs into one host-side unit. On a LIVE run, Retain
 * records a pin — files are captured when the run settles, never torn.
 */

import { useCallback, useEffect, useState } from "react";
import type { RetainedRun, RunInventory } from "@shared/types";
import { wtool } from "../api/client";
import { Api, fmtBytes, fmtWhen } from "../bits";
import { act } from "../state";

const SHOW = 8; // biggest-first preview; "show all" expands

// weft's own run plumbing (top-level fixed names) — collapsed by default
// so the list reads as YOUR files. Name-list until weft flags these
// (upstream ask on file); only exact top-level names match.
const SCAFFOLD = new Set([
  "activate.sh", "cmd.sh", "exit_code", "log", "log.err", "node",
  "pid", "pid.real", "rc", "runner.sh", "rusage", "wall_s",
  // kernel plumbing (the transcript itself lives in the store)
  "driver.py", "kernel.stop", "kernel.pid", "kernel.log",
]);

export function retainedStatePill(state: string): string {
  if (["ready", "done"].includes(state)) return "s-done";
  if (state === "failed") return "s-failed";
  if (state.includes("pin")) return "s-queued"; // pinned-pending: waiting on settle
  return "s-running";
}

export function RunRetention({
  target,
  live = false,
  dir,
}: {
  target: string;
  live?: boolean;
  /** the run's folder on the site, when the caller knows it */
  dir?: string | null;
}) {
  const [inv, setInv] = useState<RunInventory | "none" | null>(null);
  const [retained, setRetained] = useState<RetainedRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [glob, setGlob] = useState("");
  const [label, setLabel] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [showScaffold, setShowScaffold] = useState(false);

  const load = useCallback(() => {
    if (!live)
      wtool<RunInventory>("run_inventory", { target }).then((r) =>
        setInv(r && !r.error ? r : "none"),
      );
    wtool<RetainedRun[]>("retained_runs", {}).then(
      (rows) => Array.isArray(rows) && setRetained(rows.filter((r) => r.target === target)),
    );
  }, [target, live]);

  useEffect(() => {
    setInv(null);
    setRetained([]);
    setSel(new Set());
    setGlob("");
    setShowAll(false);
    setShowScaffold(false);
    load();
  }, [load]);

  const run = async (key: string, tool: string, args: Record<string, unknown>) => {
    setBusy(key);
    await act(tool, args);
    load();
    setBusy(null);
  };

  const retainArgs = (include?: string[]) => ({
    target,
    ...(include && include.length ? { include } : {}),
    ...(label.trim() ? { label: label.trim(), layout: "label" } : {}),
  });

  const retainedBlock = retained.length > 0 && (
    <div style={{ marginTop: 10 }}>
      <div className="dim small" style={{ marginBottom: 4 }}>retained</div>
      {retained.map((r) => (
        <div className="row small" key={`${r.site}:${r.location}`} style={{ gap: 8, padding: "2px 0" }}>
          <span className={`pill ${retainedStatePill(r.state)}`}>{r.state.toUpperCase()}</span>
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
  );

  // ---- live run: retain = pin-at-settlement ------------------------------
  if (live)
    return (
      <div className="sec">
        <div className="sec-h">
          Files
          <span className="right">
            <Api>run_retain (pin)</Api>
          </span>
        </div>
        {dir && (
          <div className="dim small mono" style={{ marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title="the run's working folder on the site">
            {dir}
          </div>
        )}
        <div className="dim small" style={{ marginBottom: 6 }}>
          this run is live — Retain records a <b>pin</b>: the selection is
          captured when the run settles (the eventual complete files, never
          a torn snapshot)
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <input
            className="mono"
            style={{ flex: "1 1 140px", fontSize: 11.5, padding: "3px 8px", border: "1px solid var(--line)", borderRadius: 6 }}
            placeholder="glob (default: everything), e.g. results/*"
            value={glob}
            onChange={(e) => setGlob(e.target.value)}
          />
          <input
            style={{ flex: "0 1 130px", fontSize: 11.5, padding: "3px 8px", border: "1px solid var(--line)", borderRadius: 6 }}
            placeholder="label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button
            className="btn sm"
            disabled={busy != null}
            onClick={() => void run("retain", "run_retain", retainArgs(glob.trim() ? [glob.trim()] : undefined))}
          >
            {busy === "retain" ? "Pinning…" : "Retain (pin)"}
          </button>
        </div>
        {retainedBlock}
      </div>
    );

  // ---- settled run: triage the inventory ----------------------------------
  if (inv === null) return null; // still fetching
  const entries = inv === "none" ? [] : [...inv.entries].sort((a, b) => b.bytes - a.bytes);
  const isScaffold = (p: string) =>
    (!p.includes("/") && SCAFFOLD.has(p)) || p.startsWith("blocks/");
  const userEntries = entries.filter((e) => !isScaffold(e.path));
  const scaffoldEntries = entries.filter((e) => isScaffold(e.path));
  const listed = [
    ...(showAll ? userEntries : userEntries.slice(0, SHOW)),
    ...(showScaffold ? scaffoldEntries : []),
  ];
  const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);
  const toggle = (p: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const globMatches = () => {
    // quick-select entries matching the glob — same semantics as weft's
    // server-side fnmatch (`*` matches across slashes)
    const rx = new RegExp(
      "^" + glob.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    );
    setSel(new Set(entries.filter((e) => rx.test(e.path)).map((e) => e.path)));
  };

  return (
    <div className="sec">
      <div className="sec-h">
        Files
        <span className="right">
          <Api>run_inventory · run_retain · run_forget</Api>
        </span>
      </div>
      {dir && (
        <div
          className="dim small mono"
          style={{ marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={"the run's sandbox folder on the site — files live here until retained or discarded"}
        >
          {dir}
        </div>
      )}

      {inv === "none" ? (
        <div className="faint small">
          no inventory recorded — the run predates weft&apos;s retention tier, or its
          site&apos;s shim does (re-registering the site upgrades the shim)
        </div>
      ) : (
        <>
          <table className="tbl parts-tbl">
            <thead>
              <tr>
                <th style={{ width: 22 }}>
                  <input
                    type="checkbox"
                    checked={sel.size > 0 && sel.size >= userEntries.length}
                    title="select all / none"
                    onChange={(e) =>
                      setSel(e.target.checked ? new Set(userEntries.map((x) => x.path)) : new Set())
                    }
                  />
                </th>
                <th>file</th>
                <th className="r">size</th>
                <th className="r">modified</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((e) => (
                <tr key={e.path} onClick={() => toggle(e.path)} style={{ cursor: "pointer" }}>
                  <td>
                    <input type="checkbox" checked={sel.has(e.path)} readOnly />
                  </td>
                  <td
                    className={`mono small${isScaffold(e.path) ? " dim" : ""}`}
                    style={{ maxWidth: 250, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={e.path}
                  >
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
            {userEntries.length > SHOW && !showAll && (
              <>
                {" · "}
                <a className="id plain" onClick={() => setShowAll(true)}>show all {userEntries.length}</a>
              </>
            )}
            {scaffoldEntries.length > 0 && (
              <>
                {" · "}
                <a className="id plain" onClick={() => setShowScaffold(!showScaffold)}>
                  {showScaffold ? "hide" : "show"} {scaffoldEntries.length} weft runner files
                </a>
              </>
            )}
            {inv.truncated ? " · recording hit its budget (counts honest, list not exhaustive)" : ""}
            {" · recorded "}{fmtWhen(inv.recorded_at)}
          </div>
          <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: "wrap" }}>
            <input
              className="mono"
              style={{ flex: "1 1 130px", fontSize: 11.5, padding: "3px 8px", border: "1px solid var(--line)", borderRadius: 6 }}
              placeholder="glob quick-select, e.g. results/*"
              value={glob}
              onChange={(e) => setGlob(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && glob.trim() && globMatches()}
            />
            <button className="btn sm ghost" disabled={!glob.trim()} onClick={globMatches}>
              Select matching
            </button>
            <input
              style={{ flex: "0 1 120px", fontSize: 11.5, padding: "3px 8px", border: "1px solid var(--line)", borderRadius: 6 }}
              placeholder="label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <button
              className="btn sm"
              disabled={busy != null}
              title={
                sel.size
                  ? `retain the ${sel.size} selected file${sel.size === 1 ? "" : "s"} as plain files ⌁ run_retain(include=[…])`
                  : "retain everything the run left as plain files ⌁ run_retain"
              }
              onClick={() => void run("retain", "run_retain", retainArgs([...sel]))}
            >
              {busy === "retain" ? "Retaining…" : sel.size ? `Retain ${sel.size} selected` : "Retain all"}
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

      {retainedBlock}
    </div>
  );
}
