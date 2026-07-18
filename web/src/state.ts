/**
 * One store, fed by one SSE stream (plan D2/D8): resync-first reducer.
 *
 * The stream replays from the persisted cursor, so a UI restart converges
 * to identical state; a `_resync` control event (stale cursor, slow
 * client) or an event for an unknown job triggers a list refetch — one
 * recovery path for every failure mode. Nothing here polls for state —
 * the one exception is ambient site load (the dots), because weft has no
 * site.load events yet; that poller is gentle and honest about staleness.
 */

import { useSyncExternalStore } from "react";
import type {
  DataRefRow,
  EnvListRow,
  EnvRealization,
  EnvStatus,
  JobRow,
  KernelRow,
  ServiceRow,
  SiteCapabilities,
  SiteLoadInfo,
  SiteSummary,
  WeftEvent,
} from "@shared/types";
import { TERMINAL_STATES } from "@shared/types";
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

/** whole-cluster totals for scheduler sites — the login node's own
 * cpus/mem mislead (nobody computes there), so cards summarize this */
export interface ClusterSummary {
  nodes: number;
  cores: number;
  gpus: number;
}

/** sum the partition node-class rows; the same class can appear under
 * several partitions (overlapping queues) — count each class once */
function clusterSummary(caps: SiteCapabilities | undefined): ClusterSummary | null {
  const parts = caps?.scheduler?.partitions ?? [];
  const seen = new Set<string>();
  let nodes = 0;
  let cores = 0;
  let gpus = 0;
  for (const p of parts) {
    const n = Number(p.nodes);
    if (!n || Number.isNaN(n)) continue;
    const key = `${JSON.stringify(p.features ?? "")}|${n}|${String(p.cpus_per_node)}|${JSON.stringify(p.gres ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes += n;
    cores += n * (Number(p.cpus_per_node) || 0);
    const gres = Array.isArray(p.gres) ? (p.gres as { count?: number }[]) : [];
    gpus += n * gres.reduce((s, g) => s + (g.count ?? 0), 0);
  }
  return nodes > 0 ? { nodes, cores, gpus } : null;
}

/** one ambient load sample per site — feeds the five-state dots */
export interface SiteLoadSample {
  /** null = the probe failed (dot stays gray rather than lying) */
  load: SiteLoadInfo | null;
  /** ms epoch of the sample */
  ts: number;
}

/** diagnostics from a kernel.died event — the store row only says "died" */
export interface KernelDeath {
  /** scheduler verdict (weft ≥5ff9f36): walltime_exceeded | oom | cancelled | exited | lost */
  cause: string | null;
  slurm_state: string | null;
  killing_block: number | null;
  exit_code: number | null;
  log_tail: string;
  suggestion: string;
  ts: number;
}

export interface AppState {
  workspace: string;
  connected: boolean;
  cursor: number;
  jobs: ReadonlyMap<string, JobRow>;
  sites: SiteSummary[];
  kernels: KernelRow[];
  services: ServiceRow[];
  envs: EnvListRow[];
  /** per-env realization rows (recorded bytes/state per site) — the
   * site facet for the envs tab; from env_status store reads, not du */
  envSites: ReadonlyMap<string, EnvRealization[]>;
  /** user-chosen site order (drag on the compute tab) — every site list
   * in the app follows it; persisted per workspace */
  siteOrder: string[];
  kernelDeaths: ReadonlyMap<string, KernelDeath>;
  siteLoads: ReadonlyMap<string, SiteLoadSample>;
  data: DataRefRow[];
  clusterCaps: ReadonlyMap<string, ClusterSummary>;
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
    cursor: 0, // loaded per-workspace in start()
    jobs: new Map(),
    sites: [],
    kernels: [],
    services: [],
    envs: [],
    envSites: new Map(),
    siteOrder: [],
    kernelDeaths: new Map(),
    siteLoads: new Map(),
    data: [],
    clusterCaps: new Map(),
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

  private cursorKey(): string {
    return `weft-ui:cursor:${this.state.workspace}`;
  }

  private siteOrderKey(): string {
    return `weft-ui:site-order:${this.state.workspace}`;
  }

  /** persist the drag-set site order — every site list follows it */
  setSiteOrder = (names: string[]) => {
    localStorage.setItem(this.siteOrderKey(), JSON.stringify(names));
    this.set({ siteOrder: names });
  };

  private loadSiteOrder(): string[] {
    try {
      return JSON.parse(localStorage.getItem(this.siteOrderKey()) ?? "[]") as string[];
    } catch {
      return [];
    }
  }

  async start() {
    const ping = await api.ping();
    this.set({ workspace: ping.workspace });
    this.state.cursor = Number(localStorage.getItem(this.cursorKey()) ?? "0");
    this.set({ siteOrder: this.loadSiteOrder() });
    // another tab dragged the compute cards — follow it live
    window.addEventListener("storage", (e) => {
      if (e.key === this.siteOrderKey()) this.set({ siteOrder: this.loadSiteOrder() });
    });
    await this.refetchLists();
    this.connect();
    this.watchStream();
    this.startLoadPoller();
    window.setInterval(() => {
      this.pruneTransfers();
      this.set({ now: Date.now() / 1000 });
    }, 5000);
  }

  // -- ambient site load (the dots) -----------------------------------------
  // site_load is an on-demand ssh probe (weft caches it 15 s), so poll
  // gently: an initial sweep, then one probe per tick, stalest site first,
  // paused while the tab is hidden. Dots render gray once a sample ages
  // past LOAD_STALE_MS — better honest-gray than a confident stale color.
  // Upstream ask on file: emit site.load events from weft's own pollers.

  static readonly LOAD_TICK_MS = 10_000;
  static readonly LOAD_TARGET_MS = 60_000;
  static readonly LOAD_STALE_MS = 180_000;

  private loadTimer: number | null = null;
  private loadInflight = new Set<string>();

  private startLoadPoller() {
    if (this.loadTimer != null) return;
    for (const s of this.state.sites) if (s.health === "ok") void this.probeLoad(s.name);
    this.loadTimer = window.setInterval(() => {
      if (document.hidden) return;
      const stalest = this.state.sites
        .filter((s) => s.health === "ok" && !this.loadInflight.has(s.name))
        .map((s) => ({ name: s.name, age: Date.now() - (this.state.siteLoads.get(s.name)?.ts ?? 0) }))
        .filter((x) => x.age > Store.LOAD_TARGET_MS)
        .sort((a, b) => b.age - a.age)[0];
      if (stalest) void this.probeLoad(stalest.name);
    }, Store.LOAD_TICK_MS);
  }

  private async probeLoad(name: string) {
    this.loadInflight.add(name);
    let load: SiteLoadInfo | null = null;
    try {
      const r = await wtool<SiteLoadInfo>("site_load", { name });
      if (r && !r.error) load = r;
    } catch {
      // failed probe recorded as null — the dot goes gray, not stale-green
    } finally {
      this.loadInflight.delete(name);
    }
    const siteLoads = new Map(this.state.siteLoads);
    siteLoads.set(name, { load, ts: Date.now() });
    this.set({ siteLoads });
  }

  /** the Data tab's manual refresh — register/fetch may not ride an SSE event */
  async refreshData() {
    this.set({ data: await api.data() });
  }

  private async refetchLists() {
    const [jobs, sites, kernels, services, envs, data] = await Promise.all([
      api.jobs(),
      api.sites(),
      api.kernels(),
      api.services(),
      api.envs(),
      api.data(),
    ]);
    this.set({ jobs: new Map(jobs.map((j) => [j.job_id, j])), sites, kernels, services, envs, data });
    this.refreshClusterCaps();
    void this.refreshEnvSites(envs);
  }

  /** realization rows per env — env_status is a store read upstream
   * (recorded bytes, not live du), so refreshing all of them is cheap */
  private envSitesGen = 0;

  private async refreshEnvSites(envs: EnvListRow[]) {
    const gen = ++this.envSitesGen;
    const entries = await Promise.all(
      envs.map(async (e) => {
        try {
          const st = await wtool<EnvStatus>("env_status", { env_id: e.env_id });
          return [e.env_id, st && !st.error ? st.realizations : ([] as EnvRealization[])] as const;
        } catch {
          return [e.env_id, [] as EnvRealization[]] as const;
        }
      }),
    );
    if (gen !== this.envSitesGen) return; // a newer refresh superseded this one
    this.set({ envSites: new Map(entries) });
  }

  /** cluster totals for scheduler sites (sites_describe is a cheap store
   * read upstream — no ssh); fetched once per site, re-fetched when a
   * site.* event names the site (re-register/probe refreshes the record) */
  private clusterFetched = new Set<string>();

  private refreshClusterCaps() {
    for (const s of this.state.sites) {
      if (!s.scheduler || s.scheduler === "none" || this.clusterFetched.has(s.name)) continue;
      this.clusterFetched.add(s.name);
      void wtool<{ capabilities?: SiteCapabilities; error?: string }>("sites_describe", {
        name: s.name,
      }).then((d) => {
        const sum = d && !d.error ? clusterSummary(d.capabilities) : null;
        if (!sum) return;
        const clusterCaps = new Map(this.state.clusterCaps);
        clusterCaps.set(s.name, sum);
        this.set({ clusterCaps });
      });
    }
  }

  private scheduleRefetch() {
    if (this.refetchTimer != null) return;
    this.refetchTimer = window.setTimeout(async () => {
      this.refetchTimer = null;
      await this.refetchLists();
    }, 400);
  }

  // -- multi-tab spine sharing ------------------------------------------------
  // Browsers cap HTTP/1.1 connections per host (~6). Each tab used to pin
  // its own SSE spine; with a chat stream and a log pane open, two or
  // three tabs exhausted the budget and every request queued — the app
  // "hung" whenever an agent turn generated event traffic. Now exactly one
  // tab (the Web-Locks winner) holds the real EventSource and rebroadcasts
  // to the rest over BroadcastChannel; when it closes, the lock passes and
  // the next tab connects from the shared persisted cursor.

  private bc: BroadcastChannel | null = null;
  private leader = false;

  private connect() {
    if (typeof BroadcastChannel === "undefined" || !navigator.locks) {
      this.connectDirect(); // ancient/private contexts: old behavior
      return;
    }
    this.bc = new BroadcastChannel(`weft-ui:events:${this.state.workspace}`);
    this.bc.onmessage = (m) => {
      if (this.leader) return;
      if (m.data?._conn !== undefined) this.set({ connected: m.data._conn as boolean });
      else {
        this.set({ connected: true });
        this.apply(m.data as WeftEvent);
      }
    };
    void navigator.locks.request(`weft-ui:spine:${this.state.workspace}`, async () => {
      this.leader = true;
      // taking over from a closed leader: resume from the shared cursor
      this.state.cursor = Number(localStorage.getItem(this.cursorKey()) ?? this.state.cursor);
      this.connectDirect();
      await new Promise(() => {}); // hold the lock while this tab lives
    });
  }

  /** the server heartbeats every 15 s; silence past this means the
   * stream is a zombie (e.g. a proxy kept our socket open across a
   * backend restart and EventSource never errored) — reconnect. */
  private static readonly STREAM_SILENCE_MS = 45_000;
  private lastStreamMs = Date.now();

  private connectDirect() {
    this.es?.close();
    const es = new EventSource(eventStreamUrl(this.state.cursor));
    this.es = es;
    this.lastStreamMs = Date.now();
    es.onopen = () => {
      this.backoffMs = 500;
      this.set({ connected: true });
      this.bc?.postMessage({ _conn: true });
    };
    es.onerror = () => {
      // rebuild with the *current* cursor rather than letting EventSource
      // retry a stale URL; backoff keeps a dead server cheap
      es.close();
      this.set({ connected: false });
      this.bc?.postMessage({ _conn: false });
      this.backoffMs = Math.min(this.backoffMs * 2, 15000);
      window.setTimeout(() => this.connectDirect(), this.backoffMs);
    };
    es.onmessage = (msg) => {
      this.lastStreamMs = Date.now();
      const ev = JSON.parse(msg.data) as WeftEvent;
      this.bc?.postMessage(ev);
      this.apply(ev);
    };
  }

  /** zombie-stream watchdog — only meaningful on the tab holding the
   * EventSource; a reconnect replays from the cursor, so nothing is lost */
  private watchStream() {
    window.setInterval(() => {
      if (!this.es) return;
      if (Date.now() - this.lastStreamMs > Store.STREAM_SILENCE_MS) {
        this.es.close();
        this.set({ connected: false });
        this.bc?.postMessage({ _conn: false });
        this.connectDirect();
      }
    }, 15_000);
  }

  private apply(ev: WeftEvent) {
    if (ev.kind === "_heartbeat") return;
    if (ev.kind === "_resync") {
      this.scheduleRefetch();
      // hard SET, not advance: a resync may move the cursor *backwards*
      // (stale cursor from a wiped-and-recreated workspace store)
      this.state.cursor = ev.seq;
      localStorage.setItem(this.cursorKey(), String(ev.seq));
      return;
    }
    this.advanceCursor(ev.seq);

    switch (ev.kind) {
      // terminal transitions arrive as their own kinds (job.done/job.failed),
      // NOT as job.state events — fold all three into one row/timeline update
      case "job.state":
      case "job.done":
      case "job.failed": {
        const jobId = ev.job_id!;
        const state =
          ev.kind === "job.done" ? "DONE" : ev.kind === "job.failed" ? "FAILED" : (ev.state as string);
        const jobs = new Map(this.state.jobs);
        const row = jobs.get(jobId);
        if (row) {
          jobs.set(jobId, { ...row, state: state as JobRow["state"], updated_at: ev.ts ?? row.updated_at });
        } else {
          this.scheduleRefetch(); // new job: rows come from the list endpoint
        }
        // terminal states carry error/manifest that events don't include
        // (CANCELLED is the third terminal shape — it arrives as job.state)
        if (row && TERMINAL_STATES.has(state)) this.scheduleRefetch();
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
      case "kernel.died": {
        // the store row will only say "died" — the event carries the
        // diagnosis (killing block, log tail); keep it for the death card
        const kernelDeaths = new Map(this.state.kernelDeaths);
        kernelDeaths.set(ev.kernel as string, {
          cause: (ev.cause as string) ?? null,
          slurm_state: (ev.slurm_state as string) ?? null,
          killing_block: (ev.killing_block as number) ?? null,
          exit_code: (ev.exit_code as number) ?? null,
          log_tail: (ev.log_tail as string) ?? "",
          suggestion: (ev.suggestion as string) ?? "",
          ts: ev.ts ?? 0,
        });
        this.set({ kernelDeaths });
        this.scheduleRefetch();
        break;
      }
      default:
        // site.registered/unregistered/(un)reachable, bootstrap.step, … —
        // anything site-shaped can move the sites list; refetch is cheap
        // and debounced. Unknown kinds still reach the ticker below.
        if (
          ev.kind.startsWith("site.") ||
          ev.kind.startsWith("bootstrap.") ||
          ev.kind.startsWith("kernel.") ||
          ev.kind.startsWith("service.") ||
          ev.kind.startsWith("env.") ||
          ev.kind.startsWith("data.")
        ) {
          // a re-register/probe refreshes the capability record — let the
          // cluster summary follow it
          if (ev.kind.startsWith("site.") && typeof ev.site === "string")
            this.clusterFetched.delete(ev.site);
          this.scheduleRefetch();
        }
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
      localStorage.setItem(this.cursorKey(), String(seq));
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

/** apply the user's drag-set order; sites not in it keep their natural
 * position at the end (stable sort) */
export function orderSites<T extends { name: string }>(sites: T[], order: string[]): T[] {
  if (!order.length) return sites;
  const pos = new Map(order.map((n, i) => [n, i]));
  return [...sites].sort((a, b) => (pos.get(a.name) ?? order.length) - (pos.get(b.name) ?? order.length));
}

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
