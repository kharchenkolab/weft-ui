/**
 * "What did this run leave behind?" — weft's retention tiers on a run:
 *   knowledge  — run_inventory, recorded at terminal state, survives all
 *   sandbox    — the run dir on the site (run_discard reclaims it now)
 *   holdings   — retained plain files (run_retain … run_forget)
 * Pipeline runs leave hundreds of files, so the inventory renders as a
 * DIRECTORY ROLLUP: collapsed dir rows with aggregate size/count,
 * selectable at the directory level — a dir selection becomes
 * include=["dir/"], which weft expands server-side, so it honestly covers
 * files the truncated inventory never listed. On a LIVE run, Retain
 * records a pin — files are captured when the run settles, never torn.
 */

import { useCallback, useEffect, useState } from "react";
import type { RetainedRun, RunInventory, RunInventoryEntry } from "@shared/types";
import { wtool } from "../api/client";
import { Api, fmtBytes, fmtWhen } from "../bits";
import { act, store } from "../state";

const FILES_PER_DIR = 10; // biggest-first per directory; a link expands the rest

// fallback classification for payloads predating weft's scaffold flag —
// entries now carry `scaffold: true` from the substrate itself
const SCAFFOLD = new Set([
  "activate.sh", "cmd.sh", "exit_code", "log", "log.err", "node",
  "pid", "pid.real", "rc", "runner.sh", "rusage", "wall_s",
  // kernel plumbing (the transcript itself lives in the store)
  "driver.py", "kernel.stop", "kernel.pid", "kernel.log",
]);

/** retention2 placement: where did (or would) the keeps land */
export function placementWord(r: RetainedRun): string {
  if (r.in_place) return r.moved ? "on-site keep" : "marked in place";
  return "shipped home";
}

/** forget's honest consequence depends on placement */
export function forgetTitle(r: { in_place?: boolean }): string {
  return r.in_place && !("moved" in r && r.moved)
    ? "release the retention mark — nothing is deleted (the files are yours, " +
      "in place); the inventory record survives ⌁ run_forget"
    : "delete the retained copies and drop them from the index — the " +
      "inventory record survives ⌁ run_forget";
}

export function retainedStatePill(state: string): string {
  if (["ready", "done"].includes(state)) return "s-done";
  if (state === "failed") return "s-failed";
  if (state.includes("pin")) return "s-queued"; // pinned-pending: waiting on settle
  return "s-running";
}

interface TreeDir {
  /** selector form, trailing slash — exactly what run_retain's include takes */
  path: string;
  name: string;
  dirs: TreeDir[];
  files: RunInventoryEntry[];
  bytes: number;
  count: number;
}

