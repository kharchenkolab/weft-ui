/**
 * Minimal markdown for agent prose — the transcript's text events.
 * Hand-rolled like the rest of the kit (no runtime deps): GFM tables,
 * fenced code, flat lists, headings, bold / inline code / links. Not a
 * spec renderer — it covers what agent output actually contains, and
 * anything unrecognized falls through as literal text (never hidden).
 * Built as React elements throughout: no HTML strings, nothing to escape.
 */

import type { ReactNode } from "react";
import { Fragment } from "react";

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

/** bold / inline code / http(s) links; single-* italics deliberately
 * unsupported — agent text is full of globs and math asterisks */
function inline(text: string): ReactNode {
  const parts = text.split(INLINE);
  if (parts.length === 1) return text;
  return parts.map((p, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
    if (p.startsWith("`")) return <code className="md-c" key={i}>{p.slice(1, -1)}</code>;
    if (p.startsWith("**")) return <b key={i}>{p.slice(2, -2)}</b>;
    const m = /^\[([^\]]+)\]\((\S+)\)$/.exec(p);
    if (m)
      return (
        <a key={i} href={m[2]} target="_blank" rel="noreferrer" className="id">
          {m[1]}
        </a>
      );
    return <Fragment key={i}>{p}</Fragment>;
  });
}

const splitRow = (l: string): string[] =>
  l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** the |---|:---:| separator row that makes the line above a header */
const isSeparator = (l: string): boolean =>
  l.includes("-") &&
  /^[\s|:-]+$/.test(l) &&
  splitRow(l).every((c) => /^:?-+:?$/.test(c));

const alignOf = (sep: string): "left" | "center" | "right" =>
  sep.startsWith(":") && sep.endsWith(":") ? "center" : sep.endsWith(":") ? "right" : "left";

export function Md({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  const paragraph: string[] = [];
  const flushP = () => {
    if (!paragraph.length) return;
    blocks.push(
      <p key={key++} style={{ whiteSpace: "pre-wrap" }}>
        {inline(paragraph.join("\n"))}
      </p>,
    );
    paragraph.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code — verbatim to the closing fence (or the end mid-stream)
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      flushP();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // past the closing fence
      blocks.push(<pre className="blk-code md-pre" key={key++}>{buf.join("\n")}</pre>);
      continue;
    }

    // GFM table: a |-row whose next line is the separator
    if (line.includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      flushP();
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "")
        rows.push(splitRow(lines[i++]));
      blocks.push(
        <div className="md-tblwrap" key={key++}>
          <table className="tbl md-tbl">
            <thead>
              <tr>
                {header.map((h, c) => (
                  <th key={c} style={{ textAlign: aligns[c] ?? "left" }}>{inline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, c) => (
                    <td key={c} style={{ textAlign: aligns[c] ?? "left" }}>
                      {inline(r[c] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // heading — rendered as the app's section-header voice, never <h*>
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushP();
      blocks.push(<div className="md-h" key={key++}>{inline(h[2])}</div>);
      i++;
      continue;
    }

    // flat list (- / * / 1.) — an item owns its continuation lines
    const isUl = (l: string) => /^\s*[-*]\s+/.test(l);
    const isOl = (l: string) => /^\s*\d+[.)]\s+/.test(l);
    if (isUl(line) || isOl(line)) {
      flushP();
      const ordered = isOl(line);
      const isItem = ordered ? isOl : isUl;
      const items: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        if (isItem(lines[i]))
          items.push(lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, ""));
        else if (items.length && /^\s/.test(lines[i]))
          items[items.length - 1] += "\n" + lines[i].trim();
        else break;
        i++;
      }
      const kids = items.map((it, n) => (
        <li key={n} style={{ whiteSpace: "pre-wrap" }}>{inline(it)}</li>
      ));
      blocks.push(
        ordered
          ? <ol className="md-list" key={key++}>{kids}</ol>
          : <ul className="md-list" key={key++}>{kids}</ul>,
      );
      continue;
    }

    if (line.trim() === "") {
      flushP();
      i++;
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flushP();
  return <>{blocks}</>;
}
