/**
 * Ambient per-site strip (jobs + chat): the five-state load dot, name,
 * and a caps line. The dot is fed by the store's gentle site_load poller;
 * hover carries the actual numbers.
 */

import { SiteDot } from "../bits";
import { useApp } from "../state";

export function LoadStrip() {
  const { sites, siteLoads, now } = useApp();
  if (!sites.length) return null;
  return (
    <div className="load-strip">
      {sites.map((s) => (
        <span className="site-mini" key={s.name}>
          <SiteDot name={s.name} health={s.health} sample={siteLoads.get(s.name)} now={now} />
          <span className="nm">{s.name}</span>
          <span className="sub">
            {s.health !== "ok"
              ? s.health
              : [
                  s.cpus ? `${s.cpus}c` : null,
                  s.mem_gb ? `${s.mem_gb}G` : null,
                  s.gpus ? `${s.gpus} gpu` : null,
                  s.scheduler && s.scheduler !== "none" ? s.scheduler : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || s.kind}
          </span>
        </span>
      ))}
      <span className="right-al api">sites_list · site_load</span>
    </div>
  );
}
