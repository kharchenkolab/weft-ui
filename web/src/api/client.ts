/**
 * Typed fetch client. Token comes from the served page (injected), a
 * ?token= param (vite dev), or sessionStorage from a previous visit.
 */

import type { JobRow, JobsPage, KernelRow, ServiceRow, SiteSummary } from "@shared/types";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
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
  return request<T>(`/api/w/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
}

// enumeration goes through the same tools the agent uses (weft ≥9a30cdb)
export const api = {
  ping: () => request<{ ok: boolean; workspace: string }>("/api/ping"),
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
  list: () => request<ConversationMeta[]>("/api/chat/conversations"),
  create: (model?: string) =>
    request<ConversationMeta>("/api/chat/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(model ? { model } : {}),
    }),
  send: (cid: string, text: string) =>
    request<{ ok: boolean }>(`/api/chat/conversations/${cid}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  approve: (cid: string, requestId: string, decision: "allow" | "deny",
            alwaysAllowGb?: number) =>
    request<{ ok: boolean }>(`/api/chat/conversations/${cid}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        decision,
        always_allow_staging_gb: alwaysAllowGb,
      }),
    }),
};

export function chatStreamUrl(cid: string, after: number): string {
  return `/api/chat/conversations/${cid}/stream?after=${after}&token=${encodeURIComponent(TOKEN)}`;
}

export function logStreamUrl(jobId: string): string {
  return `/api/ui/jobs/${jobId}/logs/stream?token=${encodeURIComponent(TOKEN)}`;
}

export function eventStreamUrl(cursor: number): string {
  return `/api/events?cursor=${cursor}&token=${encodeURIComponent(TOKEN)}`;
}
