/**
 * Hash router (R1): the URL is the source of truth for page, tab, and
 * selection — every screen is deep-linkable and embeddable, e.g.
 *   #/jobs                      #/jobs/jb_x
 *   #/jobs/kernels/krn_x        #/jobs/services/svc_x
 *   #/jobs/envs/env:v1:…        #/provenance/<target>
 *   #/compute/clip              #/chat/c_x
 *   #/activity                  #/wizard
 * Hash-based so it survives any mount path (iframe panels, file serves)
 * with zero server routing config.
 */

import { useSyncExternalStore } from "react";

function parse(): string[] {
  const h = window.location.hash.replace(/^#\/?/, "");
  return h ? h.split("/").map(decodeURIComponent).filter(Boolean) : [];
}

let cached: string[] = parse();
const listeners = new Set<() => void>();
window.addEventListener("hashchange", () => {
  cached = parse();
  listeners.forEach((fn) => fn());
});

export function useRoute(): string[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => cached,
  );
}

function toHash(segs: (string | null | undefined)[]): string {
  return "#/" + segs.filter((s): s is string => !!s).map(encodeURIComponent).join("/");
}

/** default: history push (page/tab moves, cross-object jumps).
 * replace: selection changes — j/k walking a table must not spam history. */
export function navigate(segs: (string | null | undefined)[], opts?: { replace?: boolean }) {
  const hash = toHash(segs);
  if (hash === window.location.hash) return;
  if (opts?.replace) {
    // replaceState fires no hashchange — update and notify by hand
    window.history.replaceState(null, "", window.location.pathname + window.location.search + hash);
    cached = parse();
    listeners.forEach((fn) => fn());
  } else {
    window.location.hash = hash;
  }
}

/** panel mode (?embed=1): the host supplies the chrome, we render content */
export const EMBED = new URLSearchParams(window.location.search).has("embed");

/** ?hide=chat[,…] — full-window views that omit surfaces (a host popping
 * up weft-ui as an "advanced screen" usually keeps its own agent) */
export const HIDDEN: ReadonlySet<string> = new Set(
  (new URLSearchParams(window.location.search).get("hide") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
