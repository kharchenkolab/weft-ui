/**
 * Result manifest: outputs with previews (the same previews the agent
 * reads), observed peak memory, and the reproducibility grade with its
 * meaning — a ladder, not an alarm.
 */

import type { Manifest } from "@shared/types";
import { Api, fmtBytes, GradeChip } from "../bits";

function Preview({ o }: { o: Manifest["outputs"][number] }) {
  const p = o.preview;
  if (!p) return null;
  if (p.kind === "inline-json")
    return <div className="log" style={{ marginTop: 4 }}>{JSON.stringify(p.value, null, 1)}</div>;
  if (p.kind === "text-head" && p.lines?.length)
    return (
      <div className="log" style={{ marginTop: 4 }}>
        {p.lines.join("\n")}
        {p.truncated ? "\n…" : ""}
      </div>
    );
  if (p.kind === "tree") return <span className="faint small"> · {p.files} files</span>;
  return null;
}

export function ManifestView({ manifest }: { manifest: Manifest }) {
  return (
    <div className="sec">
      <div className="sec-h">
        Result
        <span className="right">
          <Api>task_result</Api>
        </span>
      </div>
      <dl className="kv">
        <dt>exit code</dt>
        <dd>{manifest.exit_code}</dd>
        {manifest.max_rss_gb != null && (
          <>
            <dt>peak memory</dt>
            <dd className="num">{manifest.max_rss_gb.toFixed(2)} GB observed</dd>
          </>
        )}
        <dt>outputs</dt>
        <dd className="num">{manifest.outputs.length} · {fmtBytes(manifest.output_bytes)}</dd>
        <dt>grade</dt>
        <dd>
          <GradeChip grade={manifest.reproducibility} />
          {manifest.reproducibility_meaning && (
            <div className="faint small" style={{ marginTop: 3, maxWidth: "34ch" }}>
              {manifest.reproducibility_meaning}
            </div>
          )}
        </dd>
      </dl>
      <div style={{ marginTop: 8 }}>
        {manifest.outputs
          .filter((o) => o.preview?.kind !== "tree")
          .map((o) => (
            <div key={o.path} style={{ marginBottom: 8 }}>
              <span className="mono small">{o.path}</span>
              <span className="faint small"> · {fmtBytes(o.bytes)}</span>
              <Preview o={o} />
            </div>
          ))}
      </div>
    </div>
  );
}
