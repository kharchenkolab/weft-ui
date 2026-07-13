"""Gate v2 — the PreToolUse perimeter (pure logic, no SDK imports).

Why a hook and not can_use_tool: built-in tools (Bash included) are
auto-approved BEFORE the permission callback is consulted, and external
MCP tools break the callback's control round-trip entirely ("Tool
permission request failed: Stream closed", SDK 0.2.116). The PreToolUse
hook is the only interception point that observes EVERY tool call —
built-ins, external MCP, in-process MCP — and cannot be shadowed by
settings allow-rules (verified empirically, session experiments E1-E11).

Decisions here are a pure function of (tool name, input, workspace,
allowed servers); the session wraps them with the approval-future flow.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

# read-only harness tools the panel needs to function
_ALWAYS_ALLOWED = {
    "ToolSearch",   # loads deferred MCP tool schemas
    "Skill",        # injects a skill's instructions (no side effects)
    "TodoWrite",    # harness-internal bookkeeping
}

# read-only file tools, allowed only inside the workspace
_SCOPED_READERS = {"Read": "file_path", "Glob": "path", "Grep": "path"}

# subagents break the SDK control channel for gating (hook/permission
# round-trips inside a subagent die with "Stream closed") — and a
# single-agent transcript is the honest one anyway
_NO_SUBAGENTS = {"Agent", "Task"}


@dataclass
class Decision:
    verdict: str          # "allow" | "deny" | "gate-weft" | "gate-foreign"
    reason: str = ""
    server: str = ""      # for gate-foreign: the MCP server name


def classify(tool_name: str, tool_input: dict, *, workspace: Path,
             weft_server: str, allowed_servers: set[str]) -> Decision:
    """Perimeter decision for one tool call."""
    if tool_name in _ALWAYS_ALLOWED:
        return Decision("allow", "read-only harness tool")

    if tool_name in _SCOPED_READERS:
        raw = str(tool_input.get(_SCOPED_READERS[tool_name]) or "")
        if not raw:
            return Decision("allow", "read within the workspace")
        try:
            target = Path(raw)
            if not target.is_absolute():
                target = workspace / target
            target.resolve().relative_to(workspace.resolve())
            return Decision("allow", "read within the workspace")
        except ValueError:
            return Decision(
                "deny",
                f"{tool_name} outside the workspace is disabled in this "
                f"panel — it reads only {workspace}")

    if tool_name in _NO_SUBAGENTS:
        return Decision(
            "deny",
            "subagents are disabled in this panel (the consent gate cannot "
            "follow tool calls into them) — do the work in this conversation")

    # server names may carry single underscores or hyphens; the tool
    # boundary is the next DOUBLE underscore
    m = re.match(r"^mcp__([^_][\w-]*?)__", tool_name)
    if m:
        server = m.group(1)
        if server == weft_server:
            # weft tools carry the tiered consent gate — handled by
            # can_use_tool (the proven in-process path); no opinion here
            return Decision("gate-weft")
        if server in allowed_servers:
            return Decision("allow", f"MCP server '{server}' approved")
        return Decision("gate-foreign", server=server)

    return Decision(
        "deny",
        f"built-in tool {tool_name} is disabled in this panel — the agent "
        "drives the workspace through weft tools (plus workspace-scoped "
        "reads and configured MCP servers)")


# ---- workspace capability discovery (skills, .mcp.json) ----------------------


def discover_skills(workspace: Path) -> list[dict]:
    """Skills in <workspace>/.claude/skills/*/SKILL.md — name + description
    from frontmatter (line-based parse; a malformed file surfaces as a
    skill with an error note, never a crash)."""
    out = []
    root = workspace / ".claude" / "skills"
    if not root.is_dir():
        return out
    for skill_md in sorted(root.glob("*/SKILL.md")):
        name, desc = skill_md.parent.name, ""
        try:
            for line in skill_md.read_text().splitlines()[:15]:
                if line.startswith("name:"):
                    name = line.split(":", 1)[1].strip()
                elif line.startswith("description:"):
                    desc = line.split(":", 1)[1].strip()
        except OSError as e:
            desc = f"(unreadable: {e})"
        out.append({"name": name, "description": desc})
    return out


def parse_mcp_json(workspace: Path) -> tuple[dict[str, dict], str | None]:
    """<workspace>/.mcp.json → (servers dict, error). Standard Claude Code
    format: {"mcpServers": {name: {command|url, ...}}}. Malformed files
    surface as an error string, never a crash."""
    path = workspace / ".mcp.json"
    if not path.exists():
        return {}, None
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        return {}, f".mcp.json unreadable: {e}"
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        return {}, ".mcp.json has no mcpServers object"
    return {str(k): v for k, v in servers.items() if isinstance(v, dict)}, None