function buildTree(entries: RunInventoryEntry[]): TreeDir {
  const root: TreeDir = { path: "", name: "", dirs: [], files: [], bytes: 0, count: 0 };
  const byPath = new Map<string, TreeDir>([["", root]]);
  const dirFor = (dirPath: string): TreeDir => {
    const hit = byPath.get(dirPath);
    if (hit) return hit;
    const parentPath = dirPath.replace(/[^/]+\/$/, "");
    const parent = dirFor(parentPath);
    const node: TreeDir = {
      path: dirPath,
      name: dirPath.slice(parentPath.length),
      dirs: [], files: [], bytes: 0, count: 0,
    };
    parent.dirs.push(node);
    byPath.set(dirPath, node);
    return node;
  };
  for (const e of entries) {
    const idx = e.path.lastIndexOf("/");
    const dir = dirFor(idx < 0 ? "" : e.path.slice(0, idx + 1));
    dir.files.push(e);
    // roll bytes/count up the ancestry
    for (let p = dir; ; p = byPath.get(p.path.replace(/[^/]+\/$/, ""))!) {
      p.bytes += e.bytes;
      p.count += 1;
      if (p.path === "") break;
    }
  }
  const sortRec = (n: TreeDir) => {
    n.dirs.sort((a, b) => b.bytes - a.bytes);
    n.files.sort((a, b) => b.bytes - a.bytes);
    n.dirs.forEach(sortRec);
  };
  sortRec(root);
  return root;
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
  // selection entries are file paths or dir selectors ("results/")
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [allFiles, setAllFiles] = useState<Set<string>>(new Set()); // dirs with the per-dir cap lifted
  const [glob, setGlob] = useState("");
  const [label, setLabel] = useState("");
  const [showScaffold, setShowScaffold] = useState(false);
  // retention2: the site declared no durable storage — the refusal's
  // levers render as a card (ship home / declare durable on re-register)
  const [noDurable, setNoDurable] = useState<{ include?: string[]; hint?: string } | null>(null);

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
    setOpen(new Set());
    setAllFiles(new Set());
    setGlob("");
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

  // retain speaks retention2: placement is the SITE's story (mark in place
  // on durable storage, hop to its declared path) — weft refuses when it
  // has nowhere durable, and the refusal's levers become buttons here
  const doRetain = async (include?: string[], dest?: string) => {
    setBusy("retain");
    setNoDurable(null);
    const r = await wtool<Record<string, any>>("run_retain", {
      ...retainArgs(include),
      ...(dest ? { dest } : {}),
    });
    if (r?.error === "retain.no_durable") {
      setNoDurable({ include, hint: r.hints?.registration_hint });
    } else if (r?.error) {
      store.toast("err", `⌁ run_retain: ${r.error} — ${r.detail ?? ""}`);
    } else {
      store.toast("ok", "⌁ run_retain: ok");
      load();
    }
    setBusy(null);
  };

  const noDurableCard = noDurable && (
    <div className="banner warn" style={{ margin: "8px 0", display: "block" }}>
      <b>nowhere durable on this site</b> — it declares no storage that
      survives; say where these files should live
      <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
        <button
          className="btn sm"
          disabled={busy != null}
          title="transfer the selection to the controller's workspace ⌁ run_retain(dest='@workspace')"
          onClick={() => void doRetain(noDurable.include, "@workspace")}
        >
          {busy === "retain" ? "Shipping…" : "Ship to workspace"}
        </button>
        <span className="dim small">
          or re-register the site with <span className="mono">durable=true</span> (its root is safe)
          or <span className="mono">durable=/abs/path</span> — then Retain marks files in place,
          moving nothing{noDurable.hint ? ` — ${noDurable.hint}` : ""}
        </span>
      </div>
    </div>
  );

  const retainedBlock = retained.length > 0 && (
    <div style={{ marginTop: 10 }}>
      <div className="dim small" style={{ marginBottom: 4 }}>retained</div>
      {retained.map((r) => (
        <div className="row small" key={`${r.site}:${r.location}`} style={{ gap: 8, padding: "2px 0" }}>
          <span className={`pill ${retainedStatePill(r.state)}`}>{r.state.toUpperCase()}</span>
          <span className="mono small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 }} title={r.location}>
            {r.location}
          </span>
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
          {r.label && <span className="chip quiet">{r.label}</span>}
          <span className="num dim nowrap">
            {r.files} file{r.files === 1 ? "" : "s"} · {fmtBytes(r.bytes)}
          </span>
          <span className="right-al">
            <button
              className="btn sm"
              disabled={busy != null}
              title={forgetTitle(r)}
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
            onClick={() => void doRetain(glob.trim() ? [glob.trim()] : undefined)}
          >
            {busy === "retain" ? "Pinning…" : "Retain (pin)"}
          </button>
        </div>
        {noDurableCard}
        {retainedBlock}
      </div>
    );

  // ---- settled run: triage the inventory as a directory rollup ------------
  if (inv === null) return null; // still fetching
  const entries = inv === "none" ? [] : inv.entries;
  // trust the substrate's scaffold flag; fall back to the name-set only
  // for inventories recorded before weft carried it
  const isScaffold = (e: RunInventoryEntry) =>
    e.scaffold ?? ((!e.path.includes("/") && SCAFFOLD.has(e.path)) || e.path.startsWith("blocks/"));
  const userEntries = entries.filter((e) => !isScaffold(e));
  const scaffoldEntries = entries.filter((e) => isScaffold(e));
  const tree = buildTree(showScaffold ? entries : userEntries);
  const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);

  const ancestorSelected = (path: string): boolean => {
    let p = path;
    for (;;) {
      const cut = p.lastIndexOf("/", p.endsWith("/") ? p.length - 2 : p.length - 1);
      if (cut < 0) return false;
      p = p.slice(0, cut + 1);
      if (sel.has(p)) return true;
    }
  };
  const isSelected = (path: string) => sel.has(path) || ancestorSelected(path);
  const toggle = (key: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const effectiveCount = entries.filter((e) => isSelected(e.path)).length;
  const selHasDirs = [...sel].some((k) => k.endsWith("/"));

  const globMatches = () => {
    // quick-select entries matching the glob — same semantics as weft's
    // server-side fnmatch (`*` matches across slashes)
    const rx = new RegExp(
      "^" + glob.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    );
    setSel(new Set(entries.filter((e) => rx.test(e.path)).map((e) => e.path)));
  };

  const topKeys = [...tree.dirs.map((d) => d.path), ...tree.files.map((f) => f.path)];
  const allTopSelected = topKeys.length > 0 && topKeys.every((k) => sel.has(k));

  const rows: JSX.Element[] = [];
  const emitDir = (node: TreeDir, depth: number) => {
    const opened = open.has(node.path);
    const anc = ancestorSelected(node.path);
    rows.push(
      <tr key={node.path} style={{ cursor: "pointer" }}>
        <td onClick={(e) => { e.stopPropagation(); if (!anc) toggle(node.path); }}>
          <input type="checkbox" checked={anc || sel.has(node.path)} disabled={anc} readOnly
                 title={anc ? "covered by a selected parent folder" : "select the whole folder — retains everything under it, listed or not"} />
        </td>
        <td className="mono small" style={{ paddingLeft: 8 + depth * 16 }}
            onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(node.path)) n.delete(node.path); else n.add(node.path); return n; })}>
          <span className="chev">{opened ? "▾" : "▸"}</span> <b>{node.name}</b>
        </td>
        <td className="r num">{fmtBytes(node.bytes)}</td>
        <td className="r num dim">{node.count.toLocaleString()} file{node.count === 1 ? "" : "s"}</td>
      </tr>,
    );
    if (!opened) return;
    node.dirs.forEach((d) => emitDir(d, depth + 1));
    emitFiles(node, depth + 1);
  };
  const emitFiles = (node: TreeDir, depth: number) => {
    const cap = allFiles.has(node.path) ? node.files.length : FILES_PER_DIR;
    node.files.slice(0, cap).forEach((e) => {
      const anc = isSelected(e.path);
      rows.push(
        <tr key={e.path} onClick={() => { if (!ancestorSelected(e.path)) toggle(e.path); }} style={{ cursor: "pointer" }}>
          <td>
            <input type="checkbox" checked={anc} disabled={ancestorSelected(e.path)} readOnly />
          </td>
          <td className={`mono small${isScaffold(e) ? " dim" : ""}`}
              style={{ paddingLeft: 8 + depth * 16, maxWidth: 250, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={e.path}>
            {e.path.slice(node.path.length)}
          </td>
          <td className="r num">{fmtBytes(e.bytes)}</td>
          <td className="r num dim">{fmtWhen(e.mtime)}</td>
        </tr>,
      );
    });
    if (node.files.length > cap)
      rows.push(
        <tr key={`${node.path}~more`}>
          <td />
          <td colSpan={3} className="dim small" style={{ paddingLeft: 8 + depth * 16 }}>
            <a className="id plain" onClick={() => setAllFiles((s) => new Set(s).add(node.path))}>
              show {node.files.length - cap} more file{node.files.length - cap === 1 ? "" : "s"}
            </a>
            {" — or select the folder above to retain them all"}
          </td>
        </tr>,
      );
  };
  tree.dirs.forEach((d) => emitDir(d, 0));
  emitFiles(tree, 0);

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
                    checked={allTopSelected}
                    title="select everything / nothing"
                    onChange={(e) => setSel(e.target.checked ? new Set(topKeys) : new Set())}
                  />
                </th>
                <th>file</th>
                <th className="r">size</th>
                <th className="r"></th>
              </tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
          <div className="dim small" style={{ marginTop: 4 }}>
            {inv.total_files.toLocaleString()} file{inv.total_files === 1 ? "" : "s"} ·{" "}
            {fmtBytes(totalBytes)}
            {scaffoldEntries.length > 0 && (
              <>
                {" · "}
                <a className="id plain" onClick={() => setShowScaffold(!showScaffold)}>
                  {showScaffold ? "hide" : "show"} {scaffoldEntries.length} weft runner files
                </a>
              </>
            )}
            {inv.truncated
              ? " · recording hit its budget (counts honest, the listing is not exhaustive — folder selections still retain everything)"
              : ""}
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
                (sel.size
                  ? `retain the selection ⌁ run_retain(include=[…]) — folder selections cover everything under them`
                  : "retain everything the run produced ⌁ run_retain") +
                " · placement is the site's story: durable sites mark files in place (nothing moves); otherwise weft asks where they should live"
              }
              onClick={() => void doRetain([...sel])}
            >
              {busy === "retain"
                ? "Retaining…"
                : sel.size
                  ? `Retain ${effectiveCount.toLocaleString()}${selHasDirs && inv.truncated ? "+" : ""} selected`
                  : "Retain all"}
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
          {noDurableCard}
        </>
      )}

      {retainedBlock}
    </div>
  );
}
