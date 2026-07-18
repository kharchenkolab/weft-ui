/**
 * Import a bundle (Jobs tab): load an exported provenance closure into
 * THIS workspace — envs, specs, input blobs — then re-run the target
 * task with force. Equal output refs prove the re-derivation; the site
 * is yours to choose (bundles are site-agnostic by construction).
 */

import { useState } from "react";
import type { SiteSummary } from "@shared/types";
import { wtool } from "../api/client";
import { Api } from "../bits";
import { navigate } from "../router";
import { store } from "../state";

interface ImportResult {
  error?: string;
  detail?: string;
  target_job?: string;
  task?: Record<string, unknown>;
  recorded_outputs?: { path: string; ref: string }[];
  envs?: string[];
  metadata?: unknown;
}

export function BundleImport({ sites }: { sites: SiteSummary[] }) {
  const [path, setPath] = useState("");
  const [site, setSite] = useState(sites[0]?.name ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<ImportResult | null>(null);

  const inspect = async () => {
    if (busy) return;
    setBusy("import");
    const r = await wtool<ImportResult>("bundle_import", { path: path.trim() });
    if (r.error) store.toast("err", `⌁ bundle_import: ${r.error} — ${r.detail ?? ""}`);
    setLoaded(r);
    setBusy(null);
  };

  const rerun = async () => {
    if (busy || !loaded?.task) return;
    setBusy("submit");
    const r = await wtool<{ job_id?: string; error?: string; detail?: string }>(
      "task_submit", { task: { ...loaded.task, site }, force: true });
    if (r.job_id) {
      store.toast("ok", `⌁ task_submit(force) → ${r.job_id}`);
      setLoaded(null);
      setPath("");
      navigate(["jobs", r.job_id]);
    } else {
      store.toast("err", `⌁ task_submit: ${r.error ?? "failed"} — ${r.detail ?? ""}`);
    }
    setBusy(null);
  };

  return (
    <details className="disclose" style={{ margin: "8px 14px 0" }}>
      <summary>
        Import a bundle
        <span className="peek">re-derive an exported result here — envs, inputs, and the task travel in one file</span>
      </summary>
      <div className="disc-body">
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <input
            className="mono"
            style={{ flex: "2 1 260px", fontSize: 11.5, padding: "3px 8px", border: "1px solid var(--line)", borderRadius: 6 }}
            placeholder="path to a .tar.gz bundle on this machine"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <button className="btn sm" disabled={!path.trim() || busy != null} onClick={() => void inspect()}>
            {busy === "import" ? "Loading…" : "Load"}
          </button>
        </div>
        {loaded && !loaded.error && (
          <div className="small" style={{ marginTop: 8 }}>
            <div>
              <span className="dim">target</span>{" "}
              <span className="id plain">{loaded.target_job}</span>{" "}
              <span className="dim">· {(loaded.envs ?? []).length} env(s) ·{" "}
                {(loaded.recorded_outputs ?? []).length} recorded output(s) loaded</span>
            </div>
            {typeof loaded.task?.command === "string" && (
              <pre className="blk-code" style={{ margin: "6px 0", maxHeight: 90, overflow: "auto" }}>
                {loaded.task.command as string}
              </pre>
            )}
            <div className="row" style={{ gap: 6 }}>
              <select className="filter-select" value={site} onChange={(e) => setSite(e.target.value)}
                      title="bundles are site-agnostic — pick where the re-derivation runs">
                {sites.map((s) => (
                  <option key={s.name} value={s.name}>{s.name}</option>
                ))}
              </select>
              <button className="btn sm" disabled={busy != null || !site} onClick={() => void rerun()}
                      title="run the target task again, bypassing memoization — equal output refs prove the re-derivation ⌁ task_submit(force)">
                {busy === "submit" ? "Submitting…" : "Re-derive (force)"}
              </button>
            </div>
          </div>
        )}
        <div className="faint small" style={{ marginTop: 4 }}>
          <Api>bundle_import · task_submit(force)</Api>
        </div>
      </div>
    </details>
  );
}
