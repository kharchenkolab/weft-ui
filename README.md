# weft-ui

Reference UI implementation for driving [weft](../weft) — the execution
substrate for agent-driven scientific analysis. Three surfaces over one
local server that embeds a single `Weft` controller per workspace:

1. **Chat** — a generic agent panel (Claude Agent SDK) whose weft-specific
   tool renderers show plans, structured errors, and event digests.
2. **Compute** — site setup wizard (probe-first, ~/.ssh/config-aware) and
   live capability/load/footprint status per site.
3. **Jobs** — monitor/controller for tasks, arrays, kernels, and services:
   live logs, structured failures with one-click remediation, provenance.

Design principle (from weft): the user and the agent are peers — every
button is an API call the agent could also make, and both land in the same
audit trail.

Status: proposal stage. Working notes live in `misc/` (untracked).
