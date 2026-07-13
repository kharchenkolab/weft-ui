# weft-ui mockups — phase 0

Static HTML mockups per `misc/ui_proposal.md` Pass 5. Open
[index.html](index.html) directly in a browser (no build, no server needed),
or `python3 -m http.server -d mockups` if you prefer.

Numbering follows the proposal. First wave — the decision-carrying set:

| # | file | decides |
|---|------|---------|
| 01 | `01-jobs-panel.html` | jobs table density, FAILED detail: error card + one-click remediations, load header + transfers strip, plan-echo timeline |
| 03 | `03-compute-cards.html` | site cards + detail pane: capability sheet ("what weft sees"), load/partitions, env realization matrix, footprint/GC story |
| 04 | `04-add-compute-wizard.html` | the ssh path as a conversation: probe-first flow, failure fix-ladder + embedded pty, policy-as-sentences, confirmation sheet |
| 05 | `05-chat.html` | the weft-blind panel + renderer registry: plan / approval / digest / error / manifest cards, cross-links, usage meter |

Second wave (02 array-group, 06 kernels+services, 07 provenance) follows once
this visual language settles.

Conventions used throughout:

- **`weft.css`** holds the design tokens + shared components; the eventual
  `web/` app lifts them verbatim. Light "paper" theme; logs/terminals stay dark.
- **Purple markers (①②…) and the striped top bar are mockup chrome**, not
  product UI. Each page ends with the design notes those markers reference.
- Every action button carries a `⌁ tool_name` hint — the peer principle
  ("every button is an API call the agent could also make") made literal.
- Error-class colors follow ui.md: user-code red, infra amber, policy blue.
- Reproducibility grades render as a 5-rung ladder chip — information, not
  warnings.
- All data shapes (error codes + hints, plan fields, capability records,
  event names, id formats) mirror weft @ b2400be exactly.
