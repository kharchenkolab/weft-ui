/**
 * Result manifest: outputs with previews (the same previews the agent
 * reads), observed peak memory, and the reproducibility grade with its
 * meaning — a ladder, not an alarm.
 */

import { useEffect, useState } from "react";
import type { Manifest } from "@shared/types";
import { runFileUrl } from "../api/client";
import { Api, fmtBytes, GradeChip } from "../bits";
import { IMG_EXT, PEEK_MAX } from "./peek";
import { navigate } from "../router";

/** an image output rendered in place — the same controller file-read the
 * peek uses (whichever copy answers: keep or sandbox). Click toggles
 * full size; a swept file degrades to an honest note, never a broken img */
function ImgThumb({ target, rel }: { target: string; rel: string }) {
  const [big, setBig] = useState(false);
  const [gone, setGone] = useState(false);
  if (gone)
    return (
      <div className="faint small">
        figure not readable anymore — the sandbox may have been swept and this file wasn&apos;t retained
      </div>
    );
  return (
    <img
      className={`fig-thumb${big ? " big" : ""}`}
      src={runFileUrl(target, rel, PEEK_MAX * 8)}
      alt={rel}
      loading="lazy"
      title={big ? "shrink" : "expand — full view, save, download on the Data page (the path link above)"}
      onClick={() => setBig(!big)}
      onError={() => setGone(true)}
    />
  );
}

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

const OUTPUT_CAP = 12; // array pipelines write dozens — the card must not
                       // bury the sections below it (Files, retention)

export function ManifestView({ manifest, target }: {
  manifest: Manifest;
  /** the producing run — set it and image outputs render inline as
   * figures (chat result cards and the run page both pass it) */
  target?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [manifest]);
  const shown = showAll ? manifest.outputs : manifest.outputs.slice(0, OUTPUT_CAP);
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
        {shown.map((o) => (
          <div key={o.path} style={{ marginBottom: 8 }}>
            <a className="id plain mono small"
               title="this output as a dataset — copies, contents, save/download ⌁ Data"
               onClick={() => navigate(["data", o.ref])}>
              {o.path}
            </a>
            <span className="faint small"> · {fmtBytes(o.bytes)}</span>
            {target && IMG_EXT.test(o.path) ? (
              <ImgThumb target={target} rel={o.path} />
            ) : (
              <Preview o={o} />
            )}
          </div>
        ))}
        {manifest.outputs.length > shown.length && (
          <a className="id plain small" onClick={() => setShowAll(true)}>
            show all {manifest.outputs.length}
          </a>
        )}
      </div>
    </div>
  );
}
