/**
 * Provenance view (mockup 07 scope): the full "how was this produced"
 * chain for a job — grade with its honest meaning, exact env identity
 * (layers, snapshots, pinned SHAs, attested modules, adaptive steps),
 * inputs recursing into the jobs that produced them — plus a methods
 * appendix generated from the same node, ready for a paper.
 */

import { useEffect, useState } from "react";
import type {
  ProvenanceEnvironment,
  ProvenanceInput,
  ProvenanceJobNode,
} from "@shared/types";
import { wtool } from "../api/client";
import { Api, fmtBytes, GradeChip, Pill } from "../bits";
import { store } from "../state";

function EnvPanel({ env }: { env: ProvenanceEnvironment }) {
  const layers = Object.entries(env.layers ?? {});
  const post = env.post_install ?? [];
  return (
    <div className="prov-env">
      <div className="sec-h">
        Environment <span className="id plain">{env.env_id}</span>
      </div>
      {layers.length > 0 && (
        <table className="tbl parts-tbl">
          <thead>
            <tr>
              <th>ecosystem</th>
              <th className="r">packages</th>
              <th>snapshot</th>
              <th className="r">pinned SHAs</th>
            </tr>
          </thead>
          <tbody>
            {layers.map(([eco, l]) => (
              <tr key={eco}>
                <td className="mono">{eco}</td>
                <td className="r num">{l.packages}</td>
                <td className="num dim">{l.snapshot ?? "—"}</td>
                <td className="r num">{Object.keys(l.pinned_shas ?? {}).length || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(env.modules_attested?.length ?? 0) > 0 && (
        <div className="small" style={{ marginTop: 6 }}>
          <span className="dim">site-attested modules (recorded, not pinned): </span>
          {env.modules_attested!.map((m) => (
            <span className="chip quiet" key={m}>
              {m}
            </span>
          ))}
        </div>
      )}
      {post.length > 0 && (
        <div className="small" style={{ marginTop: 6 }}>
          <span className="dim">adaptive install steps (escape-hatch): </span>
          <span className="num">{post.length}</span>
        </div>
      )}
      {(env.notes?.length ?? 0) > 0 && (
        <ul className="small" style={{ marginTop: 6, paddingLeft: 16 }}>
          {env.notes!.map((n, i) => (
            <li key={i} className="dim">
              {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InputLine({ inp, depth }: { inp: ProvenanceInput; depth: number }) {
  return (
    <div className="prov-input">
      <div className="small">
        <span className="mono">{inp.mount_as}</span>
        {" ← "}
        <span className="id plain">{inp.ref}</span>
        {inp.bytes != null && <span className="num dim"> · {fmtBytes(inp.bytes)}</span>}
        {inp.origin && !inp.produced_by && <span className="dim"> · origin: {inp.origin}</span>}
      </div>
      {inp.produced_by && <ProvNode node={inp.produced_by} depth={depth + 1} />}
    </div>
  );
}

function ProvNode({ node, depth }: { node: ProvenanceJobNode; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  const comps = node.reproducibility_components ?? [];
  const inputs = node.inputs ?? [];
  if (depth > 0 && !open)
    return (
      <div className="prov-node folded" onClick={() => setOpen(true)}>
        <span className="exp">▸</span> produced by <span className="id plain">{node.job_id}</span>{" "}
        <GradeChip grade={node.reproducibility} />
        <span className="dim small mono"> {node.command?.slice(0, 60)}</span>
      </div>
    );
  return (
    <div className={depth ? "prov-node open" : "prov-root"}>
      {depth > 0 && (
        <div className="small" style={{ marginBottom: 6, cursor: "pointer" }} onClick={() => setOpen(false)}>
          <span className="exp">▾</span> produced by <span className="id plain">{node.job_id}</span>
        </div>
      )}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Pill state={node.state} />
        <span className="id plain">{node.job_id}</span>
        <span className="dim small">{node.site}</span>
        <GradeChip grade={node.reproducibility} />
      </div>
      {node.reproducibility_meaning && (
        <div className="dim small" style={{ marginTop: 4 }}>
          {node.reproducibility_meaning}
        </div>
      )}
      {node.reproducibility === "unknown" && (
        <div className="dim small" style={{ marginTop: 4 }}>
          no manifest (the job failed or is still running) — no reproducibility claim is made
        </div>
      )}
      {node.command && <pre className="blk-code" style={{ marginTop: 8 }}>{node.command}</pre>}

      {comps.length > 0 && (
        <table className="tbl parts-tbl" style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th>component</th>
              <th>grade</th>
              <th>why</th>
            </tr>
          </thead>
          <tbody>
            {comps.map((c) => (
              <tr key={c.component}>
                <td className="mono">{c.component}</td>
                <td>
                  <GradeChip grade={c.grade} />
                </td>
                <td className="dim small">{c.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {node.environment && <EnvPanel env={node.environment} />}

      {node.outputs.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="sec-h">Outputs</div>
          {node.outputs.map((o) => (
            <div className="small" key={o.ref}>
              <span className="mono">{o.path}</span> → <span className="id plain">{o.ref}</span>
            </div>
          ))}
        </div>
      )}

      {inputs.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="sec-h">Inputs</div>
          {inputs.map((inp, i) => (
            <InputLine key={i} inp={inp} depth={depth} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- methods appendix ---------------------------------------------------------

function envSentence(env: ProvenanceEnvironment | undefined): string[] {
  if (!env) return ["The task ran in a bare site environment (no weft-managed environment)."];
  const lines: string[] = [];
  const layers = Object.entries(env.layers ?? {});
  const layerBits = layers.map(([eco, l]) => {
    const shas = Object.keys(l.pinned_shas ?? {}).length;
    return `${eco}: ${l.packages} packages${l.snapshot ? ` (snapshot ${l.snapshot})` : ""}${shas ? `, ${shas} commit-pinned` : ""}`;
  });
  lines.push(`Environment \`${env.env_id}\` — ${layerBits.join("; ") || "no locked layers"}.`);
  if (env.modules_attested?.length)
    lines.push(
      `Site-attested modules (recorded but not pinned by weft): ${env.modules_attested.join(", ")}.`,
    );
  if (env.post_install?.length)
    lines.push(
      `${env.post_install.length} adaptive install step(s) ran (escape-hatch grade); their effects are not content-pinned.`,
    );
  return lines;
}

function appendixFor(node: ProvenanceJobNode, depth = 0): string {
  const pad = "  ".repeat(depth);
  const out: string[] = [];
  if (depth === 0) {
    out.push(`## Methods — computational provenance`, ``);
    out.push(`Produced by job \`${node.job_id}\` on site \`${node.site}\` (weft ${node.schema ?? "provenance:v1"}).`, ``);
  } else {
    out.push(`${pad}- Produced by job \`${node.job_id}\` on \`${node.site}\`:`);
  }
  out.push(`${pad}  Command: \`${node.command ?? "?"}\``);
  for (const l of envSentence(node.environment)) out.push(`${pad}  ${l}`);
  out.push(
    `${pad}  Reproducibility: **${node.reproducibility}**` +
      (node.reproducibility_meaning ? ` — ${node.reproducibility_meaning}` : ""),
  );
  if (node.outputs.length)
    out.push(`${pad}  Outputs: ${node.outputs.map((o) => `${o.path} (\`${o.ref}\`)`).join(", ")}`);
  const inputs = node.inputs ?? [];
  if (inputs.length) {
    out.push(`${pad}  Inputs:`);
    for (const inp of inputs) {
      out.push(
        `${pad}    - \`${inp.mount_as}\` ← \`${inp.ref}\`` +
          (inp.bytes != null ? ` (${fmtBytes(inp.bytes)})` : "") +
          (inp.origin && !inp.produced_by ? ` — origin: ${inp.origin}` : ""),
      );
      if (inp.produced_by) out.push(appendixFor(inp.produced_by, depth + 2));
    }
  }
  if (depth === 0) out.push(``, `Task hash: \`${node.task_hash}\` — the identity memoization keys on.`);
  return out.join("\n");
}

export function ProvenanceView({ target, onBack }: { target: string; onBack: () => void }) {
  const [node, setNode] = useState<ProvenanceJobNode | null>(null);
  const [showAppendix, setShowAppendix] = useState(false);

  useEffect(() => {
    setNode(null);
    setShowAppendix(false);
    void (async () => {
      const n = await wtool<ProvenanceJobNode>("provenance", { target, depth: 5 });
      setNode(n);
    })();
  }, [target]);

  const appendix = node && !node.error ? appendixFor(node) : "";

  return (
    <div className="prov-wrap">
      <div className="row" style={{ padding: "10px 2px", gap: 10 }}>
        <a className="id" onClick={onBack}>
          ◂ jobs
        </a>
        <b style={{ fontSize: 14 }}>Provenance</b>
        <span className="id plain">{target}</span>
        <span className="right-al">
          <Api>provenance(target, depth=5)</Api>
        </span>
      </div>

      {node == null ? (
        <div className="card" style={{ padding: 20 }}>
          <span className="faint small">walking the chain…</span>
        </div>
      ) : node.error ? (
        <div className="banner err">
          <b>{node.error}</b>&nbsp;— {node.detail ?? ""}
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 14 }}>
            <ProvNode node={node} depth={0} />
          </div>

          <div className="card" style={{ padding: 14, marginTop: 12 }}>
            <div className="sec-h">
              Methods appendix
              <span className="right row" style={{ gap: 6 }}>
                <button
                  className="btn sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(appendix);
                    store.toast("ok", "methods appendix copied");
                  }}
                >
                  Copy
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    const url = URL.createObjectURL(new Blob([appendix], { type: "text/markdown" }));
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `methods-${node.job_id}.md`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  Download .md
                </button>
                <a className="id plain small" onClick={() => setShowAppendix(!showAppendix)}>
                  {showAppendix ? "fold" : "preview"}
                </a>
              </span>
            </div>
            <div className="dim small">
              generated client-side from the provenance node above — same facts, paper-ready prose
            </div>
            {showAppendix && <pre className="blk-out" style={{ marginTop: 8, maxHeight: 340 }}>{appendix}</pre>}
          </div>
        </>
      )}
    </div>
  );
}
