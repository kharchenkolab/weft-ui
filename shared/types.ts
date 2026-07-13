/**
 * Hand-mirrored weft JSON shapes (plan D9).
 *
 * These mirror the payloads weft's tools return — the conformance pytest
 * (server/tests/test_conformance.py) captures real samples into
 * shared/samples/ and fails when upstream drops a key path the UI renders.
 * Baseline weft SHA: shared/samples/BASELINE.
 */

// ---- jobs (shape: store._job_row, served by /api/ui/jobs) ----------------

export type JobState =
  | "PENDING" | "RESOLVING_ENV" | "STAGING" | "SUBMITTED" | "QUEUED"
  | "RUNNING" | "COLLECTING" | "DONE" | "FAILED" | "CANCELLED";

export const TERMINAL_STATES: ReadonlySet<string> = new Set(["DONE", "FAILED", "CANCELLED"]);

export interface Resources {
  cpus?: number;
  mem_gb?: number;
  gpus?: number;
  walltime?: string;
  partition?: string;
}

export interface Task {
  command: string;
  env?: string | null;
  inputs?: { ref: string; mount_as: string }[];
  code?: { ref: string; mount_as: string };
  outputs?: string[];
  resources?: Resources;
  site?: string;
  array?: number | null;
  env_vars?: Record<string, string>;
}

export interface JobRow {
  job_id: string;
  task_hash: string;
  task: Task;
  site: string;
  state: JobState;
  sched_handle: string | null;
  error: WeftErrorPayload | null;
  manifest: Manifest | null;
  created_at: number;
  updated_at: number;
  array_group: string | null;
  array_index: number | null;
  /** a retried element's old row names its successor — fold under the
   * group's history rather than reading it as a duplicate (weft ≥9a30cdb) */
  superseded_by?: string | null;
}

/** jobs_where tool payload (paginated) */
export interface JobsPage {
  jobs: JobRow[];
  count: number;
  offset: number;
  limit: number;
}

/** task_status(job_id) row — thin, but carries the persisted submit plan */
export interface TaskStatusRow {
  job_id: string;
  state: JobState;
  site: string;
  since: number;
  error: WeftErrorPayload | null;
  has_manifest: boolean;
  plan?: SubmitPlan;
  [key: string]: unknown;
}

// ---- errors (WeftError.to_dict) -------------------------------------------

export interface WeftErrorPayload {
  error: string; // taxonomy code, e.g. "job.oom"
  stage: string;
  detail: string;
  retryable: boolean;
  hints: Record<string, unknown> & {
    log_signature?: { signature?: string; excerpt?: string; all_signatures?: string[] };
    log_tail?: string;
    failed_allocation?: string;
    /** internal.error (weft ≥9a30cdb): the unexpected exception's tail */
    traceback_tail?: string;
  };
  meaning: string;
}

/** ui.md taxonomy: user-code red, infra amber, policy blue. */
export function errorClass(err: WeftErrorPayload): "user" | "infra" | "policy" {
  if (err.error.startsWith("policy.") || err.stage === "policy") return "policy";
  if (err.error.startsWith("job.") || err.error.startsWith("env.solve")) return "user";
  return "infra";
}

// ---- manifests -------------------------------------------------------------

export type Grade =
  | "fully-pinned" | "snapshot-pinned" | "attested" | "escape-hatch" | "state-dependent";

export const GRADE_RANK: Record<Grade, 1 | 2 | 3 | 4 | 5> = {
  "fully-pinned": 5,
  "snapshot-pinned": 4,
  "attested": 3,
  "escape-hatch": 2,
  "state-dependent": 1,
};

export interface OutputPreview {
  kind: "text-head" | "inline-json" | "tree" | string;
  lines?: string[];
  truncated?: boolean;
  value?: unknown;
  files?: number;
}

export interface ManifestOutput {
  path: string;
  bytes: number;
  ref: string;
  preview?: OutputPreview;
}

export interface Manifest {
  schema: string;
  job_id: string;
  site: string;
  task_hash: string;
  exit_code: number;
  env_id: string | null;
  outputs: ManifestOutput[];
  output_bytes: number;
  max_rss_gb?: number;
  logs?: { site_path: string; tail: string };
  reproducibility: Grade;
  reproducibility_meaning?: string;
  reproducibility_components?: { component: string; grade: Grade; why: string }[];
}

// ---- submit plan -----------------------------------------------------------

export interface SubmitPlan {
  site: string;
  resources: Resources;
  env: { env_id: string | null; action: "cached" | "build" | "bare" | string };
  staging: {
    transfer: string[];
    already_present: string[];
    bytes_to_move: number;
    transfer_method: string;
    estimate_s: number;
  };
  queue: string;
}

export interface SubmitResult {
  job_id?: string;
  group?: string;
  site?: string;
  plan?: SubmitPlan;
  memoized?: boolean;
  // error payloads share this shape (returns-never-raises)
  error?: string;
  detail?: string;
}

// ---- sites -----------------------------------------------------------------

export interface SiteSummary {
  name: string;
  kind: string;
  health: string; // "ok" | "unreachable" | ...
  cpus?: number;
  mem_gb?: number;
  gpus?: number;
  scheduler?: string;
  internet?: boolean;
}

// ---- events (store.emit / events_since) ------------------------------------

export interface WeftEvent {
  seq: number;
  ts?: number;
  kind: string; // "job.state" | "site.registered" | "transfer.progress" | "_resync" | ...
  job_id: string | null;
  [key: string]: unknown;
}

// ---- arrays ----------------------------------------------------------------

export interface FailureBucket {
  signature: string;
  count: number;
  sample_indices: number[];
  sample_job_id: string;
}

export interface ArrayStatus {
  /** returns-never-raises: an unknown group comes back as an error payload */
  error?: string;
  group: string;
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  running: number;
  queued: number;
  preparing: number;
  failure_buckets: FailureBucket[];
  failed_previews?: unknown[];
  elements?: { index: number; job_id: string; state: JobState; memoized?: boolean }[];
  note?: string;
}
