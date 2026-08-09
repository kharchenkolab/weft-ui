/**
 * FootprintCard (M11): the uniform "what does this occupy, everywhere"
 * face over uiapi /footprint — and, armed, the ONE cleanup surface.
 * Every line is a tier at a place in plain words; no taxonomy
 * vocabulary reaches the user. Armed mode pre-checks only what weft
 * itself confirms is safe: every data_evict call is dry-run first
 * (weft's evaluator is the single authority — refused refs are set
 * aside and said out loud, never silently attempted). Execution runs
 * dependency-ordered: keeps → sandboxes → envs → site copies → cache.
 */

import { useEffect, useMemo, useState } from "react";
import type { Footprint, FootprintLine } from "@shared/types";
import { api, wtool } from "../api/client";
import { Api, fmtBytes } from "../bits";
import { navigate } from "../router";
import { store } from "../state";

export function lineWords(l: FootprintLine): { what: string; note: string; warn?: boolean } {
  switch (l.tier) {
    case "keep":
      return {
        what: `results kept on ${l.site}`,
        note: l.strands
          ? `holds the only copy of ${l.strands} file${l.strands === 1 ? "" : "s"} — forgetting is forever`
          : "weft holds these until you forget",
        warn: !!l.strands,
      };
    case "sandbox":
      return {
        what: `run folder on ${l.site}`,
        note: "as recorded at finish — the site may have swept it already",
      };
    case "env":
      return {
        what: `env build on ${l.site}`,
        note: l.shared
          ? `also used by ${l.shared} other run${l.shared === 1 ? "" : "s"} — it would rebuild once`
          : "rebuilds itself if ever needed",
      };
    case "copies":
      return { what: `data copies on ${l.site}`, note: "weft can restage these anytime" };
    case "external":
      return {
        what: `your original files on ${l.site}`,
        note: "registered in place — weft never touches them",
      };
    case "cache":
      return { what: "weft's local cache", note: "re-fetchable from keeps or sites" };
    case "saved":
      return { what: "your saved files", note: "in the workspace — yours; weft doesn't manage them" };
    case "records":
      return { what: "the record", note: "job history, file listings, fingerprints — permanent, tiny" };
  }
  return { what: l.tier, note: "" };
}

