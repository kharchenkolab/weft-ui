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
  /** human handle (≤200 chars), hash-neutral: relabeling never forks
   * memoization; a memoized resubmit returns the PRIOR job + its label */
  label?: string;
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
  /** top-level mirror of task.label (weft ≥116a0bf) */
  label?: string | null;
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

// ---- site detail (capabilities:v2, config, policy) --------------------------

export interface SchedulerPartition {
  name?: string;
  nodes?: number | string;
  cpus_per_node?: number | string;
  mem_gb?: number;
  max_walltime?: string;
  gres?: string;
  default?: boolean;
  [key: string]: unknown;
}

export interface SiteCapabilities {
  schema?: string;
  probed_at?: number;
  measured_on?: string;
  os?: string;
  arch?: string;
  cpus?: number;
  mem_gb?: number;
  glibc?: string;
  internet?: boolean;
  runtimes?: Record<string, unknown>;
  scheduler?: {
    type?: string;
    version?: string;
    partitions?: SchedulerPartition[];
    [key: string]: unknown;
  };
  module_system?: boolean | number;
  gpus?: { model?: string; count?: number }[];
  cuda_driver?: string;
  storage?: {
    weft_root?: string;
    free_gb?: number;
    candidates?: { path: string; writable?: boolean; free_gb?: number }[];
  };
  /** compute-node truth from site_probe_deep, when measured */
  compute?: SiteCapabilities;
  [key: string]: unknown;
}

export interface SitePolicy {
  partitions_allowed?: string[];
  max_gpus?: number;
  max_concurrent_jobs?: number;
  storage?: { large?: string; scratch?: string; node_tmp?: string };
  notes?: string[];
}

export interface SiteDetail {
  error?: string;
  name: string;
  kind: string;
  health?: string;
  config: {
    root?: string;
    host?: string;
    port?: number;
    user?: string;
    modules_init?: string;
    policy?: SitePolicy;
    capabilities_override?: Record<string, unknown>;
    [key: string]: unknown;
  };
  capabilities?: SiteCapabilities;
  site_notebook?: unknown[];
  routes?: { src: string; dst: string; via: string }[];
  [key: string]: unknown;
}

export interface PartitionLoad {
  cpus_idle: number;
  cpus_allocated: number;
  cpus_down: number;
  cpus_total: number;
  pending_jobs: number;
  running_jobs: number;
}

export interface SiteLoadInfo {
  error?: string;
  site: string;
  note?: string;
  login_note?: string;
  partitions?: Record<string, PartitionLoad>;
  [key: string]: unknown;
}

export interface FootprintRealization {
  env_id: string;
  bytes: number;
  last_used: number | null;
  idle_days: number | null;
  [key: string]: unknown;
}

export interface FootprintInfo {
  error?: string;
  realizations?: FootprintRealization[];
  [key: string]: unknown;
}

// ---- wizard support payloads (/api/ui/*) -------------------------------------

export interface SshHost {
  host: string;
  hostname?: string;
  user?: string;
  port?: string;
  jump?: string;
}

export interface PreflightFix {
  case: string;
  headline: string;
  explain: string;
  commands: string[];
}

export interface PreflightResult {
  case: string; // "ok" | "auth" | "hostkey" | "dns" | "network" | "unknown"
  stderr: string;
  fixes?: PreflightFix[];
}

export interface DfMount {
  mount: string;
  total_gb: number;
  free_gb: number;
}

export interface SinfoPartition {
  name: string;
  default: boolean;
  nodes: number | string;
  cpus_per_node: number | string;
  mem_per_node: string;
  max_walltime: string;
  gres: string;
}

export interface SinfoProbe {
  partitions: SinfoPartition[];
  accounts: string[];
  accounts_visible: boolean;
  modules_ready: boolean;
}

// ---- kernels (store.list_kernels rows; kernel_* tool payloads) ---------------

export interface KernelRow {
  kernel_id: string;
  site: string;
  lang: string; // registry: python | r | julia
  env_id: string | null;
  jobdir: string;
  handle: string;
  state: "running" | "stopped" | "died" | string;
  blocks_run: number;
  created_at: number;
  last_used: number;
}

/** kernel_transcript entry; rc === null means still running / never ran */
export interface TranscriptEntry {
  block: number;
  code?: string;
  rc?: number | null;
  out_tail?: string;
  error?: string; // "unreadable"
}

export interface KernelStatus {
  error?: string;
  kernel_id: string;
  site: string;
  lang: string;
  env_id: string | null;
  state: string;
  blocks_run: number;
  current_block: number | null;
  idle_s: number;
}

/** kernel_exec / kernel_poll result (wait=false returns state:"submitted") */
export interface KernelExecResult {
  error?: string;
  detail?: string;
  kernel_id: string;
  block: number;
  state: "submitted" | "running" | "done";
  rc?: number;
  out?: string;
  err?: string;
  artifacts?: string[];
  note?: string;
}

// ---- services (store rows; service_* tool payloads) ---------------------------

export interface ServiceRow {
  service_id: string;
  site: string;
  jobdir: string;
  handle: string;
  ports: number[];
  state: "starting" | "ready" | "stopped" | "exited" | string;
  task: Task;
  created_at: number;
}

export interface ServiceEndpoint {
  port: number;
  local_port?: number;
  url: string;
}

export interface ServiceStatus {
  error?: string;
  detail?: string;
  service_id: string;
  site: string;
  state: string;
  ports: number[];
  endpoints?: ServiceEndpoint[];
  tunnels_alive?: boolean;
  /** present when service_status healed a dropped tunnel — surface it */
  tunnel_note?: string;
  log_tail?: string;
}

// ---- provenance (provenance:v1, recursive) -----------------------------------

export interface ProvenanceEnvLayer {
  packages: number;
  snapshot?: string | null;
  pinned_shas: Record<string, string>;
}

export interface ProvenanceEnvironment {
  env_id: string;
  spec?: Record<string, unknown> | null;
  weakly_reproducible?: boolean | number;
  notes?: string[];
  step_notes?: Record<string, string>;
  modules_attested?: string[];
  post_install?: unknown[];
  layers?: Record<string, ProvenanceEnvLayer>;
}

/** dref node: {ref, bytes, origin, produced_by?} */
export interface ProvenanceRefNode {
  ref: string;
  bytes?: number;
  origin?: string;
  produced_by?: ProvenanceJobNode;
}

/** an input = mount point + (recursive ref node | bare {ref} at depth 0) */
export type ProvenanceInput = { mount_as: string } & Partial<ProvenanceRefNode>;

export interface ProvenanceJobNode {
  error?: string;
  detail?: string;
  schema?: string;
  /** "unknown" when the job has no manifest (failed / still running) */
  reproducibility: Grade | "unknown" | string;
  reproducibility_meaning?: string | null;
  reproducibility_components?: { component: string; grade: Grade; why: string }[] | null;
  job_id: string;
  state: string;
  site: string;
  task_hash: string;
  command?: string;
  env_vars?: Record<string, string>;
  outputs: { path: string; ref: string }[];
  environment?: ProvenanceEnvironment;
  inputs?: ProvenanceInput[];
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
  label?: string | null;
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
