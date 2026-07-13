/**
 * App frame: nav rail (Jobs live; Compute/Chat/Activity land in M2/M3),
 * topbar with workspace + live cursor, main page area.
 */

import { useEffect, useState } from "react";
import { TOKEN } from "./api/client";
import { ActivityPage } from "./pages/ActivityPage";
import { JobsPage } from "./pages/JobsPage";
import { store, useApp } from "./state";

type Page = "jobs" | "activity";

const RAIL: { key: string; label: string; title: string; page?: Page; icon: JSX.Element }[] = [
  { key: "chat", label: "Chat", title: "chat arrives in M3", icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M4 3.5h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9.5L5.5 17v-3.5H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z" /></svg>
  ) },
  { key: "compute", label: "Compute", title: "compute arrives in M2", icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="5" width="10" height="10" rx="1.5" /><path d="M8 5V2.5M12 5V2.5M8 17.5V15M12 17.5V15M5 8H2.5M5 12H2.5M17.5 8H15M17.5 12H15" /></svg>
  ) },
  { key: "jobs", label: "Jobs", title: "Jobs", page: "jobs", icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M7 5h10M7 10h10M7 15h6" /><circle cx="3.5" cy="5" r="1" fill="currentColor" stroke="none" /><circle cx="3.5" cy="10" r="1" fill="currentColor" stroke="none" /><circle cx="3.5" cy="15" r="1" fill="currentColor" stroke="none" /></svg>
  ) },
  { key: "activity", label: "Activity", title: "Activity (audit trail)", page: "activity", icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="2 10.5 6 10.5 8 5 12 15.5 14 10.5 18 10.5" /></svg>
  ) },
];

function Toasts() {
  const { toasts } = useApp();
  if (!toasts.length) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast t-${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function shortPath(p: string): { name: string; path: string } {
  const parts = p.split("/").filter(Boolean);
  return { name: parts[parts.length - 1] ?? p, path: p.replace(/^\/Users\/[^/]+/, "~") };
}

export default function App() {
  const { workspace, connected, cursor } = useApp();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState<Page>("jobs");

  useEffect(() => {
    store
      .start()
      .then(() => setStarted(true))
      .catch((e) => setError(String(e)));
  }, []);

  if (!TOKEN)
    return (
      <div className="token-gate">
        <b>weft-ui</b>
        <span>
          no token — open the URL the server printed (it carries <code>?token=…</code>)
        </span>
      </div>
    );
  if (error)
    return (
      <div className="token-gate">
        <b>weft-ui</b>
        <span>can’t reach the server: {error}</span>
        <span className="faint small">is `pixi run serve` up? is the token current?</span>
      </div>
    );
  if (!started) return null;

  const ws = shortPath(workspace);
  return (
    <div className="app">
      <div className="rail">
        <div className="logo" title="weft-ui">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" opacity=".45" />
            <path d="M9 3v2.5m0 3.5v3m0 3.5v3M15 3v3.5m0 3.5v2.5m0 4.5v2" />
          </svg>
        </div>
        {RAIL.map((r) => (
          <a
            key={r.key}
            className={r.page === page ? "on" : undefined}
            title={r.title}
            style={r.page ? { cursor: "pointer" } : { opacity: 0.4, cursor: "default" }}
            onClick={r.page ? () => setPage(r.page!) : undefined}
          >
            {r.icon}
            <span>{r.label}</span>
          </a>
        ))}
        <div className="spacer" />
      </div>

      <div className="topbar">
        <span className="ws">
          {ws.name} <span className="path">{ws.path}</span>
        </span>
        <span className="right">
          <span>
            <span className={`live-dot ${connected ? "" : "off"}`} />
            {connected ? "live" : "reconnecting"} · cursor <span className="mono num">{cursor}</span>
          </span>
        </span>
      </div>

      <div className="main">
        {page === "jobs" ? <JobsPage /> : <ActivityPage />}
        <Toasts />
      </div>
    </div>
  );
}