function amount(l: FootprintLine): string {
  const parts: string[] = [];
  if (l.bytes != null) parts.push(fmtBytes(l.bytes));
  if (typeof l.files === "number") parts.push(`${l.files} file${l.files === 1 ? "" : "s"}`);
  else if (l.count != null)
    parts.push(`${l.count} ${l.tier === "saved" ? "file" : "dataset"}${l.count === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

const ACTIONABLE = new Set(["keep", "sandbox", "env", "copies", "cache"]);
// dependency order: destroy keeps first (their receipts name strands),
// then sandboxes, then envs, then data copies (site before cache)
const EXEC_ORDER = ["keep", "sandbox", "env", "copies", "cache"];

/** one line's armed plan: the calls weft agreed to, what it set aside */
interface Plan {
  calls: Record<string, unknown>[];
  free: number;          // bytes weft says these calls would free
  aside: number;         // refs weft refused in dry-run (said, not hidden)
  asideWhy: string;
  checked: boolean;
}

const REFUSAL_WORDS: Record<string, string> = {
  "data.last_copy": "the only copy",
  "data.pinned": "held by provenance",
  "data.external_home": "not weft's to delete",
};

export function FootprintCard({ scope, showRunNames = false, onCleaned }: {
  scope: string;
  /** campaign/site scopes: several runs contribute — name each line's run */
  showRunNames?: boolean;
  onCleaned?: () => void;
}) {
  const [fp, setFp] = useState<Footprint | null>(null);
  const [bump, setBump] = useState(0);
  const [mode, setMode] = useState<"view" | "arming" | "armed" | "running" | "done">("view");
  const [plans, setPlans] = useState<Map<number, Plan>>(new Map());
  const [progress, setProgress] = useState("");
  const [receipt, setReceipt] = useState<string[]>([]);

  useEffect(() => {
    setFp(null);
    setMode("view");
    void api.footprint(scope).then(setFp, () => setFp(null));
  }, [scope, bump]);

  const lines = fp?.lines ?? [];

  // arm: every data_evict is dry-run against weft's evaluator; other
  // verbs (forget/discard/evict) have no preview — their consequence
  // sentences carry the honesty instead
  const arm = async () => {
    if (!fp) return;
    setMode("arming");
    const next = new Map<number, Plan>();
    for (let i = 0; i < fp.lines.length; i++) {
      const l = fp.lines[i];
      if (!l.action || !ACTIONABLE.has(l.tier)) continue;
      if (l.action.tool !== "data_evict") {
        next.set(i, {
          calls: l.action.calls, free: l.bytes ?? 0, aside: 0, asideWhy: "",
          checked: !(l.tier === "keep" && (l.strands ?? 0) > 0),
        });
        continue;
      }
      const ok: Record<string, unknown>[] = [];
      let free = 0;
      const why = new Map<string, number>();
      for (const call of l.action.calls) {
        const dry = await wtool<{
          would_free_bytes?: number;
          refusal?: { error?: string };
          error?: string;
        }>("data_evict", { ...call, dry_run: true });
        const code = dry.refusal?.error ?? dry.error;
        if (code) why.set(REFUSAL_WORDS[code] ?? code, (why.get(REFUSAL_WORDS[code] ?? code) ?? 0) + 1);
        else {
          ok.push(call);
          free += dry.would_free_bytes ?? 0;
        }
      }
      next.set(i, {
        calls: ok, free,
        aside: l.action.calls.length - ok.length,
        asideWhy: [...why.entries()].map(([w, n]) => `${n} ${w}`).join(", "),
        checked: ok.length > 0,
      });
    }
    setPlans(next);
    setMode("armed");
  };

  const toFree = [...plans.values()].filter((p) => p.checked && p.calls.length)
    .reduce((n, p) => n + p.free, 0);
  const nCalls = [...plans.values()].filter((p) => p.checked)
    .reduce((n, p) => n + p.calls.length, 0);

  const execute = async () => {
    if (!fp) return;
    setMode("running");
    const out: string[] = [];
    let done = 0;
    const ordered = [...plans.entries()]
      .filter(([, p]) => p.checked && p.calls.length)
      .sort(([a], [b]) =>
        EXEC_ORDER.indexOf(fp.lines[a].tier) - EXEC_ORDER.indexOf(fp.lines[b].tier));
    for (const [i, p] of ordered) {
      const l = fp.lines[i];
      const w = lineWords(l);
      let errs = 0;
      let freed = 0;
      for (const call of p.calls) {
        done++;
        setProgress(`${done}/${nCalls} — ${w.what}`);
        const r = await wtool<{ error?: string; detail?: string;
                                bytes_freed?: number }>(
          l.action!.tool, { ...call, _confirm: true });
        if (r.error) {
          errs++;
          out.push(`✗ ${w.what}: ${r.error}${r.detail ? ` — ${String(r.detail).slice(0, 80)}` : ""}`);
        } else {
          freed += r.bytes_freed ?? 0;
        }
      }
      if (errs < p.calls.length) {
        const shown = l.action!.tool === "data_evict"
          ? fmtBytes(freed) : `~${fmtBytes(l.bytes ?? 0)}`;
        out.push(`✓ ${w.what} — ${shown} freed${p.aside ? ` (${p.asideWhy} set aside)` : ""}`);
      }
    }
    setReceipt(out);
    setProgress("");
    setMode("done");
    store.toast("ok", `cleanup finished — ${out.filter((s) => s.startsWith("✓")).length} step(s); details in Activity`);
    void store.refreshData();
    onCleaned?.();
  };

  const actionable = useMemo(
    () => lines.some((l) => l.action && ACTIONABLE.has(l.tier)), [lines]);

  if (!fp)
    return (
      <div className="sec">
        <div className="sec-h">Footprint<span className="right"><Api>uiapi /footprint</Api></span></div>
        <span className="faint small">adding it up…</span>
      </div>
    );

  return (
    <div className="sec">
      <div className="sec-h">
        Footprint
        <span className="right row" style={{ gap: 8 }}>
          {mode === "view" && actionable && (
            <button className="btn sm" onClick={() => void arm()}
                    title="one sheet for everything this occupies — checkboxes, plain consequences, weft-verified safety, one receipt">
              Clean up…
            </button>
          )}
          <Api>uiapi /footprint{mode !== "view" ? " · data_evict(dry_run)" : ""}</Api>
        </span>
      </div>
      {mode === "arming" && <div className="faint small" style={{ marginBottom: 4 }}>asking weft what is safe to free…</div>}
      {mode === "running" && <div className="small" style={{ marginBottom: 4 }}>{progress}</div>}
      {mode === "done" && (
        <div style={{ marginBottom: 6 }}>
          {receipt.map((s, i) => (
            <div key={i} className="small" style={{ color: s.startsWith("✗") ? "var(--err)" : undefined }}>{s}</div>
          ))}
          <a className="id plain small" onClick={() => { setBump((b) => b + 1); }}>done — re-count</a>
        </div>
      )}
      {!fp.lines.length && (
        <div className="dim small">nothing on any site and nothing local — only the record remains</div>
      )}
      {(mode === "view" || mode === "armed") && fp.lines.map((l, i) => {
        const w = lineWords(l);
        const p = plans.get(i);
        return (
          <div key={`${l.tier}:${l.site ?? ""}:${l.target ?? l.env_id ?? i}`}
               style={{ padding: "2.5px 0" }}>
            {/* the name FLEXES and wraps internally; checkbox and amount
                hold their line — nothing clips in a narrow mount (the
                chat panel) and nothing orphans */}
            <div className="row small" style={{ gap: 8, alignItems: "baseline" }}>
              {mode === "armed" && (
                p && p.calls.length ? (
                  <input type="checkbox" checked={p.checked}
                         style={{ alignSelf: "flex-start", marginTop: 2 }}
                         onChange={(e) => {
                           const next = new Map(plans);
                           next.set(i, { ...p, checked: e.target.checked });
                           setPlans(next);
                         }} />
                ) : (
                  <span style={{ width: 13, flex: "none" }} />
                )
              )}
              <span style={{ fontSize: 12, flex: "1 1 auto", minWidth: 0 }}>
                {w.what}
                {showRunNames && l.name && (l.tier === "keep" || l.tier === "sandbox") && (
                  <>
                    {" — "}
                    <a className="id plain" title={`${l.name} — this run's files on the Data page`}
                       style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis",
                                whiteSpace: "nowrap", display: "inline-block",
                                verticalAlign: "bottom" }}
                       onClick={() => navigate(["data", l.target!])}>{l.name}</a>
                  </>
                )}
                {l.tier === "env" && l.env_id && (
                  <>
                    {" — "}
                    <a className="id plain mono" title="the environment's page"
                       onClick={() => navigate(["jobs", "envs", l.env_id!])}>
                      {l.env_id.slice(0, 16)}…
                    </a>
                  </>
                )}
              </span>
              <span className="right-al num dim nowrap">
                {mode === "armed" && p && l.action?.tool === "data_evict"
                  ? `${fmtBytes(p.free)} freeable`
                  : amount(l)}
              </span>
            </div>
            <div className={`small ${w.warn ? "" : "faint"}`}
                 style={{ ...(w.warn ? { color: "var(--err)" } : {}),
                          ...(mode === "armed" ? { marginLeft: 21 } : {}) }}>
              {w.warn ? "⚠ " : ""}{w.note}
              {mode === "armed" && p && p.aside > 0 && (
                <> · <b>{p.aside} set aside</b> ({p.asideWhy})</>
              )}
            </div>
            {l.tier === "saved" && l.entries && (
              <div className="faint small mono" style={{ marginLeft: 4 }}>
                {l.entries.slice(0, 5).map((e) => (
                  <div key={e.path}>{e.path} · {fmtBytes(e.bytes)}</div>
                ))}
                {l.entries.length > 5 && <div>… {l.entries.length - 5} more under data/</div>}
              </div>
            )}
          </div>
        );
      })}
      {mode === "armed" && (
        <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
          <button className="btn sm primary" disabled={!nCalls}
                  style={{ whiteSpace: "nowrap" }}
                  onClick={() => void execute()}>
            Free {fmtBytes(toFree)} — {nCalls} step{nCalls === 1 ? "" : "s"}
          </button>
          <a className="id plain small" onClick={() => setMode("view")}>cancel</a>
          <span className="right-al"><Api>run_forget · run_discard · env_evict · data_evict</Api></span>
        </div>
      )}
      {mode !== "done" && fp.lines.length > 0 && (
        <div className="row small" style={{ marginTop: 6, paddingTop: 5, borderTop: "1px solid var(--line)" }}>
          <span className="dim">occupies, everywhere</span>
          <span className="right-al num"><b>{fmtBytes(fp.total_bytes)}</b></span>
        </div>
      )}
    </div>
  );
}
