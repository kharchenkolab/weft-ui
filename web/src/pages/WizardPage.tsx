/**
 * Add compute (mockup 04): connecting a machine as a conversation —
 * try → observe → fix → confirm. Saved ssh hosts first; failure is a
 * first-class path (classified fix ladder, full stderr verbatim);
 * registration is narrated by weft's bootstrap.step events; the confirm
 * sheet is the probe result as an honest scoping document.
 *
 * v1 note: fix-ladder steps are copy-paste commands for YOUR terminal —
 * weft never handles your sign-in. (The embedded pty lands later; same
 * flow, one fewer attack surface for now.)
 */

import { useEffect, useMemo, useState } from "react";
import type {
  DfMount,
  PreflightResult,
  SinfoProbe,
  SiteCapabilities,
  SshHost,
} from "@shared/types";
import { TOKEN, wtool } from "../api/client";
import { Api } from "../bits";
import { store, useApp } from "../state";

type Kind = "local" | "ssh" | "slurm";
type Step = "kind" | "connect" | "storage" | "slurm" | "policy" | "register" | "confirm";

async function uiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

function Steps({ order, current }: { order: Step[]; current: Step }) {
  const labels: Record<Step, string> = {
    kind: "Kind", connect: "Connect", storage: "Storage", slurm: "Slurm",
    policy: "Policy", register: "Register", confirm: "Confirm",
  };
  const idx = order.indexOf(current);
  return (
    <div className="wiz-steps">
      {order.map((s, i) => (
        <span key={s} style={{ display: "contents" }}>
          {i > 0 && <span className="sep">›</span>}
          <span className={`st ${s === current ? "on" : i < idx ? "done" : ""}`}>
            {i < idx ? "✓ " : ""}
            {labels[s]}
          </span>
        </span>
      ))}
    </div>
  );
}

const KINDS: { kind: Kind | "cloud"; title: string; desc: string; disabled?: string }[] = [
  { kind: "local", title: "This machine", desc: "Run tasks right here. Nothing to connect." },
  { kind: "ssh", title: "Remote server", desc: "A workstation or server you connect to." },
  { kind: "slurm", title: "Slurm cluster", desc: "An HPC cluster with a batch scheduler." },
  { kind: "cloud", title: "Cloud", desc: "Provision on demand, with a spending cap.", disabled: "lands in M4 with the provisioner" },
];

