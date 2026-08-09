/**
 * Chat (mockup 05): a weft-blind panel over typed turn events, with a
 * renderer registry keyed by tool name — plan / approval / digest /
 * error / manifest cards, reusing the jobs-panel components verbatim.
 * Approve resumes the same agent turn (defer + resume); "always allow
 * under X" writes the workspace threshold both faces of the gate share.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArrayStatus, EnsureAttempt, EnsureEnvelope, Manifest, SubmitPlan, WeftErrorPayload } from "@shared/types";
import { chat, chatStreamUrl, type AgentSetup, type ConversationMeta } from "../api/client";
import { Api, dateStratum, fmtBytes, fmtDur, GradeChip } from "../bits";
import { ErrorCardBody } from "../components/ErrorCard";
import { LoadStrip } from "../components/LoadStrip";
import { ManifestView } from "../components/ManifestView";
import { Md } from "../components/Md";
import { navigate, useRoute } from "../router";

/** what the agent is equipped with, and who decided — replaces the old
 * floating "weft skill mounted" note */
function AgentSetupPanel() {
  const [setup, setSetup] = useState<AgentSetup | null>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    void chat.setup().then(setSetup).catch(() => setSetup(null));
  }, []);
  if (!setup) return null;
  return (
    <div className="agent-setup">
      <div className="sh" style={{ padding: "12px 14px 6px", cursor: "pointer" }}
           onClick={() => setOpen(!open)}>
        <b style={{ fontSize: 12 }}>Agent setup</b>
        <span className="right-al faint chev">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div style={{ padding: "0 14px 12px" }} className="small">
          <div className="dim" style={{ margin: "4px 0 2px", fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em" }}>
            Skills
          </div>
          {setup.skills.map((s) => (
            <div key={s.name} className="setup-row" title={s.description}>
              <span className="mono">{s.name}</span>
              <span className="faint right-al">{s.source.replace(/ \(.*/, "")}</span>
            </div>
          ))}
          <div className="dim" style={{ margin: "8px 0 2px", fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em" }}>
            MCP servers
          </div>
          {setup.mcp_servers.map((s) => (
            <div key={s.name} className="setup-row" title={`${s.transport} — ${s.consent}`}>
              <span className="mono">{s.name}</span>
              <span className="faint right-al">
                {s.source === "built-in" ? "built-in" : s.consent === "allowed durably" ? "allowed" : "asks first"}
              </span>
            </div>
          ))}
          {setup.mcp_error && <div className="banner warn" style={{ marginTop: 6 }}>{setup.mcp_error}</div>}
          <div className="faint" style={{ marginTop: 8 }}>
            add skills in <span className="mono">.claude/skills/</span>, servers in{" "}
            <span className="mono">.mcp.json</span> (workspace) — picked up next turn.
            Built-ins: workspace reads only; Bash and subagents are denied by the gate.
          </div>
        </div>
      )}
    </div>
  );
}

interface ChatEvent {
  i: number;
  type: string;
  [key: string]: unknown;
}

// ---- cards -------------------------------------------------------------------

function PlanCard({ plan, title }: { plan: SubmitPlan; title: string }) {
  return (
    <div className="acard">
      <div className="ah">
        Plan — {title}
        <span className="right-al mono">task_submit(dry_run=True)</span>
      </div>
      <div className="sec" style={{ border: "none" }}>
        <dl className="plan-grid">
          <dt>site</dt>
          <dd>
            <b>{plan.site}</b>
          </dd>
          <dt>env</dt>
          <dd>
            {plan.env.env_id ? <span className="id plain">{plan.env.env_id.slice(0, 20)}…</span> : "bare"}{" "}
            · <b>{plan.env.action}</b>
          </dd>
          <dt>staging</dt>
          <dd>
            <b>{fmtBytes(plan.staging.bytes_to_move)}</b> to move
            {plan.staging.estimate_s > 1 ? (
              <span className="estimate"> ~{fmtDur(plan.staging.estimate_s)}</span>
            ) : null}
            {plan.staging.already_present.length > 0 &&
              ` · ${plan.staging.already_present.length} ref(s) already present`}
          </dd>
          <dt>queue</dt>
          <dd>{plan.queue}</dd>
          {plan.resources && (
            <>
              <dt>resources</dt>
              <dd>
                {plan.resources.cpus ?? "?"}c
                {plan.resources.mem_gb ? ` · ${plan.resources.mem_gb}G` : ""}
                {plan.resources.walltime ? ` · ${plan.resources.walltime}` : ""}
              </dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}

function DigestCard({ status }: { status: ArrayStatus }) {
  const total = Math.max(status.total ?? 0, 1);
  const pct = (n?: number) => `${(100 * (n ?? 0)) / total}%`;
  return (
    <div className="acard">
      <div className="ah">
        Array digest — <span className="mono">{status.group}</span>
        <span className="right-al mono">array_status</span>
      </div>
      <div className="sec" style={{ border: "none" }}>
        <div className="prog">
          <b className="p-done" title={`${status.done ?? 0} done`} style={{ width: pct(status.done) }} />
          <b className="p-failed" title={`${status.failed ?? 0} failed`} style={{ width: pct(status.failed) }} />
          <b className="p-running" title={`${status.running ?? 0} running`} style={{ width: pct(status.running) }} />
          <b
            className="p-queued"
            title={`${(status.queued ?? 0) + (status.preparing ?? 0)} queued / preparing`}
            style={{ width: pct((status.queued ?? 0) + (status.preparing ?? 0)) }}
          />
        </div>
        <div className="digest-mini">
          <span><i className="sq" style={{ background: "var(--ok)" }} /></span> {status.done} done ·
          <span><i className="sq" style={{ background: "var(--failed)" }} /></span>{" "}
          <b style={{ color: status.failed ? "var(--failed)" : undefined }}>{status.failed} failed</b> ·
          <span><i className="sq" style={{ background: "var(--run)" }} /></span> {status.running} running ·
          <span><i className="sq" style={{ background: "#d4d5d0" }} /></span> {(status.queued ?? 0) + (status.preparing ?? 0)} queued
        </div>
        {(status.failure_buckets ?? []).map((b) => (
          <div className="small" style={{ marginTop: 6 }} key={b.signature}>
            <span className="chip code user">{b.signature}</span>{" "}
            <span className="num dim">×{b.count}</span>{" "}
            <span className="faint">elements {b.sample_indices.join(", ")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function JsonFold({ payload, label }: { payload: unknown; label: string }) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 1);
  if (!text || text === "{}" || text === "null") return null;
  return (
    <details className="json-fold" style={{ margin: "4px 0" }}>
      <summary>{label} — full payload</summary>
      <div className="prev">{text.slice(0, 4000)}</div>
    </details>
  );
}

/** an ensure attempt's one-word verdict, colored like job states */
function ensurePill(outcome: string): string {
  if (outcome.startsWith("installed") || outcome === "solved") return "s-done";
  if (outcome === "skipped") return "s-queued";
  return "s-failed"; // failed | refused
}

function attemptDetail(a: EnsureAttempt): string {
  if (a.error) return a.error.error ?? "";
  if (a.mutations?.length) return a.mutations.join(", ");
  if (a.skip_reason) return a.skip_reason;
  return "";
}

/** ensure_available's typed envelope (v1, pinned upstream) — the verb's
 * whole story: what ran per lane, what was proven, what changed */
function EnsureCard({ env }: { env: EnsureEnvelope }) {
  const verified = Object.entries(env.verified ?? {});
  const target = env.session_id ?? env.env_id ?? "";
  return (
    <div className="acard">
      <div className="ah">
        Ensure — <span className="mono">{target.slice(0, 34)}</span>
        <span className="right-al row" style={{ gap: 6 }}>
          <span className={`pill ${env.satisfied ? "s-done" : "s-failed"}`}>
            {env.satisfied ? "SATISFIED" : "UNSATISFIED"}
          </span>
          <span className="chip quiet"
                title={env.changed ? "lanes ran and mutated the target" : "pre-check short-circuit — everything was already proven present, nothing mutated"}>
            {env.changed ? "changed" : "no-op"}
          </span>
          {env.verified_site && (
            <span className="chip quiet" title="verified NOW against this site's ready realization">
              @{env.verified_site}
            </span>
          )}
        </span>
      </div>
      <div className="sec" style={{ border: "none" }}>
        {(env.attempts?.length ?? 0) > 0 && (
          <table className="tbl parts-tbl">
            <thead>
              <tr><th>lane</th><th>outcome</th><th className="r">time</th><th>detail</th></tr>
            </thead>
            <tbody>
              {env.attempts.map((a, i) => (
                <tr key={i}>
                  <td className="mono">{a.lane}{a.spelling ? ` (${a.spelling})` : ""}</td>
                  <td><span className={`pill ${ensurePill(a.outcome)}`}>{a.outcome.toUpperCase()}</span></td>
                  <td className="r num dim">{a.seconds != null ? fmtDur(a.seconds) : "—"}</td>
                  <td className="mono small dim" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={a.error?.detail ?? a.shadows_base ?? undefined}>
                    {attemptDetail(a)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {verified.length > 0 && (
          <div className="row wrap small" style={{ gap: 6, marginTop: 6 }}>
            <span className="dim">proven:</span>
            {verified.map(([name, v]) => (
              <span key={name}
                    className={`chip ${v.status === "passed" ? "quiet" : "code"}`}
                    title={v.status === "passed"
                      ? `${v.check ?? "check"} passed${v.got ? ` — got ${v.got}` : ""}`
                      : `${v.status}${v.reason ? ` — ${v.reason}` : ""}${v.want ? ` (want ${v.want}, got ${v.got ?? "?"})` : ""}`}>
                {name}{v.status === "passed" ? " ✓" : v.status === "failed" ? " ✗" : " ?"}
              </span>
            ))}
          </div>
        )}
        {env.note && <div className="faint small" style={{ marginTop: 6 }}>{env.note}</div>}
      </div>
    </div>
  );
}

/** renderer registry: tool result → card (mockup 05 §1) */
function ResultCard({ tool, payload }: { tool: string; payload: unknown }) {
  if (payload == null || payload === "") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p === "object" && "error" in p) {
    return <ErrorCardBody err={p as unknown as WeftErrorPayload} />;
  }
  if (typeof p === "object" && p.plan && (tool === "task_submit" || tool === "task_status")) {
    const plan = p.plan as SubmitPlan;
    const handle = (p.job_id as string) ?? (p.group as string) ?? "";
    if (p.job_id || p.group) {
      // executed (not dry_run): compact line + plan fold
      return (
        <>
          {Boolean(p.memoized) && (
            <div className="small dim">memoized ↺ — identical task, manifest returned without re-running</div>
          )}
          <JsonFold payload={p} label={`${tool} → ${handle}`} />
        </>
      );
    }
    return <PlanCard plan={plan} title={String(p.site ?? "")} />;
  }
  if (tool === "array_status" && typeof p === "object" && p.group) {
    return <DigestCard status={p as unknown as ArrayStatus} />;
  }
  // probe mode returns {candidates} — no envelope; it falls to the fold
  if (tool === "ensure_available" && typeof p === "object" && "satisfied" in p) {
    return <EnsureCard env={p as unknown as EnsureEnvelope} />;
  }
  if (tool === "task_result" && typeof p === "object" && p.outputs) {
    return (
      <div className="acard">
        <div className="ah">
          Result — <span className="mono">{String(p.job_id ?? "")}</span>
          <span className="right-al">
            {typeof p.reproducibility === "string" && <GradeChip grade={p.reproducibility} />}
          </span>
        </div>
        <ManifestView manifest={p as unknown as Manifest} />
      </div>
    );
  }
  return <JsonFold payload={p} label={tool} />;
}

function ApprovalCard({
  ev,
  resolved,
  onDecide,
}: {
  ev: ChatEvent;
  resolved: string | null;
  onDecide: (decision: "allow" | "deny", opts?: { alwaysGb?: number; alwaysServer?: string }) => void;
}) {
  const [alwaysGb, setAlwaysGb] = useState("");
  const [alwaysServer, setAlwaysServer] = useState(false);
  const plan = ev.plan as SubmitPlan | null;
  const server = (ev.server as string) || "";
  const foreign = String(ev.tier) === "foreign";
  return (
    <div className="acard approve">
      <div className="ah">
        Approval needed — <b style={{ margin: "0 3px" }}>{String(ev.tier)}</b> tier
        <span className="right-al mono">
          {foreign ? "consent gate · tools outside weft's audit trail" : "consent gate · from the plan, not vibes"}
        </span>
      </div>
      <div className="sec" style={{ border: "none" }}>
        <p style={{ fontSize: 13 }}>
          <span className="mono">{String(ev.tool)}</span>
          {ev.reason ? <> — {String(ev.reason)}</> : " — requires explicit approval"}
        </p>
        {plan && (
          <dl className="plan-grid" style={{ marginTop: 8 }}>
            <dt>site</dt>
            <dd>{plan.site}</dd>
            <dt>staging</dt>
            <dd>{fmtBytes(plan.staging.bytes_to_move)} to move</dd>
            <dt>queue</dt>
            <dd>{plan.queue}</dd>
          </dl>
        )}
        {resolved ? (
          <p className="small" style={{ marginTop: 10 }}>
            {resolved === "allow" ? "✓ approved — the turn resumed" : "✗ denied — the agent was told why"}
          </p>
        ) : (
          <>
            <div className="row wrap" style={{ marginTop: 11, gap: 8 }}>
              <button
                className="btn primary sm"
                onClick={() =>
                  onDecide("allow", {
                    alwaysGb: alwaysGb ? Number(alwaysGb) : undefined,
                    alwaysServer: foreign && alwaysServer ? server : undefined,
                  })
                }
              >
                Approve
              </button>
              <button className="btn sm" onClick={() => onDecide("deny")}>
                Deny
              </button>
              {String(ev.tier) === "costly" && (
                <label className="check" style={{ marginLeft: 6 }}>
                  always allow staging under{" "}
                  <input
                    className="inline-input"
                    size={3}
                    value={alwaysGb}
                    onChange={(e) => setAlwaysGb(e.target.value)}
                  />{" "}
                  GB
                </label>
              )}
              {foreign && (
                <label className="check" style={{ marginLeft: 6 }}>
                  <input
                    type="checkbox"
                    checked={alwaysServer}
                    onChange={(e) => setAlwaysServer(e.target.checked)}
                  />{" "}
                  always allow <span className="mono">{server}</span> in this workspace
                </label>
              )}
            </div>
            <p className="small faint" style={{ marginTop: 8 }}>
              Approving resumes the same agent turn (defer + resume — never
              kill-and-restart). The same gate governs the equivalent buttons in the
              jobs panel.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ---- transcript --------------------------------------------------------------

function argsSummary(args: unknown): string {
  const s = JSON.stringify(args);
  return s && s !== "{}" ? (s.length > 90 ? s.slice(0, 90) + "…" : s) : "";
}

function Transcript({
  events,
  cid,
  onApproved,
}: {
  events: ChatEvent[];
  cid: string;
  onApproved: () => void;
}) {
  const resolvedById = useMemo(() => {
    const m = new Map<string, string>();
    for (const ev of events)
      if (ev.type === "approval_resolved") m.set(String(ev.id), String(ev.decision));
    return m;
  }, [events]);
  const resultIds = useMemo(
    () => new Set(events.filter((e) => e.type === "tool_result").map((e) => String(e.id))),
    [events],
  );

  const items: React.ReactNode[] = [];
  let agentBlock: React.ReactNode[] = [];
  const flush = (key: string) => {
    if (agentBlock.length) {
      items.push(
        <div className="msg agent" key={key}>
          <div className="who">✳</div>
          <div className="body">{agentBlock}</div>
        </div>,
      );
      agentBlock = [];
    }
  };

  events.forEach((ev) => {
    const key = `e${ev.i}`;
    switch (ev.type) {
      case "user_text":
        flush(`f${ev.i}`);
        items.push(
          <div className="msg user" key={key}>
            <div className="who">P</div>
            <div className="body">
              <p>{String(ev.text)}</p>
            </div>
          </div>,
        );
        break;
      case "text":
        agentBlock.push(<Md key={key} text={String(ev.text)} />);
        break;
      case "tool_call":
        agentBlock.push(
          <div className="tool-line" key={key}>
            <span className={resultIds.has(String(ev.id)) ? "tick" : "faint chev"}>
              {resultIds.has(String(ev.id)) ? "✓" : "▸"}
            </span>{" "}
            {String(ev.tool)} <span className="faint">{argsSummary(ev.args)}</span>
          </div>,
        );
        break;
      case "tool_result":
        agentBlock.push(
          <ResultCard key={key} tool={String(ev.tool)} payload={ev.payload} />,
        );
        break;
      case "approval_request":
        agentBlock.push(
          <ApprovalCard
            key={key}
            ev={ev}
            resolved={resolvedById.get(String(ev.id)) ?? null}
            onDecide={(decision, opts) => {
              void chat
                .approve(cid, String(ev.id), decision, {
                  alwaysAllowGb: opts?.alwaysGb,
                  alwaysAllowServer: opts?.alwaysServer,
                })
                .then(onApproved);
            }}
          />,
        );
        break;
      case "campaign":
        // the outline: declarations are the thread's section headings —
        // markers first (the header trail jumps here), page link second
        flush(`f${ev.i}`);
        items.push(
          <div className="row small" key={key} data-camp={String(ev.label ?? "")}
               style={{ margin: "10px 0 6px", gap: 8, alignItems: "center" }}>
            <span style={{ flex: 1, borderTop: "1px solid var(--line)" }} />
            {ev.label ? (
              <span className="dim" title={`declared by the ${String(ev.by ?? "agent")} — work below belongs to this campaign`}>
                campaign: <b style={{ color: "var(--ink)" }}>{String(ev.label)}</b>
              </span>
            ) : (
              <span className="faint">campaign cleared</span>
            )}
            {ev.label ? (
              <a className="id plain"
                 title="everything this campaign produced, on the Data page — runs, files, footprint"
                 onClick={() => navigate(["data", `campaign:${ev.label}`])}>
                data →
              </a>
            ) : null}
            <span style={{ flex: 1, borderTop: "1px solid var(--line)" }} />
          </div>,
        );
        break;
      case "turn_done":
        agentBlock.push(
          <div className="small faint" key={key} style={{ margin: "6px 0" }}>
            turn done · ${Number(ev.cost_usd ?? 0).toFixed(2)}
            {ev.subtype !== "success" ? ` · ${String(ev.subtype)}` : ""}
          </div>,
        );
        break;
      case "error":
        agentBlock.push(
          <div className="banner err" key={key} style={{ border: "1px solid #ecc8c5", borderRadius: 6, margin: "8px 0" }}>
            <b>turn failed</b>&nbsp;— {String(ev.detail)}
          </div>,
        );
        break;
    }
  });
  flush("tail");
  return <>{items}</>;
}

// ---- page --------------------------------------------------------------------

export function ChatPage() {
  const [convs, setConvs] = useState<ConversationMeta[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  // selected conversation lives in the URL: #/chat/c_x is a deep link
  const route = useRoute();
  const cid = route[0] === "chat" ? (route[1] ?? null) : null;
  const setCid = (id: string | null) => navigate(["chat", id], { replace: true });
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [campEdit, setCampEdit] = useState(false);
  const [campText, setCampText] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // the header trail jumps to a campaign's declaration heading in the
  // transcript — outline navigation stays INSIDE the thread
  const [scrollCamp, setScrollCamp] = useState<string | null>(null);
  const streamRef = useRef<EventSource | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  const refetchConvs = useCallback(() => {
    void chat.list().then(setConvs);
  }, []);

  useEffect(refetchConvs, [refetchConvs]);

  // one SSE stream per selected conversation, replay-then-live
  useEffect(() => {
    if (!cid) return;
    setEvents([]);
    streamRef.current?.close();
    const es = new EventSource(chatStreamUrl(cid, -1));
    streamRef.current = es;
    es.onmessage = (msg) => {
      const ev = JSON.parse(msg.data) as ChatEvent;
      if (ev.type === "_heartbeat") return;
      setEvents((prev) => (prev.some((e) => e.i === ev.i) ? prev : [...prev, ev]));
      if (ev.type === "turn_done" || ev.type === "approval_request") refetchConvs();
    };
    return () => es.close();
  }, [cid, refetchConvs]);

  useEffect(() => {
    paneRef.current?.scrollTo({ top: paneRef.current.scrollHeight });
  }, [events]);

  // outline jump: scroll the transcript to a campaign's declaration
  useEffect(() => {
    if (!scrollCamp) return;
    const el = paneRef.current?.querySelector(
      `[data-camp="${CSS.escape(scrollCamp)}"]`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
    setScrollCamp(null);
  }, [scrollCamp, events]);

  const meta = convs.find((c) => c.id === cid) ?? null;
  const running = events.length
    ? events[events.length - 1].type !== "turn_done" &&
      events.some((e) => e.type === "user_text") &&
      ["user_text", "text", "tool_call", "tool_result", "approval_request",
       "approval_resolved"].includes(events[events.length - 1].type)
    : false;

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    let target = cid;
    if (!target) {
      const meta = await chat.create();
      target = meta.id;
      setCid(target);
      refetchConvs();
    }
    setDraft("");
    await chat.send(target!, text).catch(() => {});
    refetchConvs();
  };

  return (
    <>
      {/* page-wide, right under the workspace topbar — same ambient strip
          as the jobs tab; the dots say where capacity is before you ask
          the agent to put work somewhere */}
      <LoadStrip />
      <div className="chat-layout">
      <div className="convs">
        <div className="sh">
          <b>Conversations</b>
          <button
            className="btn sm ghost right-al"
            onClick={() => void chat.create().then((m) => { setCid(m.id); refetchConvs(); })}
          >
            + New
          </button>
        </div>
        {convs.map((c, ci) => (
          <Fragment key={c.id}>
          {(ci === 0 || dateStratum(c.created_at) !== dateStratum(convs[ci - 1].created_at)) && (
            <div className="dim small" style={{ padding: "7px 12px 2px", letterSpacing: ".04em",
                                                textTransform: "uppercase", fontSize: 9.5 }}>
              {dateStratum(c.created_at)}
            </div>
          )}
          <div className={`c-item${c.id === cid ? " on" : ""}`} onClick={() => setCid(c.id)}
               style={{ position: "relative" }}>
            {editing === c.id ? (
              <input
                autoFocus
                style={{ width: "100%", fontSize: 11.5, padding: "2px 6px", border: "1px solid var(--line)", borderRadius: 4 }}
                value={editText}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && editText.trim())
                    void chat.rename(c.id, editText.trim()).then(() => { setEditing(null); refetchConvs(); });
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <div className="t" style={{ paddingRight: 18 }}>{c.title}</div>
            )}
            {/* housekeeping hides behind a hover-only ⋯ — nothing jumps
                on selection, nothing destructive sits under a stray click */}
            <span className="dots" title="rename / delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDel(null);
                    setMenuFor(menuFor === c.id ? null : c.id);
                  }}>⋯</span>
            {menuFor === c.id && (
              <div className="dots-menu" onClick={(e) => e.stopPropagation()}>
                <a className="id plain"
                   onClick={() => { setEditing(c.id); setEditText(c.title); setMenuFor(null); }}>
                  rename
                </a>
                {confirmDel === c.id ? (
                  <a className="id plain" style={{ color: "var(--err)" }}
                     title="the transcript goes; the audit trail of what the agent DID stays in weft's store"
                     onClick={() => void chat.remove(c.id).then(() => { setConfirmDel(null); setMenuFor(null); if (cid === c.id) setCid(null); refetchConvs(); })}>
                    delete — sure?
                  </a>
                ) : (
                  <a className="id plain" onClick={() => setConfirmDel(c.id)}>delete</a>
                )}
              </div>
            )}
            <div className="m">
              {c.state !== "idle" ? (
                <span className="pill s-running" style={{ fontSize: 9, padding: "1px 6px" }}>
                  {c.state === "waiting_approval" ? "WAITING" : "RUNNING"}
                </span>
              ) : (
                <span className="chip quiet" style={{ fontSize: 9, padding: "0 6px" }}>idle</span>
              )}
              <span className="mono">{c.id}</span>
            </div>
            <div className="m">
              {c.model} · ${c.cost_usd.toFixed(2)} / ${c.budget_usd.toFixed(2)}
            </div>
            {(c.campaigns?.length ?? 0) > 0 && (
              <div className="m" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {c.campaigns!.slice(0, 2).map((l) => (
                  <span key={l} className="chip quiet"
                        style={{ cursor: "pointer", maxWidth: 130, overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={`work this thread did — click to open the chat at the "${l}" section`}
                        onClick={(e) => { e.stopPropagation(); setCid(c.id); setScrollCamp(l); }}>
                    {l}
                  </span>
                ))}
                {c.campaigns!.length > 2 && (
                  <span className="faint small">+{c.campaigns!.length - 2}</span>
                )}
              </div>
            )}
          </div>
          </Fragment>
        ))}
        {/* pinned to the column's bottom; follows naturally when the
            conversation list grows past it */}
        <div style={{ borderTop: "1px solid var(--line2)", marginTop: "auto" }}>
          <AgentSetupPanel />
        </div>
      </div>

      <div className="conv">
        <div className="conv-h">
          <b style={{ fontSize: 12.5, flex: "0 1 auto", minWidth: 40, overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {meta?.title ?? "Chat"}
          </b>
          {meta && <span className="chip quiet mono">{meta.id}</span>}
          {/* the thread's outline: one chip per campaign, in declaration
              order — click jumps to that section of the transcript */}
          {(meta?.campaigns?.length ?? 0) > 0 && (
            <span className="row" style={{ gap: 4, flex: "1 1 auto", minWidth: 0,
                                           overflow: "hidden", flexWrap: "nowrap" }}>
              {meta!.campaigns!.map((l) => (
                <span key={l}
                      className="chip quiet"
                      style={{ cursor: "pointer", maxWidth: 140, overflow: "hidden",
                               textOverflow: "ellipsis", whiteSpace: "nowrap",
                               ...(l === meta!.campaign
                                   ? { borderColor: "var(--acc, #46f)", color: "var(--ink)" }
                                   : {}) }}
                      title={`jump to where "${l}" starts in this thread${l === meta!.campaign ? " (the open campaign)" : ""}`}
                      onClick={() => setScrollCamp(l)}>
                  {l}
                </span>
              ))}
            </span>
          )}
          <span className="right-al row" style={{ gap: 14 }}>
            {meta && (
              <span className="meter" title="per-conversation budget; hard stop at the cap">
                <span>${meta.cost_usd.toFixed(2)}</span>
                <span className="track">
                  <b
                    className={meta.cost_usd / meta.budget_usd > 0.8 ? "hot" : ""}
                    style={{ width: `${Math.min(100, (100 * meta.cost_usd) / meta.budget_usd)}%` }}
                  />
                </span>
                <span className="faint">/ ${meta.budget_usd.toFixed(2)}</span>
              </span>
            )}
            {meta && <span className="chip">model: {meta.model}</span>}
          </span>
        </div>

        <div className="stream-pane" ref={paneRef}>
          {cid ? (
            <Transcript events={events} cid={cid} onApproved={refetchConvs} />
          ) : (
            <div className="empty-detail">
              start a conversation — the agent drives this workspace through the same
              weft tools as every button in this UI
            </div>
          )}
        </div>

        <div className="composer">
          <div className="box">
            <textarea
              rows={2}
              placeholder="Ask, or paste a job id to pull it into context…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="btn primary sm" disabled={!draft.trim() || running} onClick={() => void send()}>
              Send
            </button>
          </div>
          <div className="row small faint" style={{ marginTop: 6, gap: 14 }}>
            {meta && (
              campEdit ? (
                <span className="row" style={{ gap: 6 }}>
                  <span className="faint">campaign:</span>
                  <input
                    className="inline-input" size={20} autoFocus
                    placeholder="new or existing label — empty closes it"
                    value={campText}
                    onChange={(e) => setCampText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        void chat.setCampaign(meta.id, campText.trim())
                          .then(() => { setCampEdit(false); refetchConvs(); });
                      if (e.key === "Escape") setCampEdit(false);
                    }}
                  />
                  <a className="id plain" onClick={() =>
                    void chat.setCampaign(meta.id, campText.trim())
                      .then(() => { setCampEdit(false); refetchConvs(); })}>save</a>
                  <a className="id plain faint" onClick={() => setCampEdit(false)}>cancel</a>
                </span>
              ) : meta.campaign ? (
                <span title="new work in this chat is filed under this campaign — the agent declared it (or you set it)">
                  <span className="faint">campaign:</span>{" "}
                  <b style={{ color: "var(--ink2)" }}>{meta.campaign}</b>{" "}
                  <a className="id plain faint"
                     title="rename the open campaign, attach to another, or close it"
                     onClick={() => { setCampText(meta.campaign ?? ""); setCampEdit(true); }}>
                    change
                  </a>
                </span>
              ) : (
                <span className="faint"
                      title="the agent declares one when substantial work starts; new submits are filed under it">
                  no campaign yet{" "}
                  <a className="id plain"
                     onClick={() => { setCampText(""); setCampEdit(true); }}>set</a>
                </span>
              )
            )}
            <span>{running ? "agent turn in progress…" : meta ? `${meta.turns} turn${meta.turns === 1 ? "" : "s"}` : ""}</span>
            <span className="right-al">
              <Api>every card renders from the same tool results the agent received</Api>
            </span>
          </div>
        </div>
      </div>
      </div>
    </>
  );
}
