/**
 * One store, fed by one SSE stream (plan D2/D8): resync-first reducer.
 *
 * The stream replays from the persisted cursor, so a UI restart converges
 * to identical state; a `_resync` control event (stale cursor, slow
 * client) or an event for an unknown job triggers a list refetch — one
 * recovery path for every failure mode. Nothing here polls.
 */

import { useSyncExternalStore } from "react";
import type { JobRow, SiteSummary, WeftEvent } from "@shared/types";
import { api, ApiError, eventStreamUrl, wtool } from "./api/client";

export interface TransferInfo {
  jobId: string;
  site: string;
  bytesDone: number;
  bytesTotal: number;
  rateMbps: number;
  etaS: number;
  done: boolean;
  ts: number;
}

export interface Toast {
  id: number;
  kind: "ok" | "warn" | "err";
  text: string;
}

export interface AppState {
  workspace: string;
  connected: boolean;
  cursor: number;
  jobs: ReadonlyMap<string, JobRow>;
  sites: SiteSummary[];
  /** per-job state history straight from job.state events */
  timelines: ReadonlyMap<string, { ts: number; state: string }[]>;
  transfers: ReadonlyMap<string, TransferInfo>;
  ticker: WeftEvent[];
  stagedBytes: ReadonlyMap<string, number>;
  toasts: Toast[];
  now: number;
}

type Listener = () => void;

const TICKER_LEN = 30;
const TIMELINE_CAP = 40;

class Store {
  private state: AppState = {
    workspace: "",
    connected: false,
    cursor: Number(localStorage.getItem("weft-ui:cursor") ?? "0"),
    jobs: new Map(),
    sites: [],
    timelines: new Map(),
    transfers: new Map(),
    ticker: [],
    stagedBytes: new Map(),
    toasts: [],
    now: Date.now() / 1000,
  };
  private toastSeq = 0;
  private listeners = new Set<Listener>();
  private es: EventSource | null = null;
  private refetchTimer: number | null = null;
  private backoffMs = 500;

  getSnapshot = (): AppState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  async start() {
    const ping = await api.ping();
    this.set({ workspace: ping.workspace });
    await this.refetchLists();
    this.connect();
    window.setInterval(() => {
      this.pruneTransfers();
      this.set({ now: Date.now() / 1000 });
    }, 5000);
  }

  private async refetchLists() {
    const [jobs, sites] = await Promise.all([api.jobs(), api.sites()]);
    this.set({ jobs: new Map(jobs.map((j) => [j.job_id, j])), sites });
  }

  private scheduleRefetch() {
    if (this.refetchTimer != null) return;
    this.refetchTimer = window.setTimeout(async () => {
      this.refetchTimer = null;
      await this.refetchLists();
    }, 400);
  }

  private connect() {
    this.es?.close();
    const es = new EventSource(eventStreamUrl(this.state.cursor));
    this.es = es;
    es.onopen = () => {
      this.backoffMs = 500;
      this.set({ connected: true });
    };
    es.onerror = () => {
      // rebuild with the *current* cursor rather than letting EventSource
      // retry a stale URL; backoff keeps a dead server cheap
      es.close();
      this.set({ connected: false });
      this.backoffMs = Math.min(this.backoffMs * 2, 15000);
      window.setTimeout(() => this.connect(), this.backoffMs);
    };
    es.onmessage = (msg) => this.apply(JSON.parse(msg.data) as WeftEvent);
  }

