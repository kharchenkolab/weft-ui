/**
 * Ambient per-site strip (jobs + chat): the five-state load dot, name,
 * and a caps line. The dot is fed by the store's gentle site_load poller;
 * hover carries the actual numbers.
 */

import { Api, SiteDot } from "../bits";
import { orderSites, useApp } from "../state";

export function LoadStrip() {
  const { sites, siteLoads, now, clusterCaps, siteOrder } = useApp();
  if (!sites.length) return null;
  return (
    <div className="load-strip">
      {orderSites(sites, siteOrder).map((s) => {
        // scheduler sites: cluster totals, not the login node's own specs
        const cluster = clusterCaps.get(s.name);
        const sub = cluster
          ? [
              `${cluster.nodes.toLocaleString()}n`,
              cluster.cores ? `${cluster.cores.toLocaleString()}c` : null,
              cluster.gpus ? `${cluster.gpus.toLocaleString()} gpu` : null,
              s.scheduler,
            ]
              .filter(Boolean)
              .join(" · ")
          : [
              s.cpus ? `${s.cpus}c` : null,
              s.mem_gb ? `${s.mem_gb}G` : null,
              s.gpus ? `${s.gpus} gpu` : null,
              s.scheduler && s.scheduler !== "none" ? s.scheduler : null,
            ]
              .filter(Boolean)
              .join(" · ") || s.kind;
        return (
          <span className="site-mini" key={s.name}>
            <SiteDot name={s.name} health={s.health} sample={siteLoads.get(s.name)} now={now} />
            <span className="nm">{s.name}</span>
            <span className="sub">{s.health !== "ok" ? s.health : sub}</span>
          </span>
        );
      })}
      <span className="right-al">
        <Api>sites_list · site_load</Api>
      </span>
    </div>
  );
}
