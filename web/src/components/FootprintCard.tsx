/**
 * FootprintCard (M11): the uniform "what does this occupy, everywhere"
 * face over uiapi /footprint. Every line is one tier at one place, in
 * plain words — no taxonomy vocabulary reaches the user. Lines link to
 * the entities they name; the Clean up sheet (M11.4) acts on the same
 * payload, with data_evict(dry_run) supplying the truth at confirm time.
 */

import { useEffect, useState } from "react";
import type { Footprint, FootprintLine } from "@shared/types";
import { api } from "../api/client";
import { Api, fmtBytes } from "../bits";
import { navigate } from "../router";

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

export function FootprintCard({ scope, showRunNames = false, bump = 0 }: {
  scope: string;
  /** campaign/site scopes: several runs contribute — name each line's run */
  showRunNames?: boolean;
  /** increment to refetch (the sheet bumps after acting) */
  bump?: number;
}) {
  const [fp, setFp] = useState<Footprint | null>(null);
  useEffect(() => {
    setFp(null);
    void api.footprint(scope).then(setFp, () => setFp(null));
  }, [scope, bump]);

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
        <span className="right"><Api>uiapi /footprint</Api></span>
      </div>
      {!fp.lines.length && (
        <div className="dim small">nothing on any site and nothing local — only the record remains</div>
      )}
      {fp.lines.map((l, i) => {
        const w = lineWords(l);
        return (
          <div key={`${l.tier}:${l.site ?? ""}:${l.target ?? l.env_id ?? i}`}
               style={{ padding: "2.5px 0" }}>
            <div className="row small" style={{ gap: 8 }}>
              <span style={{ fontSize: 12 }}>
                {w.what}
                {showRunNames && l.name && (l.tier === "keep" || l.tier === "sandbox") && (
                  <>
                    {" — "}
                    <a className="id plain" title="this run's files on the Data page"
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
              <span className="right-al num dim nowrap">{amount(l)}</span>
            </div>
            <div className={`small ${w.warn ? "" : "faint"}`}
                 style={w.warn ? { color: "var(--err)" } : undefined}>
              {w.warn ? "⚠ " : ""}{w.note}
            </div>
          </div>
        );
      })}
      {fp.lines.length > 0 && (
        <div className="row small" style={{ marginTop: 6, paddingTop: 5, borderTop: "1px solid var(--line)" }}>
          <span className="dim">occupies, everywhere</span>
          <span className="right-al num"><b>{fmtBytes(fp.total_bytes)}</b></span>
        </div>
      )}
    </div>
  );
}
