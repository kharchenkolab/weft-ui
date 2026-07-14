/**
 * Compute (mockup 03): site cards + detail — capability sheet ("what weft
 * sees", absences labeled with their consequence), live load with
 * per-partition bars, environments realized here (repair/evict), footprint
 * with confirm-gated GC, policy sentences, and the danger zone
 * (site_unregister). Every action names its ⌁ tool.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FootprintInfo,
  SiteCapabilities,
  SiteDetail,
  SiteLoadInfo,
  SiteSummary,
} from "@shared/types";
import { wtool } from "../api/client";
import { Api, fmtBytes, fmtClock } from "../bits";
import { act, store, useApp } from "../state";

function capsLine(s: SiteSummary): string {
  const bits = [
    s.cpus ? `${s.cpus} cpus` : null,
    s.mem_gb ? `${s.mem_gb} GB` : null,
    s.gpus ? `${s.gpus}× gpu` : null,
    s.scheduler && s.scheduler !== "none" ? s.scheduler : "no scheduler",
  ].filter(Boolean);
  return bits.join(" · ");
}

function SiteCards({
  sites,
  selected,
  onSelect,
  onReorder,
}: {
  sites: SiteSummary[];
  selected: string | null;
  onSelect: (n: string) => void;
  /** move card `from` to the position of card `to` (live, while dragging) */
  onReorder: (from: string, to: string) => void;
}) {
  // ref, not state: dragenter can fire before React re-renders after dragstart
  const dragFrom = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  return (
    <div className="cards">
      {sites.map((s) => (
        <div
          key={s.name}
          className={`card site-card${selected === s.name ? " on" : ""}${dragging === s.name ? " dragging" : ""}`}
          onClick={() => onSelect(s.name)}
          draggable
          onDragStart={(e) => {
            dragFrom.current = s.name;
            setDragging(s.name);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", s.name);
          }}
          onDragEnter={() => {
            const from = dragFrom.current;
            if (from && from !== s.name) onReorder(from, s.name);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragEnd={() => {
            dragFrom.current = null;
            setDragging(null);
          }}
        >
          <div className="top">
            <span className={`dot ${s.health === "ok" ? "ok" : "bad"}`} />
            <span className="nm">{s.name}</span>
            <span className="kind">{s.kind === "local" ? "this machine" : s.kind}</span>
          </div>
          <div className="caps">
            {s.health === "ok" ? capsLine(s) : `${s.health} — last known: ${capsLine(s)}`}
          </div>
        </div>
      ))}
      {!sites.length && (
        <div className="card site-card">
          <div className="caps">no sites yet — add compute to get started</div>
        </div>
      )}
    </div>
  );
}

function CapabilitySheet({ caps, kind }: { caps: SiteCapabilities; kind: string }) {
  const sched = caps.scheduler ?? {};
  const parts = sched.partitions ?? [];
  const gpus = caps.gpus ?? [];
  return (
    <div className="sec">
      <div className="sec-h">
        What weft sees
        <span className="right dim" style={{ textTransform: "none", fontWeight: 400 }}>
          capability record{caps.compute ? " · compute-node view" : " · login view"}
        </span>
      </div>
      <dl className="kv">
        <dt>arch / glibc</dt>
        <dd>
          {caps.arch ?? "?"}{caps.glibc ? ` · glibc ${caps.glibc}` : ""} · {caps.os ?? "?"}
        </dd>
        <dt>cpus / memory</dt>
        <dd className="num">{caps.cpus ?? "?"} cpus · {caps.mem_gb ?? "?"} GB</dd>
        {kind !== "local" && (
          <>
            <dt>scheduler</dt>
            <dd>{sched.type && sched.type !== "none" ? `${sched.type} ${sched.version ?? ""}` : "none"}</dd>
          </>
        )}
        <dt>internet</dt>
        <dd>
          {caps.internet ? (
            "yes"
          ) : (
            <>
              <b>no</b> — environments arrive <b>packed</b> (built where there’s
              internet, shipped as archives)
            </>
          )}
        </dd>
        <dt>gpus</dt>
        <dd>
          {gpus.length
            ? gpus.map((g) => `${g.count ?? 1}× ${g.model ?? "gpu"}`).join(", ") +
              (caps.cuda_driver ? ` · cuda driver ${caps.cuda_driver}` : "")
            : "none seen"}
        </dd>
        <dt>module system</dt>
        <dd>{caps.module_system ? "yes" : "no"}</dd>
        <dt>runtimes</dt>
        <dd>
          {Object.entries(caps.runtimes ?? {})
            .filter(([, v]) => v)
            .map(([k, v]) => (typeof v === "string" && v ? `${k} ${v}` : k))
            .join(" · ") || <span className="unknown">none detected</span>}
        </dd>
        <dt>probed</dt>
        <dd className="dim">
          {caps.probed_at ? fmtClock(caps.probed_at) : "—"} on {caps.measured_on ?? "?"}
        </dd>
      </dl>
      {parts.length > 0 && (
        <>
          <hr className="hr" />
          <table className="tbl parts-tbl">
            <thead>
              <tr>
                <th>Partition</th>
                {/* heterogeneous partitions arrive as one row per node
                    class (features tag it, weft ≥5ff9f36 counts nodes) */}
                <th>Node class</th>
                <th className="r">Nodes</th>
                <th className="r">Cores/node</th>
                <th>GPUs</th>
                <th className="r">Max wall</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p, i) => {
                // capabilities:v2 gres is structured: [{type, model, count}]
                const gres = Array.isArray(p.gres)
                  ? (p.gres as { type?: string; model?: string; count?: number }[])
                      .map((g) => `${g.count ?? 1}× ${g.model ?? g.type ?? "?"}`)
                      .join(", ")
                  : String(p.gres ?? "");
                const features = Array.isArray(p.features)
                  ? (p.features as string[]).join(", ")
                  : "";
                const samePartAsPrev = i > 0 && parts[i - 1].name === p.name;
                return (
                  <tr key={i}>
                    <td>
                      {samePartAsPrev ? null : (
                        <>
                          <b>{String(p.name ?? "?")}</b>{" "}
                          {p.default ? <span className="faint small">default</span> : null}
                        </>
                      )}
                    </td>
                    <td className="dim small mono">{features || "—"}</td>
                    <td className="r num" title={p.nodes == null ? "not reported — re-probe for node counts" : undefined}>
                      {p.nodes != null ? String(p.nodes) : "—"}
                    </td>
                    <td className="r num">
                      {String(p.cpus_per_node ?? "—")}
                      {p.mem_gb_per_node != null ? ` · ${String(p.mem_gb_per_node)}G` : ""}
                    </td>
                    <td className="dim">{gres || "—"}</td>
                    <td className="r num">{String(p.max_walltime ?? "—")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function LiveLoad({ site }: { site: string }) {
  const [load, setLoad] = useState<SiteLoadInfo | null>(null);
  const [asked, setAsked] = useState<string>("");

  useEffect(() => {
    let alive = true;
    setLoad(null);
    wtool<SiteLoadInfo>("site_load", { name: site }).then((r) => alive && setLoad(r));
    return () => {
      alive = false;
    };
  }, [site]);

  if (!load) return <div className="sec faint small">reading load…</div>;
  if (load.error)
    return (
      <div className="sec">
        <div className="sec-h">Live load</div>
        <span className="unknown">cannot read load — {String(load.detail ?? load.error)}</span>
      </div>
    );
  const parts = Object.entries(load.partitions ?? {});
  const plain = Object.entries(load)
    .filter(([k, v]) => typeof v === "number" && ["load1", "load5", "load15", "cpus", "mem_free_gb"].includes(k))
    .map(([k, v]) => `${k} ${v}`);
  return (
    <div className="sec">
      <div className="sec-h">
        Live load
        <span className="right">
          <Api>site_load</Api>
        </span>
      </div>
      {parts.length > 0 ? (
        parts.map(([name, p]) => (
          <div className="pbar" style={{ marginTop: 5 }} key={name}>
            <span>{name}</span>
            <span
              className="track"
              title={`${p.cpus_allocated} of ${p.cpus_total} cores allocated (blue) · ${p.cpus_idle} idle (green)${
                p.cpus_total - p.cpus_allocated - p.cpus_idle > 0
                  ? ` · ${p.cpus_total - p.cpus_allocated - p.cpus_idle} down/other (gap)`
                  : ""
              }`}
            >
              <b className="alloc" style={{ width: `${(100 * p.cpus_allocated) / Math.max(p.cpus_total, 1)}%` }} />
              <b className="idle" style={{ width: `${(100 * p.cpus_idle) / Math.max(p.cpus_total, 1)}%` }} />
            </span>
            <span className="num dim">
              {p.cpus_idle} idle / {p.cpus_total} cores
              {p.pending_jobs ? ` · ${p.pending_jobs} pending` : ""}
            </span>
          </div>
        ))
      ) : typeof load.load_fraction === "number" ? (
        // no queue — one honest bar from the measured load fraction
        <>
          <div className="pbar" style={{ marginTop: 5 }}>
            <span>cpu</span>
            <span
              className="track"
              title={`1-minute load average as a share of ${String(load.cpus ?? "?")} cores — how busy the node is right now`}
            >
              <b className="alloc" style={{ width: `${Math.min(100, 100 * (load.load_fraction as number))}%` }} />
            </span>
            <span className="num dim">
              {Math.round(100 * (load.load_fraction as number))}% of {String(load.cpus ?? "?")} cores
              {load.mem_available_gb != null ? ` · ${String(load.mem_available_gb)} GB mem free` : ""}
            </span>
          </div>
          <div className="faint small" style={{ marginTop: 4 }}>
            no queue — jobs start immediately; load1 {String(load.load1 ?? "?")} · load15{" "}
            {String(load.load15 ?? "?")}
          </div>
        </>
      ) : (
        <span className="dim small">{plain.join(" · ") || "no load figures"}</span>
      )}
      {load.my_jobs != null && (
        <div className="dim small" style={{ marginTop: 5 }}>
          my jobs here: {(load.my_jobs as { running?: number }).running ?? 0} running ·{" "}
          {(load.my_jobs as { pending?: number }).pending ?? 0} pending
        </div>
      )}
      {Array.isArray(load.qos) && (load.qos as { name: string; max_wall?: string }[]).length > 0 && (
        <div className="dim small" style={{ marginTop: 4 }}>
          {/* partitions often say "infinite" — the QOS is the real walltime bound */}
          walltime via qos:{" "}
          {(load.qos as { name: string; max_wall?: string }[])
            .filter((q) => q.max_wall)
            .slice(0, 6)
            .map((q) => `${q.name} ${q.max_wall}`)
            .join(" · ")}
        </div>
      )}
      {load.login_note && <div className="faint small" style={{ marginTop: 5 }}>{load.login_note}</div>}
      {asked && <div className="small" style={{ marginTop: 6 }}>{asked}</div>}
      {/* a start estimate only means something where a queue exists — on a
          plain ssh/local site jobs start immediately (or weft errors) */}
      {parts.length > 0 && (
        <div className="row" style={{ marginTop: 8, gap: 6 }}>
          <button
            className="btn sm"
            onClick={async () => {
              setAsked("asking the scheduler…");
              const r = await wtool<SiteLoadInfo>("site_load", {
                name: site,
                resources: { cpus: 4, mem_gb: 8, walltime: "01:00:00" },
              });
              const est = (r as Record<string, unknown>).start_estimate as
                | { estimated_start?: string; raw?: string }
                | undefined;
              if (est?.estimated_start) {
                const t = new Date(est.estimated_start);
                const mins = Math.round((t.getTime() - Date.now()) / 60000);
                const when =
                  mins <= 1 ? "immediately" : mins < 60 ? `in ~${mins} min` : `in ~${(mins / 60).toFixed(1)} h`;
                setAsked(
                  `a 4-core / 8 GB / 1 h job would start ${when} (${t.toLocaleString([], {
                    weekday: "short", hour: "2-digit", minute: "2-digit",
                  })})`,
                );
              } else {
                setAsked("the scheduler offered no estimate for this shape");
              }
            }}
          >
            Estimate start for 4c / 8G / 1h
          </button>
          <Api>site_load(resources=…)</Api>
        </div>
      )}
    </div>
  );
}

function EnvsHere({ site, footprint }: { site: string; footprint: FootprintInfo | null }) {
  const reals = footprint?.realizations ?? [];
  if (!reals.length) return null;
  return (
    <div className="sec">
      <div className="sec-h">
        Environments realized here
        <span className="right">
          <Api>env_repair · env_evict</Api>
        </span>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Env</th>
            <th className="r">Size</th>
            <th className="r">Idle</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {reals.map((r) => (
            <tr key={r.env_id}>
              <td>
                <span className="id plain">{r.env_id.slice(0, 18)}…</span>
              </td>
              <td className="r num">{fmtBytes(r.bytes)}</td>
              <td className="r num">
                {r.idle_days != null ? `${r.idle_days} d` : <span className="unknown">never used</span>}
              </td>
              <td className="r nowrap">
                <button className="btn sm" onClick={() => void act("env_repair", { env_id: r.env_id, site })}>
                  Repair
                </button>{" "}
                <button className="btn sm" onClick={() => void act("env_evict", { env_id: r.env_id, site })}>
                  Evict
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small faint" style={{ marginTop: 6 }}>
        Evict is cheap to undo: the prefix rebuilds in seconds, offline — the shared
        package cache stays warm.
      </p>
    </div>
  );
}

function Footprint({ site, footprint }: { site: string; footprint: FootprintInfo | null }) {
  const [plan, setPlan] = useState<string>("");
  if (!footprint || footprint.error) return null;
  const nums = Object.entries(footprint).filter(([, v]) => typeof v === "number") as [string, number][];
  return (
    <details className="disclose">
      <summary>
        Disk footprint
        <span className="peek">
          {nums.map(([k, v]) => `${k.replace(/_bytes|_gb/, "")} ${v > 1e6 ? fmtBytes(v) : v}`).join(" · ") || "measured on open"}
        </span>
      </summary>
      <div className="disc-body">
        <dl className="kv">
          {nums.map(([k, v]) => (
            <span key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd className="num">{v > 1e6 ? fmtBytes(v) : String(v)}</dd>
            </span>
          ))}
        </dl>
        {plan && <div className="log" style={{ marginTop: 8 }}>{plan}</div>}
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="btn sm"
            onClick={async () => {
              const r = await wtool<Record<string, unknown>>("gc_plan", { site });
              setPlan(JSON.stringify(r, null, 1));
            }}
          >
            Plan reclaim
          </button>
          <button
            className="btn sm danger"
            disabled={!plan}
            title={plan ? "executes the plan above" : "plan first — nothing deletes implicitly"}
            onClick={() => {
              void act("gc_sweep", { site, confirm: true, _confirm: true });
              setPlan("");
            }}
          >
            Free up…
          </button>
          <Api>site_footprint · gc_plan · gc_sweep(confirm)</Api>
        </div>
        <p className="small faint" style={{ marginTop: 5 }}>
          Confirm-gated: plan first, nothing is deleted implicitly. Evicted content
          re-stages/rebuilds on next use.
        </p>
      </div>
    </details>
  );
}

function Policy({ detail, onSaved }: { detail: SiteDetail; onSaved: () => void }) {
  const pol = detail.config?.policy ?? {};
  const notes = pol.notes ?? [];
  const [editing, setEditing] = useState(false);
  const [gpus, setGpus] = useState(pol.max_gpus?.toString() ?? "");
  const [jobs, setJobs] = useState(pol.max_concurrent_jobs?.toString() ?? "");
  const [noteText, setNoteText] = useState(notes.join("\n"));
  const hasRules =
    pol.max_gpus != null || pol.max_concurrent_jobs != null || pol.partitions_allowed?.length || pol.storage;

  const save = async () => {
    const policy: Record<string, unknown> = { ...pol };
    gpus ? (policy.max_gpus = Number(gpus)) : delete policy.max_gpus;
    jobs ? (policy.max_concurrent_jobs = Number(jobs)) : delete policy.max_concurrent_jobs;
    const ns = noteText.split("\n").map((n) => n.trim()).filter(Boolean);
    ns.length ? (policy.notes = ns) : delete policy.notes;
    // policy editing IS re-registration — register_site upserts idempotently
    await act("register_site", {
      name: detail.name, kind: detail.kind,
      config: { ...detail.config, policy }, _confirm: true,
    });
    setEditing(false);
    onSaved();
  };

  if (editing)
    return (
      <div className="sec">
        <div className="sec-h">Policy</div>
        <p style={{ fontSize: 13, lineHeight: 2.2 }}>
          Use at most{" "}
          <input className="inline-input" size={2} value={gpus} placeholder="∞"
                 onChange={(e) => setGpus(e.target.value)} /> GPUs and{" "}
          <input className="inline-input" size={2} value={jobs} placeholder="∞"
                 onChange={(e) => setJobs(e.target.value)} /> concurrent jobs.
        </p>
        <textarea className="input" rows={2} value={noteText}
                  placeholder="one note per line"
                  onChange={(e) => setNoteText(e.target.value)} />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn sm primary" onClick={() => void save()}>Save (re-register)</button>
          <button className="btn sm" onClick={() => setEditing(false)}>Cancel</button>
          <Api>register_site</Api>
        </div>
      </div>
    );

  return (
    <div className="sec">
      <div className="sec-h">
        Policy
        <span className="right">
          <button className="btn sm" onClick={() => setEditing(true)}>Edit</button>
        </span>
      </div>
      {hasRules ? (
        <p style={{ fontSize: 12.5, maxWidth: "60ch" }}>
          {pol.max_gpus != null && <>Use at most <b>{pol.max_gpus} GPUs</b>. </>}
          {pol.max_concurrent_jobs != null && <>At most <b>{pol.max_concurrent_jobs} concurrent jobs</b>. </>}
          {pol.partitions_allowed?.length ? (
            <>Partitions allowed: <b>{pol.partitions_allowed.join(", ")}</b>. </>
          ) : null}
          {pol.storage?.large && <>Large files at <span className="mono small">{pol.storage.large}</span>. </>}
          {pol.storage?.scratch && <>Scratch at <span className="mono small">{pol.storage.scratch}</span>.</>}
        </p>
      ) : (
        <p className="dim" style={{ fontSize: 12.5 }}>no structured rules set</p>
      )}
      {notes.length > 0 && (
        <p style={{ fontSize: 12.5, marginTop: 6 }} className="dim">
          Notes the agent reads before submitting: <i>“{notes.join(" · ")}”</i>
        </p>
      )}
      <p className="small faint" style={{ marginTop: 6 }}>
        Structured rules are enforced by weft at submit; notes are surfaced verbatim in
        every plan. Edit = re-register with the modified config (idempotent).
      </p>
    </div>
  );
}

export function ComputePage({ onAddCompute }: { onAddCompute: () => void }) {
  const { sites, workspace } = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SiteDetail | null>(null);
  const [footprint, setFootprint] = useState<FootprintInfo | null>(null);

  // user-chosen card order, per workspace; sites weft adds later append at the end
  const orderKey = `weft-ui:site-order:${workspace}`;
  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => {
    try {
      setOrder(JSON.parse(localStorage.getItem(orderKey) ?? "[]") as string[]);
    } catch {
      setOrder([]);
    }
  }, [orderKey]);
  const ordered = useMemo(() => {
    const pos = new Map(order.map((n, i) => [n, i]));
    return [...sites].sort(
      (a, b) => (pos.get(a.name) ?? order.length) - (pos.get(b.name) ?? order.length),
    );
  }, [sites, order]);
  const reorder = (from: string, to: string) => {
    const names = ordered.map((s) => s.name);
    const fi = names.indexOf(from);
    const ti = names.indexOf(to);
    if (fi < 0 || ti < 0 || fi === ti) return;
    names.splice(ti, 0, ...names.splice(fi, 1));
    setOrder(names);
    localStorage.setItem(orderKey, JSON.stringify(names));
  };

  const name = selected ?? ordered[0]?.name ?? null;

  useEffect(() => {
    if (!name) return;
    let alive = true;
    setDetail(null);
    setFootprint(null);
    wtool<SiteDetail>("sites_describe", { name }).then((r) => alive && setDetail(r));
    wtool<FootprintInfo>("site_footprint", { site: name }).then((r) => alive && setFootprint(r));
    return () => {
      alive = false;
    };
  }, [name, sites]);

  const unreachable = sites.filter((s) => s.health !== "ok").length;
  return (
    <>
      <div className="compute-h">
        <h1>Compute</h1>
        <span className="dim small">
          {sites.length} site{sites.length === 1 ? "" : "s"}
          {unreachable ? ` · ${unreachable} unreachable` : ""}
        </span>
        <span className="right-al row">
          <button className="btn primary" onClick={onAddCompute}>
            + Add compute
          </button>
          <Api>register_site</Api>
        </span>
      </div>
      <div className="compute-split">
        <SiteCards sites={ordered} selected={name} onSelect={setSelected} onReorder={reorder} />
        {detail && !detail.error ? (
          <div className="card detail" style={{ maxHeight: "none" }}>
            <div className="pane-h">
              <span className={`dot ${detail.health === "ok" || !detail.health ? "ok" : "bad"}`} />
              <b style={{ fontSize: 14 }}>{detail.name}</b>
              <span className="kind dim small">
                {detail.kind}
                {detail.config?.host ? ` · ${detail.config.user ?? "?"}@${detail.config.host}:${detail.config.port ?? 22}` : ""}
              </span>
              <span className="right-al row">
                <button className="btn sm" onClick={() => void act("site_probe", { name: detail.name })}>
                  Re-probe
                </button>
                <Api>site_probe</Api>
              </span>
            </div>
            <div className="two-col">
              <div>
                {detail.capabilities && <CapabilitySheet caps={detail.capabilities} kind={detail.kind} />}
                {(detail.capabilities?.storage?.candidates?.length ?? 0) > 0 && (
                  <div className="sec">
                    <div className="sec-h">Storage</div>
                    {/* shim ≥v4 probes carry volume totals → true utilization
                        bars; older probe records fall back to free space
                        relative to the roomiest volume (re-probe upgrades) */}
                    {(() => {
                      const cands = detail.capabilities!.storage!.candidates!;
                      const haveTotals = cands.every((c) => (c.total_gb ?? 0) > 0);
                      const maxFree = Math.max(...cands.map((c) => c.free_gb ?? 0), 1);
                      const rows = cands.map((c) => {
                        const used = haveTotals ? c.total_gb! - (c.free_gb ?? 0) : 0;
                        const frac = haveTotals ? used / c.total_gb! : (c.free_gb ?? 0) / maxFree;
                        const tip = haveTotals
                          ? `${Math.round(100 * frac)}% full — ${used.toLocaleString()} of ${c.total_gb!.toLocaleString()} GB used`
                          : `${(c.free_gb ?? 0).toLocaleString()} GB free — this probe predates volume totals, so a longer bar only means more free space than the other volumes (re-register the site to get true fill levels)`;
                        return (
                          <div className="quota" key={c.path}>
                            <span className="mono small path" title={c.path}>{c.path}</span>
                            <span className="track" title={tip}>
                              <b
                                className={haveTotals ? (frac > 0.9 ? "used hot" : "used") : "free"}
                                style={{ width: `${Math.max(1.5, 100 * frac)}%` }}
                              />
                            </span>
                            <span className="num dim nowrap">
                              {c.free_gb != null
                                ? `${c.free_gb.toLocaleString()} GB free`
                                : "free space unknown"}
                              {c.writable === false ? " · read-only" : ""}
                            </span>
                          </div>
                        );
                      });
                      return (
                        <>
                          {rows}
                          <div className="small faint" style={{ marginTop: 4 }}>
                            {haveTotals
                              ? "bars: used share of each volume"
                              : "bars: free space relative to the roomiest volume (older probe — re-registering the site upgrades it)"}
                            {" · weft root: "}
                            <span className="mono">{detail.config?.root ?? "?"}</span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
                <Policy
                  detail={detail}
                  onSaved={() =>
                    wtool<SiteDetail>("sites_describe", { name: detail.name }).then(setDetail)
                  }
                />
              </div>
              <div>
                <LiveLoad site={detail.name} />
                <EnvsHere site={detail.name} footprint={footprint} />
                <Footprint site={detail.name} footprint={footprint} />
                <details className="disclose">
                  <summary>
                    Forget this site
                    <span className="peek faint">registration only — nothing on its disk is touched</span>
                  </summary>
                  <div className="disc-body">
                    <div className="danger-zone">
                      <div className="row">
                        <div>
                          <b style={{ fontSize: 12.5 }}>Forget {detail.name}</b>
                          <div className="small dim" style={{ maxWidth: "54ch" }}>
                            De-registers the site. The weft root, realized envs, and staged
                            bytes stay on its disk — re-registering re-adopts them. Refused
                            while jobs, kernels, or services are live there.
                          </div>
                        </div>
                        <span className="right-al row">
                          <button
                            className="btn sm danger"
                            onClick={async () => {
                              await act("site_unregister", { name: detail.name });
                              setSelected(null);
                              store.refresh();
                            }}
                          >
                            Forget…
                          </button>
                          <Api>site_unregister</Api>
                        </span>
                      </div>
                    </div>
                  </div>
                </details>
              </div>
            </div>
          </div>
        ) : (
          <div className="card detail" style={{ maxHeight: "none" }}>
            <div className="empty-detail">{name ? "reading site…" : "no site selected"}</div>
          </div>
        )}
      </div>
    </>
  );
}
