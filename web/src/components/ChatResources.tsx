/**
 * ChatResources (M11.7): the thread's structural sidebar — one section
 * per campaign (the thread's outline), each holding what that piece of
 * work USES: its runs, and the uniform footprint (envs, data copies,
 * files — with the same Clean up sheet as everywhere else). Chat is
 * level 1 of the hierarchy, campaigns level 2 — this panel makes that
 * visible in one place, and it scales vertically where a row of header
 * pills could not.
 */

import { useEffect, useMemo, useState } from "react";
import type { ConversationMeta } from "../api/client";
import { FootprintCard } from "./FootprintCard";
import { navigate } from "../router";
import { useApp } from "../state";

interface RunRow {
  id: string;
  kind: "job" | "kernel";
  state: string;
  site: string;
  when?: number;
}

export function ChatResources({ meta, onJump, onClose }: {
  meta: ConversationMeta;
  /** scroll the transcript to the campaign's declaration heading */
  onJump: (label: string) => void;
  onClose: () => void;
}) {
  const { jobs, kernels } = useApp();
  const labels = meta.campaigns ?? [];
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(meta.campaign ? [meta.campaign] : labels.slice(-1)));

  // a freshly declared campaign expands itself — the panel follows the work
  useEffect(() => {
    if (meta.campaign)
      setOpen((o) => (o.has(meta.campaign!) ? o : new Set([...o, meta.campaign!])));
  }, [meta.campaign]);

  const runsOf = useMemo(() => {
    const m = new Map<string, RunRow[]>();
    for (const l of labels) m.set(l, []);
    for (const j of jobs.values())
      if (j.label && m.has(j.label) && !j.superseded_by)
        m.get(j.label)!.push({ id: j.job_id, kind: "job", state: j.state, site: j.site, when: j.updated_at });
    for (const k of kernels)
      if (k.label && m.has(k.label))
        m.get(k.label)!.push({ id: k.kernel_id, kind: "kernel", state: k.state, site: k.site, when: k.last_used });
    for (const rs of m.values()) rs.sort((a, b) => (b.when ?? 0) - (a.when ?? 0));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, kernels, meta.campaigns]);

  const toggle = (l: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(l)) next.delete(l);
      else next.add(l);
      return next;
    });

  return (
    <div className="chat-res">
      <div className="sh" style={{ padding: "12px 14px 4px", display: "flex", alignItems: "center" }}>
        <b style={{ fontSize: 12 }}>This thread&apos;s work</b>
        <a className="id plain right-al faint" onClick={onClose}>close ×</a>
      </div>
      <div className="faint small" style={{ padding: "0 14px 8px" }}>
        one section per campaign, in the order declared — its runs, and
        everything those left behind
      </div>
      {!labels.length && (
        <div className="dim small" style={{ padding: "2px 14px" }}>
          no campaigns yet — the agent declares one when substantial work
          starts; its runs, data, and footprint land here
        </div>
      )}
      {labels.map((l) => {
        const isOpen = open.has(l);
        const runs = runsOf.get(l) ?? [];
        const current = l === meta.campaign;
        return (
          <div key={l} className="chat-res-sec">
            <div className="row" style={{ gap: 6, padding: "6px 4px", cursor: "pointer", minWidth: 0 }}
                 onClick={() => toggle(l)}>
              <span className="chev faint">{isOpen ? "▾" : "▸"}</span>
              <b style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis",
                          whiteSpace: "nowrap", minWidth: 0 }}>{l}</b>
              {current && (
                <span className="chip quiet" style={{ fontSize: 9, padding: "0 5px" }}
                      title="the open campaign — new work in this chat files under it">open</span>
              )}
              <a className="id plain right-al" style={{ flex: "none" }}
                 title="show where this campaign starts in the transcript"
                 onClick={(e) => { e.stopPropagation(); onJump(l); }}>
                ↑ transcript
              </a>
            </div>
            {isOpen && (
              <div style={{ padding: "0 4px 4px" }}>
                <div className="dim small" style={{ margin: "2px 0 1px", fontSize: 10,
                                                    textTransform: "uppercase", letterSpacing: ".05em" }}>
                  Runs
                </div>
                {!runs.length && <div className="dim small">no runs under this label</div>}
                {runs.slice(0, 6).map((r) => (
                  <div className="row small" key={r.id} style={{ gap: 6, padding: "1px 0" }}>
                    <span className="dim" style={{ width: 52, flex: "none" }}>{String(r.state).toLowerCase()}</span>
                    <a className="id plain mono"
                       style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                       title={r.kind === "kernel" ? "the kernel's page" : "the run's page"}
                       onClick={() => navigate(r.kind === "kernel" ? ["jobs", "kernels", r.id] : ["jobs", r.id])}>
                      {r.id}
                    </a>
                    <span className="right-al faint small" style={{ flex: "none" }}>{r.site}</span>
                  </div>
                ))}
                {runs.length > 6 && (
                  <a className="id plain small"
                     title="the campaign's full page on Data — all runs, data rows, footprint"
                     onClick={() => navigate(["data", `campaign:${l}`])}>
                    +{runs.length - 6} more — full page →
                  </a>
                )}
                <FootprintCard scope={`campaign:${l}`} showRunNames />
                <a className="id plain small" style={{ display: "inline-block", margin: "2px 0 4px" }}
                   title="the campaign's page on Data — its runs, data rows, and footprint, full width"
                   onClick={() => navigate(["data", `campaign:${l}`])}>
                  full page on Data →
                </a>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
