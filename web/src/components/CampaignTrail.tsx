/**
 * CampaignTrail (M11.8): the track-back links every artifact card owes
 * its reader — a run/keep wears a campaign label; the label was declared
 * by a thread; both hops are in the store, so both are drawn: campaign →
 * its face on Data, thread → the chat AT that campaign's section.
 * One shared label→thread map (chat.list), cached briefly.
 */

import { useEffect, useState } from "react";
import { chat } from "../api/client";
import { navigate } from "../router";

export interface ChatCtx {
  cid: string;
  title: string;
}

let cache: Map<string, ChatCtx> | null = null;
let cachedAt = 0;
let inflight: Promise<Map<string, ChatCtx>> | null = null;
const TTL_MS = 30_000;

/** campaign label → the thread that declared it (list is newest-first,
 * so keep-first resolves rare label collisions to the latest thread) */
export function useChatOf(): Map<string, ChatCtx> {
  const [m, setM] = useState<Map<string, ChatCtx>>(cache ?? new Map());
  useEffect(() => {
    if (cache && Date.now() - cachedAt < TTL_MS) return;
    inflight ??= chat
      .list()
      .then((convs) => {
        const mm = new Map<string, ChatCtx>();
        for (const c of convs)
          for (const l of c.campaigns ?? [])
            if (!mm.has(l)) mm.set(l, { cid: c.id, title: c.title });
        cache = mm;
        cachedAt = Date.now();
        return mm;
      })
      .finally(() => { inflight = null; });
    void inflight.then(setM).catch(() => {});
  }, []);
  return m;
}

const trunc = (s: string, n = 26) => (s.length > n ? s.slice(0, n) + "…" : s);

/** "label · in thread" — the label clicks to the campaign face, the
 * thread clicks into the chat at this campaign's section */
export function CampaignTrail({ label }: { label: string }) {
  const ctx = useChatOf().get(label);
  return (
    <>
      <a className="id plain" title="the campaign's page — its runs, its data, its footprint"
         onClick={() => navigate(["data", `campaign:${label}`])}>
        {label}
      </a>
      {ctx && (
        <span className="small">
          {" · in "}
          <a className="id plain"
             title={`the "${ctx.title}" thread — opens the chat at this campaign's section`}
             onClick={() => navigate(["chat", ctx.cid, label])}>
            “{trunc(ctx.title)}”
          </a>
        </span>
      )}
    </>
  );
}

/** just the thread hop, for headers where the campaign link already
 * exists — renders nothing when no thread declared this label */
export function ThreadLink({ label }: { label: string }) {
  const ctx = useChatOf().get(label);
  if (!ctx) return null;
  return (
    <a className="id plain small"
       title={`the "${ctx.title}" thread — opens the chat at this campaign's section`}
       onClick={() => navigate(["chat", ctx.cid, label])}>
      in “{trunc(ctx.title)}” →
    </a>
  );
}

/** the ancestry cluster EVERY detail card carries, right-aligned in its
 * header: ghost buttons in hierarchy order, each named for where it
 * lands — run → · data → · campaign → · chat →. One component so every
 * card offers the same hops the same way. */
export function AncestryNav({ run, data, labels = [], extra }: {
  /** a run target (jb_ or krn_) — draws "run →" to its page on Jobs */
  run?: string | null;
  /** a run target whose files live on Data — draws "data →" to its card */
  data?: string | null;
  /** candidate campaign labels, most specific first: the first draws
   * "campaign →"; the first one a thread declared draws "chat →" */
  labels?: (string | null | undefined)[];
  /** card-specific buttons that ride in the same cluster (e.g. Provenance) */
  extra?: React.ReactNode;
}) {
  const chatOf = useChatOf();
  const ls = labels.filter((l): l is string => !!l);
  const camp = ls[0] ?? null;
  const chatLabel = ls.find((l) => chatOf.has(l)) ?? null;
  const ctx = chatLabel ? chatOf.get(chatLabel) : undefined;
  if (!run && !data && !camp && !extra) return null;
  return (
    <span className="right-al row" style={{ gap: 6 }}>
      {run && (
        <button className="btn sm ghost"
                title="the run's own page — status, timeline, retention"
                onClick={() => navigate(run.startsWith("krn_") ? ["jobs", "kernels", run] : ["jobs", run])}>
          run →
        </button>
      )}
      {data && (
        <button className="btn sm ghost"
                title="this run's files on the Data page — read, save, download, clean up"
                onClick={() => navigate(["data", data])}>
          data →
        </button>
      )}
      {camp && (
        <button className="btn sm ghost"
                title="the campaign this belongs to — all its runs, data, footprint"
                onClick={() => navigate(["data", `campaign:${camp}`])}>
          campaign →
        </button>
      )}
      {ctx && (
        <button className="btn sm ghost"
                title={`the "${ctx.title}" thread — opens the chat at this campaign's section`}
                onClick={() => navigate(["chat", ctx.cid, chatLabel!])}>
          chat →
        </button>
      )}
      {extra}
    </span>
  );
}
