/**
 * Inline byte peek — one preview experience for run files AND dataset
 * contents. The hook accumulates raw bytes across "Show more" pages and
 * decodes ONCE per render, so a UTF-8 sequence split at a page boundary
 * never garbles; the server names which copy served the bytes (X-Weft-At)
 * and whether the read reached the end (X-Weft-Eof — the pager's signal).
 */

import { useRef, useState } from "react";
import { Api, fmtBytes } from "../bits";

export const IMG_EXT = /\.(png|jpe?g|gif|svg|webp)$/i;
export const PEEK_MAX = 262144; // per-page preview cap; full files travel via data_fetch

export interface Peek {
  rel: string;
  kind: "img" | "text";
  text?: string;
  binary?: boolean;
  at?: string;
  total?: number;
  eof?: boolean;
  loaded?: number;
  loadingMore?: boolean;
  error?: string;
}

/** byte-accumulating peek state over any (rel, offset) → URL face */
export function usePeek(urlFor: (rel: string, offset: number, maxBytes: number) => string) {
  const [peek, setPeek] = useState<Peek | null>(null);
  const buf = useRef<Uint8Array>(new Uint8Array(0));

  const fetchSlice = async (rel: string, offset: number) => {
    const resp = await fetch(urlFor(rel, offset, PEEK_MAX));
    if (!resp.ok) {
      const body = await resp.json().catch(() => null);
      throw new Error(body?.error?.detail ?? body?.error?.code ?? `HTTP ${resp.status}`);
    }
    return {
      bytes: new Uint8Array(await resp.arrayBuffer()),
      at: resp.headers.get("X-Weft-At") ?? undefined,
      total: Number(resp.headers.get("X-Weft-Total-Bytes")) || undefined,
      eof: resp.headers.get("X-Weft-Eof") !== "0",
    };
  };

  const doPeek = async (rel: string) => {
    if (peek?.rel === rel) return setPeek(null); // toggle
    if (IMG_EXT.test(rel)) return setPeek({ rel, kind: "img" });
    buf.current = new Uint8Array(0);
    setPeek({ rel, kind: "text", text: "…" });
    try {
      const { bytes, at, total, eof } = await fetchSlice(rel, 0);
      buf.current = bytes;
      const text = new TextDecoder().decode(bytes);
      setPeek({
        rel, kind: "text", text,
        binary: text.includes("\u0000"),
        at, total, eof, loaded: bytes.byteLength,
      });
    } catch (e) {
      setPeek({ rel, kind: "text", error: e instanceof Error ? e.message : String(e) });
    }
  };

  const more = async (p: Peek) => {
    if (p.eof || p.loadingMore || p.kind !== "text") return;
    setPeek({ ...p, loadingMore: true });
    try {
      const { bytes, total, eof } = await fetchSlice(p.rel, buf.current.byteLength);
      const merged = new Uint8Array(buf.current.byteLength + bytes.byteLength);
      merged.set(buf.current);
      merged.set(bytes, buf.current.byteLength);
      buf.current = merged;
      const text = new TextDecoder().decode(merged);
      setPeek({
        ...p, text,
        binary: text.includes("\u0000"),
        total: total ?? p.total, eof,
        loaded: merged.byteLength, loadingMore: false,
      });
    } catch (e) {
      setPeek({ ...p, loadingMore: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  return { peek, setPeek, doPeek, more, close: () => setPeek(null) };
}

/** the preview card — plots render, text shows its head and pages onward;
 * a binary file is never a dead end: the actions live right in the card */
export function PeekView({
  peek,
  imgSrc,
  api,
  onClose,
  onMore,
  downloadHref,
  onLocal,
  localBusy,
  localDone,
}: {
  peek: Peek;
  imgSrc: (rel: string) => string;
  api: string;
  onClose: () => void;
  onMore: (p: Peek) => void;
  /** browser download of the whole file (streamed through the controller) */
  downloadHref?: string;
  /** register + fetch a workspace copy */
  onLocal?: () => void;
  localBusy?: boolean;
  /** a workspace copy already exists — the button says so */
  localDone?: boolean;
}) {
  return (
    <div style={{ position: "relative", border: "1px solid var(--line)", borderRadius: 6, padding: 8, margin: "2px 0 6px", background: "var(--surface2)" }}>
      <a className="peek-x" title="close preview" onClick={onClose}>×</a>
      <div className="row small" style={{ gap: 8, marginBottom: 6, paddingRight: 20, flexWrap: "wrap" }}>
        <b className="mono">{peek.rel}</b>
        {peek.at && (
          <span className="chip quiet" title="which copy served this preview — a run's sandbox or keep, the workspace CAS, or a site copy">
            {peek.at}
          </span>
        )}
        {peek.total != null && <span className="num dim">{fmtBytes(peek.total)}</span>}
        {peek.kind === "text" && !peek.eof && !peek.error && (
          <span className="dim small" title="preview pages through the file — save it locally for the whole thing">
            first {fmtBytes(peek.loaded ?? 0)} shown
          </span>
        )}
        <span className="right-al">
          <Api>{api}</Api>
        </span>
      </div>
      {peek.error ? (
        <span className="chip code">{peek.error}</span>
      ) : peek.kind === "img" ? (
        <img
          src={imgSrc(peek.rel)}
          alt={peek.rel}
          style={{ maxWidth: "100%", maxHeight: 380, borderRadius: 4 }}
        />
      ) : peek.binary ? (
        <div className="row small" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className="dim">binary file — no inline preview</span>
          {downloadHref && (
            <a className="btn sm" href={downloadHref} style={{ textDecoration: "none" }}
               title="download the whole file through the controller">
              ⇩ Download
            </a>
          )}
          {onLocal && !localDone && (
            <button className="btn sm" disabled={localBusy} onClick={onLocal}
                    title="register as a dataset and fetch a copy into the workspace">
              {localBusy ? "Saving…" : "Save"}
            </button>
          )}
          {localDone && (
            <span className="frow-saved" style={{ fontSize: 11.5 }}
                  title="a copy lives in the workspace">
              Saved ✓
            </span>
          )}
        </div>
      ) : (
        <>
          <pre className="mono small" style={{ maxHeight: 300, overflow: "auto", margin: 0, whiteSpace: "pre-wrap" }}>
            {peek.text}
          </pre>
          {!peek.eof && (
            <div className="small" style={{ marginTop: 4 }}>
              <a className="id plain" onClick={() => onMore(peek)}>
                {peek.loadingMore ? "loading…" : `Show more (next ${fmtBytes(PEEK_MAX)})`}
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}
