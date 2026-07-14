/**
 * Activity: the workspace audit trail — user clicks and agent calls in
 * one place. (Upstream note: weft currently audits every tool call as
 * actor "agent"; the actor column will become honest once weft grows an
 * actor seam — filed in misc/from-weft-ui.md.)
 */

import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Api, fmtWhen } from "../bits";
import { useApp } from "../state";

interface AuditRow {
  seq: number;
  ts: number;
  actor: string;
  action: string;
  site: string;
  command: string;
  why: string;
  result: string;
}

export function ActivityPage() {
  const { ticker } = useApp();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const head = ticker[0]?.seq ?? 0;

  useEffect(() => {
    let alive = true;
    api.audit(200).then((r) => alive && setRows(r as unknown as AuditRow[]));
    return () => {
      alive = false;
    };
  }, [head]); // any bus event may mean a new audit row

  return (
    <div className="split" style={{ gridTemplateColumns: "1fr", paddingTop: 12 }}>
      <div className="card tablecard">
        <div className="sec">
          <div className="sec-h">
            Audit trail
            <span className="right">
              <Api>audit_tail</Api>
            </span>
          </div>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Site</th>
              <th>Command / detail</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((r) => (
              <tr key={r.seq}>
                <td className="num dim nowrap">{fmtWhen(r.ts)}</td>
                <td>
                  <span className="chip quiet">{r.actor}</span>
                </td>
                <td className="mono small">{r.action}</td>
                <td>{r.site || <span className="faint">—</span>}</td>
                <td className="cmd" style={{ maxWidth: 520 }} title={r.command || r.why}>
                  {r.command || r.why || <span className="faint">—</span>}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="dim" style={{ padding: 24, textAlign: "center" }}>
                  no audited actions yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
