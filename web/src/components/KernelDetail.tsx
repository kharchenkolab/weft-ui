/**
 * Kernel detail: transcript notebook (code + rc + output per block), a
 * run-block composer, and the lifecycle actions — interrupt, stop,
 * restart-with-replay (a NEW kernel), promote-to-record.
 *
 * Polling honesty (plan R1): kernel_status is light (file checks) and runs
 * on a 3 s cadence while the kernel is running; the transcript (N file
 * reads over the adapter) refreshes only when blocks_run/current_block
 * moves or one of our own blocks finishes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { KernelExecResult, KernelRow, KernelStatus, TranscriptEntry } from "@shared/types";
import { wtool } from "../api/client";
import { Api, fmtDur, fmtWhen, GradeChip } from "../bits";
import { act, store, useApp } from "../state";
import { RunRetention } from "./RunRetention";

export function KernelPill({ state }: { state: string }) {
  const cls =
    state === "running" ? "s-running" : state === "died" ? "s-failed" : "s-cancelled";
  return <span className={`pill ${cls}`}>{state}</span>;
}

function RcBadge({ rc }: { rc: number | null | undefined }) {
  if (rc == null)
    return (
      <span className="rc running" title="no rc file yet — running or never ran">
        ⏳
      </span>
    );
  if (rc === 0) return <span className="rc ok">✓ 0</span>;
  return (
    <span className="rc bad" title={rc === 130 ? "rc 130 — interrupted (SIGINT)" : undefined}>
      ✗ {rc}
    </span>
  );
}

function Block({
  entry,
  promotable,
  checked,
  onCheck,
}: {
  entry: TranscriptEntry;
  promotable: boolean;
  checked: boolean;
  onCheck?: (block: number, on: boolean) => void;
}) {
  const [full, setFull] = useState(false);
  const out = entry.out_tail ?? "";
  const lines = out.split("\n");
  const long = lines.length > 6;
  const shown = full || !long ? out : lines.slice(-6).join("\n");
  return (
    <div className="blk">
      <div className="blk-h">
        {promotable && onCheck ? (
          <label className="row" style={{ gap: 5 }}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => onCheck(entry.block, e.target.checked)}
              title="select for promotion"
            />
            <span className="mono dim">[{entry.block}]</span>
          </label>
        ) : (
          <span className="mono dim">[{entry.block}]</span>
        )}
        <RcBadge rc={entry.rc} />
      </div>
      {entry.error ? (
        <div className="faint small">block {entry.block}: {entry.error}</div>
      ) : (
        <>
          <pre className="blk-code">{entry.code}</pre>
          {out && (
            <pre className="blk-out">
              {shown}
              {long && (
                <a className="blk-more" onClick={() => setFull(!full)}>
                  {full ? " · fold" : ` · +${lines.length - 6} lines`}
                </a>
              )}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

export function KernelDetail({
  kernel,
  onSelectKernel,
  onOpenJob,
}: {
  kernel: KernelRow;
  onSelectKernel: (id: string) => void;
  /** jump to a job row in the jobs tab (promotion mints a DONE job) */
  onOpenJob: (jobId: string) => void;
}) {
  const { kernelDeaths, now } = useApp();
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<number | null>(null); // block being polled
  const [liveOut, setLiveOut] = useState(""); // kernel_peek deltas while the block runs
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const kid = kernel.kernel_id;
  const blocksSeen = useRef(-1);

  const refreshTranscript = useCallback(
    async (all: boolean) => {
      const t = await wtool<TranscriptEntry[] | { error: string }>("kernel_transcript", {
        kernel_id: kid,
        last: all ? 1000000 : 20,
      });
      if (Array.isArray(t)) setTranscript(t);
    },
    [kid],
  );

  // load on select; light status poll at 3 s while running, transcript
  // refetch only when the block counters move
  useEffect(() => {
    let alive = true;
    setStatus(null);
    setTranscript(null);
    setPicked(new Set());
    setMinted(null);
    setPending(null);
    setCode("");
    blocksSeen.current = -1;
    const tick = async () => {
      const s = await wtool<KernelStatus>("kernel_status", { kernel_id: kid });
      if (!alive || s.error) return;
      setStatus(s);
      const mark = s.blocks_run * 100000 + (s.current_block ?? -1);
      if (mark !== blocksSeen.current) {
        blocksSeen.current = mark;
        await refreshTranscript(false);
      }
    };
    void tick();
    const iv = window.setInterval(() => {
      if (kernel.state === "running") void tick();
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [kid, kernel.state, refreshTranscript]);

  // composer: submit wait=false, then 1 s poll until the block lands
  const run = async () => {
    const src = code.trim();
    if (!src) return;
    const r = await wtool<KernelExecResult>("kernel_exec", {
      kernel_id: kid,
      code: src,
      wait: false,
    });
    if (r.error) {
      store.toast("err", `⌁ kernel_exec: ${r.error} — ${r.detail ?? ""}`);
      store.refresh();
      return;
    }
    setCode("");
    setPending(r.block);
    setLiveOut("");
    await refreshTranscript(showAll);
    // kernel_peek drives the wait: incremental out/err deltas render live,
    // and running/rc from the same payload says when the block landed —
    // one identical code path for local and remote kernels
    let outOff = 0;
    let errOff = 0;
    const poll = async () => {
      const p = await wtool<{
        out_delta?: string; err_delta?: string; out_offset?: number;
        err_offset?: number; running?: boolean; error?: string; detail?: string;
      }>("kernel_peek", { kernel_id: kid, block: r.block, out_offset: outOff, err_offset: errOff });
      if (p.error) {
        store.toast("err", `⌁ kernel_peek: ${p.error} — ${p.detail ?? ""}`);
        setPending(null);
        setLiveOut("");
        store.refresh();
        return;
      }
      outOff = p.out_offset ?? outOff;
      errOff = p.err_offset ?? errOff;
      const delta = (p.out_delta ?? "") + (p.err_delta ?? "");
      if (delta) setLiveOut((prev) => (prev + delta).slice(-8000));
      if (!p.running) {
        setPending(null);
        setLiveOut("");
        await refreshTranscript(showAll);
        store.refresh(); // no event fires for exec — nudge the rows list
        return;
      }
      window.setTimeout(() => void poll(), 1000);
    };
    window.setTimeout(() => void poll(), 700);
  };

  const restart = async () => {
    setBusy("restart");
    try {
      const r = await wtool<{ kernel_id: string; replayed_blocks: number; error?: string; detail?: string }>(
        "kernel_restart",
        { kernel_id: kid, replay: "successful" },
      );
      if (r.error) {
        store.toast("err", `⌁ kernel_restart: ${r.error} — ${r.detail ?? ""}`);
      } else {
        store.toast("ok", `⌁ kernel_restart → ${r.kernel_id} · replayed ${r.replayed_blocks} block(s)`);
        onSelectKernel(r.kernel_id);
      }
    } finally {
      setBusy(null);
      store.refresh();
    }
  };

  const promote = async () => {
    const blocks = [...picked].sort((a, b) => a - b);
    setBusy("promote");
    try {
      const m = await wtool<{ job_id?: string; error?: string; detail?: string }>("kernel_promote", {
        kernel_id: kid,
        blocks,
      });
      if (m.error || !m.job_id) {
        store.toast("err", `⌁ kernel_promote: ${m.error} — ${m.detail ?? ""}`);
      } else {
        setMinted(m.job_id);
        setPicked(new Set());
        store.toast("ok", `⌁ kernel_promote → ${m.job_id}`);
      }
    } finally {
      setBusy(null);
      store.refresh();
    }
  };

  const running = kernel.state === "running";
  const death = kernel.state === "died" ? kernelDeaths.get(kid) : undefined;
  const entries = transcript ?? [];
  const busyBlock = status?.current_block ?? null;

  return (
    <div className="card detail">
      <div className="pane-h">
        <KernelPill state={kernel.state} />
        <b style={{ fontSize: 13 }}>{kernel.label || `${kernel.lang} kernel`}</b>
        <span className="id">{kid}</span>
        <span className="dim small">
          {kernel.label ? `${kernel.lang} · ` : ""}
          {kernel.site} · {kernel.env_id ? <span className="mono">{kernel.env_id.slice(0, 18)}…</span> : "bare interpreter"}
        </span>
        <span className="dim small">
          {running
            ? `idle ${fmtDur(status ? status.idle_s : now - kernel.last_used)}`
            : `since ${fmtWhen(kernel.last_used)}`}
        </span>
      </div>

      {kernel.state === "died" && (
        <div className="sec">
          <div className="death-card">
            <div className="dh">
              {/* the scheduler's verdict (weft ≥5ff9f36), not a guess */}
              <b title={death?.slurm_state ? `slurm: ${death.slurm_state}` : undefined}>
                {death?.cause === "walltime_exceeded"
                  ? "kernel died — walltime exceeded"
                  : death?.cause === "oom"
                    ? "kernel died — out of memory"
                    : death?.cause === "cancelled"
                      ? "kernel died — cancelled by the scheduler"
                      : death?.cause === "lost"
                        ? "kernel died — node lost"
                        : "kernel died"}
              </b>
              {death?.killing_block != null && (
                <span>
                  — while running block <span className="mono">[{death.killing_block}]</span>
                </span>
              )}
              {death?.exit_code != null && <span className="dim"> · exit {death.exit_code}</span>}
            </div>
            {death?.suggestion && <div className="small" style={{ marginTop: 4 }}>{death.suggestion}</div>}
            {death?.log_tail ? (
              <pre className="blk-out">{death.log_tail}</pre>
            ) : death ? (
              <div className="faint small">the process left no log tail — the transcript below shows what ran</div>
            ) : (
              <div className="faint small">
                diagnostics were in the <span className="mono">kernel.died</span> event, which predates this
                session’s replay window — the transcript below still shows what ran
              </div>
            )}
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm primary" disabled={busy != null} onClick={restart}>
                {busy === "restart" ? "restarting…" : "Restart with replay"}
              </button>
              <Api>kernel_restart(replay=&quot;successful&quot;) — a NEW kernel; state rebuilt from successful blocks</Api>
            </div>
          </div>
        </div>
      )}

      <div className="sec">
        <div className="sec-h">
          Transcript
          <span className="right">
            <Api>kernel_transcript</Api>
          </span>
        </div>
        <div className="dim small" style={{ marginBottom: 6 }}>
          {kernel.blocks_run} block{kernel.blocks_run === 1 ? "" : "s"}
          {running && " · status polled every 3 s"}
        </div>
        {!showAll && kernel.blocks_run > 20 && (
          <div className="faint small" style={{ marginBottom: 6 }}>
            showing the last 20 —{" "}
            <a
              className="id plain"
              onClick={() => {
                setShowAll(true);
                void refreshTranscript(true);
              }}
            >
              load all {kernel.blocks_run}
            </a>
          </div>
        )}
        {transcript == null ? (
          <div className="faint small">reading transcript…</div>
        ) : !entries.length ? (
          <div className="faint small">no blocks yet — run one below</div>
        ) : (
          entries.map((e) => (
            <Block
              key={e.block}
              entry={
                e.block === busyBlock || e.block === pending
                  ? { ...e, rc: e.rc ?? null }
                  : e
              }
              promotable={e.rc === 0}
              checked={picked.has(e.block)}
              onCheck={(b, on) => {
                const next = new Set(picked);
                if (on) next.add(b);
                else next.delete(b);
                setPicked(next);
              }}
            />
          ))
        )}

        {minted && (
          <div className="minted">
            promoted → <a className="id" onClick={() => onOpenJob(minted)}>{minted}</a>{" "}
            <GradeChip grade="state-dependent" />
            <span className="dim small"> — replayable from the recorded transcript, not re-derived</span>
          </div>
        )}

        {picked.size > 0 && (
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm primary" disabled={busy != null} onClick={promote}>
              {busy === "promote" ? "promoting…" : `Promote ${picked.size} block${picked.size === 1 ? "" : "s"} to the record`}
            </button>
            <Api>kernel_promote — mints a DONE job graded state-dependent</Api>
          </div>
        )}
      </div>

      {running && (
        <div className="sec">
          <div className="composer-mini">
            <textarea
              rows={3}
              placeholder={`run a ${kernel.lang} block against the kernel’s live state…  (⌘⏎ to run)`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void run();
                }
              }}
            />
            <div className="row">
              <button className="btn sm primary" disabled={!code.trim() || pending != null} onClick={() => void run()}>
                {pending != null ? `block [${pending}] running…` : "Run block"}
              </button>
              <Api>kernel_exec(wait=False) · kernel_peek (1 s)</Api>
            </div>
            {pending != null && liveOut && (
              <pre className="blk-out" style={{ marginTop: 6, maxHeight: 180, overflow: "auto" }}
                   title="incremental output while the block runs — the settled block lands in the transcript above">
                {liveOut}
              </pre>
            )}
          </div>
        </div>
      )}

      <RunRetention target={kernel.kernel_id} live={kernel.state === "running"} dir={kernel.jobdir} />

      <div className="sec row">
        <button
          className="btn sm"
          disabled={!running || busyBlock == null}
          title={busyBlock != null ? `SIGINT block [${busyBlock}]; the interpreter survives` : "no block is running"}
          onClick={() => void act("kernel_interrupt", { kernel_id: kid })}
        >
          Interrupt
        </button>
        <button
          className="btn sm"
          disabled={!running}
          title="stops the interpreter; the transcript stays readable"
          onClick={() => void act("kernel_stop", { kernel_id: kid })}
        >
          Stop
        </button>
        {kernel.state !== "died" && (
          <button className="btn sm" disabled={busy != null} onClick={restart} title="a NEW kernel; state rebuilt by replaying successful blocks">
            {busy === "restart" ? "restarting…" : "Restart w/ replay"}
          </button>
        )}
        <Api>kernel_interrupt · kernel_stop · kernel_restart</Api>
      </div>
    </div>
  );
}
