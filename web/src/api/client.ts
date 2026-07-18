/**
 * Typed fetch client. Token comes from the served page (injected), a
 * ?token= param (vite dev), or sessionStorage from a previous visit.
 */

import type { EnvListRow, JobRow, JobsPage, KernelRow, ServiceRow, SiteSummary } from "@shared/types";

declare global {
  interface Window {
    __WEFT_UI_TOKEN__?: string;
  }
}

function resolveToken(): string {
  const injected = window.__WEFT_UI_TOKEN__;
  if (injected && injected !== "%%WEFT_UI_TOKEN%%") return injected;
  const fromUrl = new URLSearchParams(window.location.search).get("token");
  if (fromUrl) {
    sessionStorage.setItem("weft-ui:token", fromUrl);
    return fromUrl;
  }
  return sessionStorage.getItem("weft-ui:token") ?? "";
}

export const TOKEN = resolveToken();

/** the app's mount point — "/" standalone, "/weft/proj-a/" under an ASGI
 * mount (docs/embedding.md). Hash routing guarantees the document is only
 * ever served from the mount root, so resolving against it is always
 * correct — no configuration, no build-time prefix. */
export const BASE = new URL(".", window.location.href).pathname;

/** absolute-from-mount URL for an api path ("api/x" or "api/x") */
export function apiUrl(path: string): string {
  return BASE + path.replace(/^\//, "");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

/** Call a weft tool through the facade — same payloads the agent sees. */
export function wtool<T = Record<string, unknown>>(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return request<T>(`api/w/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
}

// enumeration goes through the same tools the agent uses (weft ≥9a30cdb)
export const api = {
  ping: () => request<{ ok: boolean; workspace: string }>("api/ping"),
  jobs: async (): Promise<JobRow[]> => {
    // page through jobs_where; demo scale fits one page, big workspaces two+
    const jobs: JobRow[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await wtool<JobsPage>("jobs_where", { limit: 500, offset });
      jobs.push(...page.jobs);
      if (page.count < page.limit) return jobs;
    }
  },
  sites: () => wtool<SiteSummary[]>("sites_list"),
  envs: () => wtool<{ envs: EnvListRow[] }>("list_envs").then((r) => r.envs ?? []),
  kernels: () => wtool<{ kernels: KernelRow[] }>("list_kernels").then((r) => r.kernels ?? []),
  services: () => wtool<{ services: ServiceRow[] }>("list_services").then((r) => r.services ?? []),
  audit: (n = 100) =>
    wtool<{ audit: Record<string, unknown>[] }>("audit_tail", { n }).then((r) => r.audit),
};

export interface ConversationMeta {
  id: string;
  title: string;
  created_at: number;
  model: string;
  sdk_session_id: string | null;
  state: "idle" | "running" | "waiting_approval";
  cost_usd: number;
  budget_usd: number;
  turns: number;
}

export const chat = {
  list: () => request<ConversationMeta[]>("api/chat/conversations"),
  create: (model?: string) =>
    request<ConversationMeta>("api/chat/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(model ? { model } : {}),
    }),
  send: (cid: string, text: string) =>
    request<{ ok: boolean }>(`api/chat/conversations/${cid}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  approve: (cid: string, requestId: string, decision: "allow" | "deny",
            opts?: { alwaysAllowGb?: number; alwaysAllowServer?: string }) =>
    request<{ ok: boolean }>(`api/chat/conversations/${cid}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        decision,
        always_allow_staging_gb: opts?.alwaysAllowGb,
        always_allow_server: opts?.alwaysAllowServer,
      }),
    }),
  setup: () => request<AgentSetup>("api/chat/setup"),
};

export interface AgentSetup {
  skills: { name: string; description: string; source: string }[];
  mcp_servers: { name: string; source: string; transport: string; consent: string }[];
  mcp_error: string | null;
  setting_sources: string[];
  workspace_trusted: boolean;
  notes: string[];
}

export function chatStreamUrl(cid: string, after: number): string {
  return apiUrl(`api/chat/conversations/${cid}/stream?after=${after}&token=${encodeURIComponent(TOKEN)}`);
}

export function logStreamUrl(jobId: string): string {
  return apiUrl(`api/ui/jobs/${jobId}/logs/stream?token=${encodeURIComponent(TOKEN)}`);
}

/** preview bytes of one run file (⌁ run_file_read behind a browser-friendly face) */
export function runFileUrl(target: string, rel: string, maxBytes = 262144): string {
  return apiUrl(
    `api/ui/runs/${encodeURIComponent(target)}/file?rel=${encodeURIComponent(rel)}` +
      `&max_bytes=${maxBytes}&token=${encodeURIComponent(TOKEN)}`,
  );
}

export function eventStreamUrl(cursor: number): string {
  return apiUrl(`api/events?cursor=${cursor}&token=${encodeURIComponent(TOKEN)}`);
}