  private apply(ev: WeftEvent) {
    if (ev.kind === "_heartbeat") return;
    if (ev.kind === "_resync") {
      this.scheduleRefetch();
      this.advanceCursor(ev.seq);
      return;
    }
    this.advanceCursor(ev.seq);

    switch (ev.kind) {
      case "job.state": {
        const jobId = ev.job_id!;
        const state = ev.state as string;
        const jobs = new Map(this.state.jobs);
        const row = jobs.get(jobId);
        if (row) {
          jobs.set(jobId, { ...row, state: state as JobRow["state"], updated_at: ev.ts ?? row.updated_at });
        } else {
          this.scheduleRefetch(); // new job: rows come from the list endpoint
        }
        // terminal states carry error/manifest that events don't include
        if (row && (state === "FAILED" || state === "DONE")) this.scheduleRefetch();
        const timelines = new Map(this.state.timelines);
        const tl = [...(timelines.get(jobId) ?? []), { ts: ev.ts ?? 0, state }];
        timelines.set(jobId, tl.slice(-TIMELINE_CAP));
        this.set({ jobs, timelines });
        break;
      }
      case "transfer.start":
      case "transfer.progress":
      case "transfer.done": {
        const jobId = ev.job_id ?? "?";
        const transfers = new Map(this.state.transfers);
        const prev = transfers.get(jobId);
        const info: TransferInfo = {
          jobId,
          site: (ev.site as string) ?? prev?.site ?? "?",
          bytesDone: (ev.bytes_done as number) ?? (ev.kind === "transfer.done" ? ((ev.bytes_total as number) ?? prev?.bytesTotal ?? 0) : 0),
          bytesTotal: (ev.bytes_total as number) ?? prev?.bytesTotal ?? 0,
          rateMbps: (ev.rate_mbps as number) ?? 0,
          etaS: (ev.eta_s as number) ?? 0,
          done: ev.kind === "transfer.done",
          ts: ev.ts ?? 0,
        };
        transfers.set(jobId, info);
        const stagedBytes = new Map(this.state.stagedBytes);
        if (ev.kind === "transfer.done") {
          stagedBytes.set(jobId, (stagedBytes.get(jobId) ?? 0) + ((ev.bytes_total as number) ?? 0));
          // keep finished transfers on the strip briefly; prune stale ones
          window.setTimeout(() => this.pruneTransfers(), 4000);
        }
        this.set({ transfers, stagedBytes });
        break;
      }
      case "site.registered":
      case "site.unreachable":
      case "site.reachable":
        this.scheduleRefetch();
        break;
    }

    if (!ev.kind.startsWith("_")) {
      this.set({ ticker: [ev, ...this.state.ticker].slice(0, TICKER_LEN) });
    }
  }

  private pruneTransfers() {
    // a live transfer refreshes ~every second; anything quiet for 12 s is
    // finished (or replayed history) and leaves the strip
    const now = Date.now() / 1000;
    const transfers = new Map(this.state.transfers);
    let changed = false;
    for (const [k, t] of transfers) {
      if ((t.done && now - t.ts > 3) || now - t.ts > 12) {
        transfers.delete(k);
        changed = true;
      }
    }
    if (changed) this.set({ transfers });
  }

  private advanceCursor(seq: number) {
    if (seq > this.state.cursor) {
      this.state.cursor = seq; // no re-render for cursor alone
      localStorage.setItem("weft-ui:cursor", String(seq));
    }
  }

  /** optimistic nudge after an action; the event stream is the truth */
  refresh = () => this.scheduleRefetch();

  toast(kind: Toast["kind"], text: string) {
    const t = { id: ++this.toastSeq, kind, text };
    this.set({ toasts: [...this.state.toasts, t] });
    window.setTimeout(() => {
      this.set({ toasts: this.state.toasts.filter((x) => x.id !== t.id) });
    }, 7000);
  }
}

export const store = new Store();

export function useApp(): AppState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/**
 * Run a tool from a button and surface its actual reply — success, weft
 * error payload, memoization, or consent 409 — as a toast. The peer
 * principle: the human sees exactly what the agent would.
 */
export async function act(tool: string, args: Record<string, unknown> = {}): Promise<void> {
  try {
    const r = (await wtool<Record<string, unknown>>(tool, args)) ?? {};
    if ("error" in r) {
      store.toast("err", `⌁ ${tool}: ${r.error} — ${(r.detail as string) ?? ""}`);
    } else if (r.memoized) {
      store.toast("ok", `⌁ ${tool}: memoized ↺ ${r.job_id} — identical task, manifest returned without re-running`);
    } else if (r.job_id) {
      store.toast("ok", `⌁ ${tool} → ${r.job_id}`);
    } else if (r.group) {
      store.toast("ok", `⌁ ${tool} → ${r.group}`);
    } else {
      store.toast("ok", `⌁ ${tool}: ok`);
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      store.toast("warn", `⌁ ${tool}: needs explicit confirmation (destructive or account-level effect)`);
    } else {
      store.toast("err", `⌁ ${tool}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  store.refresh();
}