export function WizardPage({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { ticker } = useApp();
  const [kind, setKind] = useState<Kind>("slurm");
  const [step, setStep] = useState<Step>("kind");
  const [siteName, setSiteName] = useState("");
  // connect
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [hostChoice, setHostChoice] = useState<string>("manual");
  const [dest, setDest] = useState("");
  const [port, setPort] = useState("");
  const [extraOpts, setExtraOpts] = useState("");
  const [testing, setTesting] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [openFix, setOpenFix] = useState(0);
  // storage
  const [mounts, setMounts] = useState<DfMount[] | null>(null);
  const [home, setHome] = useState("");
  const [root, setRoot] = useState("");
  // slurm
  const [sinfo, setSinfo] = useState<SinfoProbe | null>(null);
  const [partsOn, setPartsOn] = useState<Set<string>>(new Set());
  const [account, setAccount] = useState("");
  const [modulesInit, setModulesInit] = useState("");
  // policy
  const [maxGpus, setMaxGpus] = useState("");
  const [maxJobs, setMaxJobs] = useState("");
  const [largeDir, setLargeDir] = useState("");
  const [notes, setNotes] = useState("");
  // register
  const [regError, setRegError] = useState<Record<string, unknown> | null>(null);
  const [caps, setCaps] = useState<SiteCapabilities | null>(null);
  const [overrideInternet, setOverrideInternet] = useState(false);
  const [moduleQ, setModuleQ] = useState("");
  const [moduleA, setModuleA] = useState("");

  const order: Step[] = useMemo(() => {
    if (kind === "local") return ["kind", "connect", "policy", "register", "confirm"];
    if (kind === "ssh") return ["kind", "connect", "storage", "policy", "register", "confirm"];
    return ["kind", "connect", "storage", "slurm", "policy", "register", "confirm"];
  }, [kind]);

  useEffect(() => {
    fetch("/api/ui/ssh_config_hosts", { headers: { authorization: `Bearer ${TOKEN}` } })
      .then((r) => r.json())
      .then((r) => setHosts(r.hosts ?? []));
  }, []);

  const sshOpts = useMemo(
    () => extraOpts.split(/\s+/).filter(Boolean),
    [extraOpts],
  );
  const target = useMemo(() => {
    if (hostChoice !== "manual") {
      const h = hosts.find((x) => x.host === hostChoice);
      return { dest: h?.host ?? "", port: h?.port ? Number(h.port) : null };
    }
    return { dest, port: port ? Number(port) : null };
  }, [hostChoice, hosts, dest, port]);

  const runPreflight = async () => {
    setTesting(true);
    setPreflight(null);
    const r = await uiPost<PreflightResult>("/api/ui/preflight_ssh", {
      dest: target.dest, port: target.port, ssh_opts: sshOpts,
    });
    setPreflight(r);
    setOpenFix(0);
    setTesting(false);
  };

  const next = () => setStep(order[order.indexOf(step) + 1]);
  const back = () => setStep(order[order.indexOf(step) - 1]);

  const enterStorage = async () => {
    next();
    setMounts(null);
    const r = await uiPost<{ home: string; mounts: DfMount[] }>("/api/ui/df_probe", {
      dest: target.dest, port: target.port, ssh_opts: sshOpts,
    });
    setHome(r.home ?? "");
    setMounts(r.mounts ?? []);
    if (r.home && !root) setRoot(`${r.home}/.weft`);
  };

  const enterSlurm = async () => {
    next();
    setSinfo(null);
    const r = await uiPost<SinfoProbe & { error?: unknown }>("/api/ui/sinfo_probe", {
      dest: target.dest, port: target.port, ssh_opts: sshOpts,
    });
    setSinfo({ partitions: [], accounts: [], accounts_visible: false,
               modules_ready: false, ...(r.error ? {} : r) });
    setPartsOn(new Set((r.partitions ?? []).map((p) => p.name)));
    if (r.accounts?.length === 1) setAccount(r.accounts[0]);
  };

  const buildConfig = () => {
    const policy: Record<string, unknown> = {};
    if (maxGpus) policy.max_gpus = Number(maxGpus);
    if (maxJobs) policy.max_concurrent_jobs = Number(maxJobs);
    if (kind === "slurm" && partsOn.size && partsOn.size !== (sinfo?.partitions.length ?? 0))
      policy.partitions_allowed = [...partsOn];
    if (largeDir) policy.storage = { large: largeDir };
    if (notes.trim()) policy.notes = notes.split("\n").map((n) => n.trim()).filter(Boolean);
    const cfg: Record<string, unknown> = { root, ...(Object.keys(policy).length ? { policy } : {}) };
    if (kind !== "local") {
      const [user, host] = target.dest.includes("@")
        ? target.dest.split("@")
        : [undefined, target.dest];
      cfg.host = host;
      if (user) cfg.user = user;
      if (target.port) cfg.port = target.port;
      if (sshOpts.length) cfg.ssh_opts = sshOpts;
    }
    if (kind === "slurm" && modulesInit.trim()) cfg.modules_init = modulesInit.trim();
    if (overrideInternet) cfg.capabilities_override = { internet: true };
    return cfg;
  };

  const register = async () => {
    setStep("register");
    setRegError(null);
    setCaps(null);
    const r = await wtool<Record<string, unknown>>("register_site", {
      name: siteName, kind, config: buildConfig(), _confirm: true,
    });
    if (r.error) {
      setRegError(r);
      return;
    }
    setCaps((r.capabilities as SiteCapabilities) ?? {});
    store.refresh();
    setStep("confirm");
  };

  // bootstrap.step narration for this site, oldest first
  const narration = useMemo(
    () =>
      [...ticker]
        .filter((ev) => (ev.kind === "bootstrap.step" || ev.kind === "site.tools") && ev.site === siteName)
        .reverse(),
    [ticker, siteName],
  );

  const connectOk = kind === "local" ? root && siteName : preflight?.case === "ok" && siteName;

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <div className="wiz">
        <div className="wh">
          <h3>
            {step === "register" ? `Registering ${siteName}…`
              : step === "confirm" ? `${siteName}, as probed just now`
              : "Add compute"}
          </h3>
          <Steps order={order} current={step} />
        </div>

        {step === "kind" && (
          <div className="wb">
            <div className="kinds">
              {KINDS.map((k) => (
                <div
                  key={k.kind}
                  className={`pick${kind === k.kind ? " on" : ""}`}
                  style={k.disabled ? { opacity: 0.45, cursor: "default" } : undefined}
                  title={k.disabled}
                  onClick={() => !k.disabled && setKind(k.kind as Kind)}
                >
                  <div>
                    <h4>{k.title}</h4>
                    <p>{k.desc}{k.disabled ? ` (${k.disabled})` : ""}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {step === "connect" && (
          <div className="wb">
            {kind !== "local" ? (
              <>
                <div className="field">
                  <label>From your saved hosts</label>
                  {hosts.map((h) => (
                    <div
                      key={h.host}
                      className={`opt${hostChoice === h.host ? " on" : ""}`}
                      onClick={() => setHostChoice(h.host)}
                    >
                      <span className="radio" />
                      <div className="grow">
                        <b className="mono" style={{ fontSize: 12.5 }}>{h.host}</b>{" "}
                        <span className="dim small">
                          → {h.user ? `${h.user}@` : ""}{h.hostname ?? h.host}
                          {h.port ? `:${h.port}` : ""}
                        </span>
                        {h.jump && <div className="small faint">via jump host {h.jump}</div>}
                      </div>
                      <span className="chip quiet">saved host</span>
                    </div>
                  ))}
                  <div
                    className={`opt${hostChoice === "manual" ? " on" : ""}`}
                    onClick={() => setHostChoice("manual")}
                  >
                    <span className="radio" />
                    <div className="grow row" style={{ gap: 6 }}>
                      <input
                        className="input mono"
                        style={{ maxWidth: 260 }}
                        placeholder="user@host"
                        value={dest}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setDest(e.target.value)}
                      />
                      <input
                        className="input mono"
                        style={{ maxWidth: 90 }}
                        placeholder="port"
                        value={port}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setPort(e.target.value)}
                      />
                    </div>
                    <span className="chip quiet">free text</span>
                  </div>
                  <div className="help">
                    weft connects the way your own tools already do — your ssh config,
                    keys, and jump hosts keep working here, unchanged.
                  </div>
                </div>
                <details>
                  <summary className="small dim" style={{ cursor: "pointer" }}>
                    advanced ssh options (key file, host-key mode …)
                  </summary>
                  <input
                    className="input mono"
                    style={{ marginTop: 6 }}
                    placeholder="-i /path/to/key -o StrictHostKeyChecking=no"
                    value={extraOpts}
                    onChange={(e) => setExtraOpts(e.target.value)}
                  />
                </details>
                {preflight && preflight.case !== "ok" && (
                  <>
                    <div className="banner warn" style={{ border: "1px solid #e7dcc0", borderRadius: 6, margin: "12px 0" }}>
                      <b>Couldn’t reach {target.dest} yet</b>&nbsp;— let’s fix that.
                    </div>
                    <div className="field">
                      <label>What to try, most likely first</label>
                      {(preflight.fixes ?? []).map((f, i) => (
                        <div key={f.case} className={`fix${openFix === i ? " open" : ""}`}>
                          <div className="fh" onClick={() => setOpenFix(i)}>
                            <span className="tag">{i === 0 ? "MOST LIKELY" : ""}</span>
                            <b>{f.headline}</b>
                          </div>
                          {openFix === i && (
                            <div className="fb">
                              <p className="small dim" style={{ marginBottom: 8 }}>{f.explain}</p>
                              {f.commands.length > 0 && (
                                <div className="log">
                                  {"# run in a terminal on this machine — weft never sees your sign-in\n"}
                                  {f.commands.join("\n")}
                                </div>
                              )}
                              {f.case === "unknown" && preflight.stderr && (
                                <div className="log" style={{ marginTop: 6 }}>{preflight.stderr}</div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {preflight?.case === "ok" && (
                  <div className="small" style={{ color: "var(--ok)", margin: "10px 0" }}>
                    ✓ connected — {target.dest}
                    {target.port ? `:${target.port}` : ""} answers
                  </div>
                )}
              </>
            ) : (
              <div className="field">
                <label>Directory for this site’s work</label>
                <input
                  className="input mono"
                  style={{ maxWidth: 360 }}
                  placeholder="/tmp/weft-site"
                  value={root}
                  onChange={(e) => setRoot(e.target.value)}
                />
              </div>
            )}
            <div className="field">
              <label>Site name in this workspace</label>
              <input
                className="input mono"
                style={{ maxWidth: 220 }}
                placeholder={kind === "slurm" ? "hpc" : kind === "ssh" ? "wkst2" : "local2"}
                value={siteName}
                onChange={(e) => setSiteName(e.target.value.trim())}
              />
            </div>
          </div>
        )}

        {step === "storage" && (
          <div className="wb">
            <div className="field">
              <label>
                Filesystems seen on {target.dest} <Api>df probe</Api>
              </label>
              {mounts == null && <span className="dim small">probing…</span>}
              {mounts?.map((m) => {
                const usedPct = 100 - (100 * m.free_gb) / Math.max(m.total_gb, 1);
                const isHomeMount = home.startsWith(m.mount) && m.mount !== "/";
                const chosen = root.startsWith(m.mount === "/" ? "//" : m.mount);
                return (
                  <div
                    key={m.mount}
                    className={`opt${chosen ? " on" : ""}`}
                    onClick={() => setRoot(`${m.mount === "/" ? home : m.mount + home.replace(/^.*\//, "/")}/.weft`.replace("//", "/"))}
                  >
                    <span className="radio" />
                    <div className="grow quota" style={{ gridTemplateColumns: "140px 1fr max-content" }}>
                      <span className="mono">{m.mount}</span>
                      <span className="track">
                        <b className={usedPct > 75 ? "hot" : ""} style={{ width: `${usedPct}%` }} />
                      </span>
                      <span className="num dim">
                        {m.free_gb} GB free of {m.total_gb}
                      </span>
                    </div>
                    {isHomeMount && <span className="chip quiet">home</span>}
                  </div>
                );
              })}
              <div className="help">
                Pick scratch over a quota’d home where you can: environments and staged
                data are rebuildable by design. Anything precious belongs in a declared
                large-files role, set under Policy.
              </div>
            </div>
            <div className="field">
              <label>weft root</label>
              <input
                className="input mono"
                style={{ maxWidth: 360 }}
                value={root}
                onChange={(e) => setRoot(e.target.value)}
              />
            </div>
          </div>
        )}

        {step === "slurm" && (
          <div className="wb">
            <div className="field">
              <label>
                Partitions you’ll use{" "}
                <span className="dim" style={{ fontWeight: 400 }}>
                  (from <span className="mono">sinfo</span> just now)
                </span>
              </label>
              {sinfo == null && <span className="dim small">asking the scheduler…</span>}
              {sinfo && !sinfo.partitions?.length && (
                <div className="small" style={{ color: "var(--queued)" }}>
                  sinfo answered with no partitions — check the connection, or continue
                  and let registration probe the scheduler itself
                </div>
              )}
              {sinfo?.partitions?.map((p) => (
                <label className="check" key={p.name}>
                  <input
                    type="checkbox"
                    checked={partsOn.has(p.name)}
                    onChange={(e) => {
                      const s = new Set(partsOn);
                      e.target.checked ? s.add(p.name) : s.delete(p.name);
                      setPartsOn(s);
                    }}
                  />{" "}
                  <b>{p.name}</b>{" "}
                  <span className="dim">
                    — {p.nodes} node{p.nodes === 1 ? "" : "s"} · {p.cpus_per_node}c ·{" "}
                    {p.max_walltime} max{p.gres ? ` · ${p.gres}` : ""}
                    {p.default ? " · default" : ""}
                  </span>
                </label>
              ))}
            </div>
            <div className="field">
              <label>Account</label>
              <input
                className="input mono"
                style={{ maxWidth: 260 }}
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder={sinfo?.accounts_visible ? "" : "not visible — optional"}
              />
              <div className="help">
                {sinfo == null
                  ? ""
                  : sinfo.accounts_visible
                    ? `Discovered from the scheduler: ${sinfo.accounts.join(", ")}`
                    : "Accounting isn’t visible on this cluster — the field stays optional, no guessing."}
              </div>
            </div>
            <div className="field">
              <label>
                Module system init{" "}
                <span className="dim" style={{ fontWeight: 400 }}>
                  (only if <span className="mono">module avail</span> isn’t ready by default)
                </span>
              </label>
              <input
                className="input mono"
                placeholder="e.g.  source /etc/profile.d/modules.sh"
                value={modulesInit}
                onChange={(e) => setModulesInit(e.target.value)}
              />
              {sinfo?.modules_ready && !modulesInit && (
                <div className="help" style={{ color: "var(--ok)" }}>
                  ✓ <span className="mono">module avail</span> works without an init line — leave empty.
                </div>
              )}
            </div>
          </div>
        )}

        {step === "policy" && (
          <div className="wb">
            <p style={{ fontSize: 13, lineHeight: 2.2, maxWidth: "64ch" }}>
              Use at most{" "}
              <input className="inline-input" size={2} value={maxGpus} placeholder="∞"
                     onChange={(e) => setMaxGpus(e.target.value)} />{" "}
              GPUs and{" "}
              <input className="inline-input" size={2} value={maxJobs} placeholder="∞"
                     onChange={(e) => setMaxJobs(e.target.value)} />{" "}
              concurrent jobs. Keep large files at{" "}
              <input className="inline-input mono" size={24} value={largeDir}
                     placeholder="(no large-files role)" onChange={(e) => setLargeDir(e.target.value)} />.
            </p>
            <div className="field">
              <label>Notes the agent will read before every submission</label>
              <textarea
                className="input"
                rows={2}
                style={{ resize: "vertical" }}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="one note per line — e.g.  prefer nights for >1h jobs"
              />
            </div>
            <p className="small dim" style={{ maxWidth: "64ch" }}>
              The numbers are <b>enforced by weft at submit time</b> — a violating ask fails
              with <span className="mono">site.capability_violation</span> before anything
              runs. The notes are <b>surfaced verbatim in every plan</b>. All optional.
            </p>
          </div>
        )}

        {step === "register" && (
          <div className="wb">
            {regError ? (
              <>
                <div className="banner err" style={{ border: "1px solid #ecc8c5", borderRadius: 6, marginBottom: 10 }}>
                  <b>{String(regError.error)}</b>&nbsp;— {String(regError.detail ?? "")}
                </div>
                {Boolean(regError.hints) && (
                  <div className="log">{JSON.stringify(regError.hints, null, 1)}</div>
                )}
              </>
            ) : (
              <>
                <ul className="probe-steps">
                  {narration.map((ev, i) => (
                    <li key={ev.seq}>
                      <span className={`st-ic ${i === narration.length - 1 ? "run" : "ok"}`}>
                        {i === narration.length - 1 ? "▸" : "✓"}
                      </span>
                      <span>
                        <b>{String(ev.step ?? ev.kind)}</b>
                        {ev.note ? <span className="dim"> — {String(ev.note)}</span> : null}
                      </span>
                    </li>
                  ))}
                  {!narration.length && (
                    <li>
                      <span className="st-ic run">▸</span>
                      <span>contacting {siteName}…</span>
                    </li>
                  )}
                </ul>
                <div className="prog thick" style={{ marginTop: 12 }}>
                  <b className="p-running" style={{ width: `${Math.min(20 + narration.length * 25, 90)}%` }} />
                </div>
                <p className="small faint" style={{ marginTop: 8 }}>
                  Registration is idempotent — re-running it later (e.g. to edit policy)
                  repeats the same quick setup and changes nothing that’s already right.{" "}
                  <Api>register_site · bootstrap.step</Api>
                </p>
              </>
            )}
          </div>
        )}

        {step === "confirm" && caps && (
          <div className="wb">
            <dl className="kv">
              <dt>machine</dt>
              <dd>{caps.arch}{caps.glibc ? ` · glibc ${caps.glibc}` : ""} · {caps.cpus} cpus · {caps.mem_gb} GB</dd>
              {caps.scheduler?.type && caps.scheduler.type !== "none" && (
                <>
                  <dt>scheduler</dt>
                  <dd>
                    {caps.scheduler.type} {caps.scheduler.version ?? ""} ·{" "}
                    {(caps.scheduler.partitions ?? []).map((p) => p.name).join(" · ") || "partitions unknown"}
                  </dd>
                </>
              )}
              <dt>GPUs</dt>
              <dd>{(caps.gpus ?? []).length ? (caps.gpus ?? []).map((g) => `${g.count ?? 1}× ${g.model}`).join(", ") : "none seen"}</dd>
              <dt>internet</dt>
              <dd>
                {caps.internet ? "yes" : <><b>no</b> — environments will arrive <b>packed</b></>}
              </dd>
              <dt>module system</dt>
              <dd>{caps.module_system ? "yes" : "no"}</dd>
              <dt>storage</dt>
              <dd>
                <span className="mono small">{caps.storage?.weft_root ?? root}</span>
                {caps.storage?.free_gb != null ? ` · ${caps.storage.free_gb} GB free` : ""}
              </dd>
            </dl>
            <hr className="hr" />
            <div className="field" style={{ margin: "8px 0" }}>
              <label>Not what you expected? Override what probing can’t see</label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={overrideInternet}
                  onChange={async (e) => {
                    setOverrideInternet(e.target.checked);
                    // re-register (idempotent) with the override patched in
                    const cfg = { ...buildConfig(), capabilities_override: e.target.checked ? { internet: true } : undefined };
                    const r = await wtool<Record<string, unknown>>("register_site", {
                      name: siteName, kind, config: cfg, _confirm: true,
                    });
                    if (!r.error) setCaps((r.capabilities as SiteCapabilities) ?? caps);
                  }}
                />{" "}
                compute nodes <i>do</i> have internet (via proxy)
                <span className="api right-al">capabilities_override</span>
              </label>
            </div>
            <div className="row" style={{ gap: 6, maxWidth: 460 }}>
              <input
                className="input mono"
                placeholder="check a module, e.g. espresso/7.2"
                style={{ flex: 1 }}
                value={moduleQ}
                onChange={(e) => setModuleQ(e.target.value)}
              />
              <button
                className="btn sm"
                disabled={!moduleQ}
                onClick={async () => {
                  setModuleA("checking…");
                  try {
                    const r = await wtool<Record<string, unknown>>("module_check", {
                      site: siteName, names: [moduleQ],
                    });
                    setModuleA(r.error ? `${r.error}: ${r.detail}` : JSON.stringify(r));
                  } catch (e) {
                    setModuleA(String(e));
                  }
                }}
              >
                Check
              </button>
              <Api>module_check</Api>
            </div>
            {moduleA && <div className="small" style={{ marginTop: 5 }}>{moduleA}</div>}
          </div>
        )}

        <div className="wf">
          {step === "kind" && (
            <>
              <button className="btn" onClick={onCancel}>Cancel</button>
              <button className="btn primary right-al" onClick={next}>Continue</button>
            </>
          )}
          {step === "connect" && (
            <>
              <button className="btn" onClick={back}>Back</button>
              {kind !== "local" && (
                <>
                  <button className="btn" disabled={!target.dest || testing} onClick={runPreflight}>
                    {testing ? "Testing…" : preflight ? "Test again" : "Test connection"}
                  </button>
                  <span className="api">quick reachability check — nothing is changed</span>
                </>
              )}
              <button
                className="btn primary right-al"
                disabled={!connectOk}
                onClick={() => (kind === "local" ? setStep("policy") : void enterStorage())}
              >
                Continue
              </button>
            </>
          )}
          {step === "storage" && (
            <>
              <button className="btn" onClick={back}>Back</button>
              <button
                className="btn primary right-al"
                disabled={!root}
                onClick={() => (kind === "slurm" ? void enterSlurm() : setStep("policy"))}
              >
                Continue
              </button>
            </>
          )}
          {step === "slurm" && (
            <>
              <button className="btn" onClick={back}>Back</button>
              <button className="btn primary right-al" onClick={() => setStep("policy")}>
                Continue
              </button>
            </>
          )}
          {step === "policy" && (
            <>
              <button className="btn" onClick={back}>Back</button>
              <button className="btn primary right-al" onClick={() => void register()}>
                Register site
              </button>
              <Api>register_site</Api>
            </>
          )}
          {step === "register" && (
            <>
              {regError ? (
                <>
                  <button className="btn" onClick={() => setStep("policy")}>Back</button>
                  <button className="btn primary right-al" onClick={() => void register()}>Try again</button>
                </>
              ) : (
                <span className="dim small">weft is getting to know the machine…</span>
              )}
            </>
          )}
          {step === "confirm" && (
            <>
              <span className="small dim">You can re-probe any time from the site page.</span>
              <button className="btn primary right-al" onClick={onDone}>
                Looks right — finish
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
