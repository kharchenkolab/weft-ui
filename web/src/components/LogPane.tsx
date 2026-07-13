/**
 * Live log follow (plan D3): the server polls task_logs at 1 s and
 * re-emits over SSE — the label says "live (1 s)" because that's what it
 * is. Terminal jobs get a one-shot tail through the same stream (eof).
 */

import { useEffect, useRef, useState } from "react";
import { logStreamUrl } from "../api/client";
import { Api } from "../bits";

export function LogPane({ jobId }: { jobId: string }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"live" | "eof" | "error">("live");
  const pre = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText("");
    setStatus("live");
    const es = new EventSource(logStreamUrl(jobId));
    es.onmessage = (msg) => {
      const d = JSON.parse(msg.data);
      if (d.error) {
        setText((t) => t + `\n[log unavailable: ${d.error} — ${d.detail ?? ""}]`);
        setStatus("error");
        es.close();
        return;
      }
      if (d.log) setText((t) => t + d.log);
      if (d.eof) {
        setStatus("eof");
        es.close();
      }
    };
    es.onerror = () => {
      setStatus("error");
      es.close();
    };
    return () => es.close();
  }, [jobId]);

  useEffect(() => {
    pre.current?.scrollTo({ top: pre.current.scrollHeight });
  }, [text]);

  return (
    <div>
      <div className="log-meta">
        <span>
          {status === "live" ? "log · live (1 s)" : status === "eof" ? "log · complete" : "log · stream lost"}
        </span>
        <span className="right-al">
          <Api>task_logs(follow_cursor)</Api>
        </span>
      </div>
      <div className="log follow" ref={pre}>
        {text || <span className="dim">waiting for output…</span>}
      </div>
    </div>
  );
}
