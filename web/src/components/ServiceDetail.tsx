/**
 * Service detail: live tunneled endpoints (the whole point of a service),
 * exited diagnosis with log tail, stop vs stop-with-collect. service_status
 * is the honest re-check — it re-establishes dropped tunnels and says so.
 */

import { useEffect, useState } from "react";
import type { ManifestOutput, ServiceRow, ServiceStatus } from "@shared/types";
import { wtool } from "../api/client";
import { Api, fmtBytes, fmtClock, fmtDur } from "../bits";
import { store, useApp } from "../state";

export function ServicePill({ state }: { state: string }) {
  const cls =
    state === "ready" ? "s-running"
    : state === "starting" ? "s-queued"
    : state === "exited" ? "s-failed"
    : "s-cancelled";
  return <span className={`pill ${cls}`}>{state}</span>;
}

export function ServiceDetail({ service }: { service: ServiceRow }) {
  const { now } = useApp();
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [collected, setCollected] = useState<ManifestOutput[] | null>(null);
  const sid = service.service_id;

  const check = async () => {
    setChecking(true);
    try {
      const s = await wtool<ServiceStatus>("service_status", { service_id: sid });
      setStatus(s);
      if (s.tunnel_note) store.toast("warn", `⌁ service_status: ${s.tunnel_note}`);
      if (s.error) store.toast("err", `⌁ service_status: ${s.error} — ${s.detail ?? ""}`);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    setStatus(null);
    setCollected(null);
    void (async () => {
      const s = await wtool<ServiceStatus>("service_status", { service_id: sid });
      setStatus(s);
    })();
  }, [sid]);

  const stop = async (collect: boolean) => {
    setBusy(collect ? "collect" : "stop");
    try {
      const r = await wtool<{
        service_id: string;
        state: string;
        outputs?: ManifestOutput[];
        output_bytes?: number;
        error?: string;
        detail?: string;
      }>("service_stop", { service_id: sid, collect });
      if (r.error) {
        store.toast("err", `⌁ service_stop: ${r.error} — ${r.detail ?? ""}`);
      } else if (collect) {
        setCollected(r.outputs ?? []);
        store.toast(
          "ok",
          `⌁ service_stop(collect=True): stopped · ${r.outputs?.length ?? 0} output(s), ${fmtBytes(r.output_bytes ?? 0)}`,
        );
      } else {
        store.toast("ok", `⌁ service_stop: stopped`);
      }
    } finally {
      setBusy(null);
      store.refresh();
    }
  };

  const live = service.state === "ready" || service.state === "starting";
  const endpoints = status?.endpoints ?? [];
  const declared = service.task.outputs ?? [];

  return (
    <div className="card detail">
      <div className="pane-h">
        <ServicePill state={service.state} />
        {service.task.label && <b style={{ fontSize: 13 }}>{service.task.label}</b>}
        <span className="id">{sid}</span>
        <span className="dim small">
          {service.site} ·{" "}
          {live ? `up ${fmtDur(now - service.created_at)}` : `since ${fmtClock(service.created_at)}`}
        </span>
      </div>

      {service.state === "ready" && (
        <div className="sec">
          <div className="sec-h">
            Endpoints
            <span className="right">
              <Api>service_status — re-checks liveness, re-opens dropped tunnels</Api>
            </span>
          </div>
          {status == null ? (
            <div className="faint small">checking tunnels…</div>
          ) : endpoints.length ? (
            <>
              {endpoints.map((ep) => (
                <div className="endpoint" key={ep.port}>
                  <a href={ep.url} target="_blank" rel="noreferrer" className="ep-url">
                    {ep.url}
                  </a>
                  <span className="dim small">
                    {ep.local_port != null
                      ? `local :${ep.local_port} ⇄ ${service.site} :${ep.port} (ssh tunnel — the auth boundary)`
                      : `local site — port :${ep.port} directly`}
                  </span>
                  <button
                    className="btn sm ghost right-al"
                    onClick={() => {
                      void navigator.clipboard.writeText(ep.url);
                      store.toast("ok", `copied ${ep.url}`);
                    }}
                  >
                    Copy
                  </button>
                </div>
              ))}
              {status.tunnel_note && <div className="banner warn">{status.tunnel_note}</div>}
            </>
          ) : (
            <div className="faint small">no endpoints reported — re-check below</div>
          )}
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn sm" disabled={checking} onClick={() => void check()}>
              {checking ? "checking…" : "Re-check tunnels"}
            </button>
          </div>
        </div>
      )}

      {service.state === "exited" && (
        <div className="sec">
          <div className="death-card">
            <div className="dh">
              <b>service exited</b>
              <span className="dim"> — it stopped without a service_stop</span>
            </div>
            {status?.log_tail ? (
              <pre className="blk-out">{status.log_tail}</pre>
            ) : (
              <div className="faint small">fetching the log tail…</div>
            )}
            <div className="faint small" style={{ marginTop: 6 }}>
              fix the cause, then <span className="mono">service_start</span> again — the record above is
              what the process left behind
            </div>
          </div>
        </div>
      )}

      {service.state === "starting" && status?.log_tail && (
        <div className="sec">
          <div className="sec-h">Startup log</div>
          <pre className="blk-out">{status.log_tail}</pre>
        </div>
      )}

      {collected != null && (
        <div className="sec">
          <div className="sec-h">Collected outputs</div>
          {collected.length ? (
            <dl className="kv">
              {collected.map((o) => (
                <span key={o.ref} style={{ display: "contents" }}>
                  <dt className="mono small">{o.path}</dt>
                  <dd>
                    <span className="id plain">{o.ref}</span>{" "}
                    <span className="num dim">{fmtBytes(o.bytes)}</span>
                  </dd>
                </span>
              ))}
            </dl>
          ) : (
            <div className="faint small">the task declared no outputs — nothing to harvest</div>
          )}
        </div>
      )}

      <div className="sec">
        <div className="sec-h">Task</div>
        <dl className="kv">
          <dt>command</dt>
          <dd className="mono small">{service.task.command}</dd>
          <dt>ports</dt>
          <dd className="num">{service.ports.join(", ")}</dd>
          <dt>environment</dt>
          <dd>{service.task.env ? <span className="id plain">{service.task.env}</span> : "bare"}</dd>
          {declared.length > 0 && (
            <>
              <dt>declared outputs</dt>
              <dd className="mono small">{declared.join(", ")}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="sec row">
        <button className="btn sm" disabled={!live || busy != null} onClick={() => void stop(false)}>
          {busy === "stop" ? "stopping…" : "Stop"}
        </button>
        <button
          className="btn sm"
          disabled={!live || busy != null || !declared.length}
          title={
            declared.length
              ? "stop, then harvest the declared outputs into refs — side-products enter the record"
              : "the task declared no outputs to collect"
          }
          onClick={() => void stop(true)}
        >
          {busy === "collect" ? "collecting…" : "Stop + collect outputs"}
        </button>
        <Api>service_stop · service_stop(collect=True)</Api>
      </div>
    </div>
  );
}
