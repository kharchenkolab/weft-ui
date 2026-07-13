/**
 * Array group detail: digest bar, failure buckets ("3 failure modes",
 * not 3,000 rows), an element grid for small groups, retry actions.
 * Buckets and elements come from array_status; the live digest recomputes
 * from element rows as job.state events arrive.
 */

import { useEffect, useState } from "react";
import type { ArrayStatus, JobRow } from "@shared/types";
import { wtool } from "../api/client";
import { Api, fmtAsk, Pill } from "../bits";
import { store } from "../state";

export interface GroupRow {
  group: string;
  site: string;
  elements: JobRow[];
  counts: { done: number; failed: number; running: number; queued: number; other: number };
  state: string;
}

export function groupCounts(elements: JobRow[]) {
  const c = { done: 0, failed: 0, running: 0, queued: 0, other: 0 };
  for (const e of elements) {
    if (e.state === "DONE") c.done++;
    else if (e.state === "FAILED") c.failed++;
    else if (e.state === "RUNNING" || e.state === "COLLECTING") c.running++;
    else if (e.state === "QUEUED" || e.state === "SUBMITTED") c.queued++;
    else c.other++;
  }
  return c;
}

export function DigestBar({ counts, total }: { counts: GroupRow["counts"]; total: number }) {
  const pct = (n: number) => `${(100 * n) / Math.max(total, 1)}%`;
  return (
    <div className="prog" style={{ marginTop: 4, maxWidth: 200 }}>
      <b className="p-done" style={{ width: pct(counts.done) }} />
      <b className="p-failed" style={{ width: pct(counts.failed) }} />
      <b className="p-running" style={{ width: pct(counts.running) }} />
      <b className="p-queued" style={{ width: pct(counts.queued + counts.other) }} />
    </div>
  );
}

export function CountsLine({ counts }: { counts: GroupRow["counts"] }) {
  return (
    <div className="arr-sub num" style={{ marginTop: 3 }}>
      {counts.done.toLocaleString()} ✓ ·{" "}
      <b style={{ color: counts.failed ? "var(--failed)" : undefined }}>
        {counts.failed.toLocaleString()} ✗
      </b>{" "}
      · {counts.running.toLocaleString()} ▸ · {(counts.queued + counts.other).toLocaleString()} ⧖
    </div>
  );
}

export function ArrayDetail({
  row,
  onSelectJob,
}: {
  row: GroupRow;
  onSelectJob: (id: string) => void;
}) {
  const [status, setStatus] = useState<ArrayStatus | null>(null);
  const terminal = row.counts.running + row.counts.queued + row.counts.other === 0;

  useEffect(() => {
    let alive = true;
    wtool<ArrayStatus>("array_status", { group: row.group }).then(
      (s) => alive && setStatus(s.error ? null : s),
    );
    return () => {
      alive = false;
    };
    // refetch when the digest moves — counts key is a cheap change signal
  }, [row.group, row.counts.done, row.counts.failed, row.counts.running]);

  const retryFailed = async () => {
    await wtool("array_retry", { group: row.group });
    store.refresh();
  };

  const first = row.elements[0];
  return (
    <div className="card detail">
      <div className="pane-h">
        <Pill state={row.state} />
        <span className="id">{row.group}</span>
        <span className="dim small">
          {row.site} · array · {row.elements.length.toLocaleString()} elements
        </span>
      </div>

      <div className="sec">
        <div className="sec-h">Progress</div>
        <DigestBar counts={row.counts} total={row.elements.length} />
        <CountsLine counts={row.counts} />
      </div>

      {status && status.failure_buckets.length > 0 && (
        <div className="sec">
          <div className="sec-h">
            {status.failure_buckets.length} failure mode
            {status.failure_buckets.length > 1 ? "s" : ""}
            <span className="right">
              <Api>array_status</Api>
            </span>
          </div>
          {status.failure_buckets.map((b) => (
            <div key={b.signature} style={{ marginBottom: 9 }}>
              <div className="row">
                <span className="chip code user">{b.signature}</span>
                <span className="num dim small">×{b.count}</span>
              </div>
              <div className="small" style={{ marginTop: 3 }}>
                <span className="dim">elements </span>
                {b.sample_indices.map((i) => {
                  const el = row.elements.find((e) => e.array_index === i);
                  return (
                    <a
                      key={i}
                      className="id"
                      style={{ marginRight: 4 }}
                      onClick={() => el && onSelectJob(el.job_id)}
                    >
                      {i}
                    </a>
                  );
                })}
                {b.count > b.sample_indices.length && (
                  <span className="faint">+{b.count - b.sample_indices.length} more</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {row.elements.length <= 200 && (
        <div className="sec">
          <div className="sec-h">Elements</div>
          <div className="el-grid">
            {[...row.elements]
              .sort((a, b) => (a.array_index ?? 0) - (b.array_index ?? 0))
              .map((e) => (
                <span
                  key={e.job_id}
                  title={`element ${e.array_index} · ${e.state}`}
                  className={`el-cell ${
                    e.state === "DONE"
                      ? "s-done"
                      : e.state === "FAILED"
                        ? "s-failed"
                        : e.state === "RUNNING"
                          ? "s-running"
                          : "s-other"
                  }`}
                  onClick={() => onSelectJob(e.job_id)}
                >
                  {e.array_index}
                </span>
              ))}
          </div>
        </div>
      )}

      {first && (
        <div className="sec">
          <div className="sec-h">Task</div>
          <dl className="kv">
            <dt>command</dt>
            <dd className="mono small">{first.task.command}</dd>
            <dt>resources</dt>
            <dd>{fmtAsk(first.task.resources, true)}</dd>
          </dl>
        </div>
      )}

      <div className="sec row">
        <button className="btn sm" disabled={!terminal || row.counts.failed === 0} onClick={retryFailed}
          title={terminal ? undefined : "retry opens once the group settles"}>
          Retry failed ({row.counts.failed})
        </button>
        <Api>array_retry</Api>
      </div>
    </div>
  );
}
