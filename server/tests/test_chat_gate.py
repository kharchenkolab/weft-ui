"""Gate v2 unit tests: the PreToolUse perimeter's pure logic, workspace
capability discovery, config persistence, and the setup endpoint.

The SDK-side behavior these encode was established empirically (session
experiments E1–E11): built-ins never reach can_use_tool; external MCP
permission round-trips are broken; the PreToolUse hook sees everything.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from weft_ui.chat.gate import Decision, classify, discover_skills, parse_mcp_json
from weft_ui.config import UIConfig

WEFT = "weft"


def d(tool, tool_input=None, *, ws, allowed=frozenset()) -> Decision:
    return classify(tool, tool_input or {}, workspace=ws,
                    weft_server=WEFT, allowed_servers=set(allowed))


class TestPerimeter:
    def test_harness_tools_allowed(self, tmp_path):
        for tool in ("ToolSearch", "Skill", "TodoWrite"):
            assert d(tool, ws=tmp_path).verdict == "allow"

    def test_builtins_denied_with_reason(self, tmp_path):
        for tool in ("Bash", "Write", "Edit", "WebFetch", "WebSearch",
                     "NotebookEdit", "KillShell"):
            dec = d(tool, ws=tmp_path)
            assert dec.verdict == "deny", tool
            assert "disabled in this panel" in dec.reason

    def test_subagents_denied(self, tmp_path):
        for tool in ("Agent", "Task"):
            dec = d(tool, ws=tmp_path)
            assert dec.verdict == "deny"
            assert "subagent" in dec.reason

    def test_read_inside_workspace_allowed(self, tmp_path):
        assert d("Read", {"file_path": str(tmp_path / "code/qc.py")},
                 ws=tmp_path).verdict == "allow"
        # relative resolves against the workspace
        assert d("Read", {"file_path": "results/x.txt"},
                 ws=tmp_path).verdict == "allow"
        # no path (Grep/Glob default to cwd = workspace)
        assert d("Grep", {"pattern": "phonon"}, ws=tmp_path).verdict == "allow"

    def test_read_outside_workspace_denied(self, tmp_path):
        for path in ("/etc/passwd", str(tmp_path.parent / "other"),
                     str(tmp_path / ".." / "escape")):
            dec = d("Read", {"file_path": path}, ws=tmp_path)
            assert dec.verdict == "deny", path
            assert "outside the workspace" in dec.reason

    def test_weft_tools_fall_through(self, tmp_path):
        assert d(f"mcp__{WEFT}__task_submit", ws=tmp_path).verdict == "gate-weft"
        assert d(f"mcp__{WEFT}__jobs_where", ws=tmp_path).verdict == "gate-weft"

    def test_foreign_server_gated_then_allowed(self, tmp_path):
        dec = d("mcp__probe__probe_echo", ws=tmp_path)
        assert dec.verdict == "gate-foreign" and dec.server == "probe"
        assert d("mcp__probe__probe_echo", ws=tmp_path,
                 allowed={"probe"}).verdict == "allow"

    def test_server_names_with_separators(self, tmp_path):
        dec = d("mcp__unit_oracle__lookup", ws=tmp_path)
        assert dec.verdict == "gate-foreign" and dec.server == "unit_oracle"
        dec = d("mcp__unit-oracle__lookup", ws=tmp_path)
        assert dec.verdict == "gate-foreign" and dec.server == "unit-oracle"

    def test_unknown_tool_denied(self, tmp_path):
        assert d("SomeFutureTool", ws=tmp_path).verdict == "deny"


class TestDiscovery:
    def test_skills(self, tmp_path):
        sk = tmp_path / ".claude" / "skills" / "phonon-conventions"
        sk.mkdir(parents=True)
        (sk / "SKILL.md").write_text(
            "---\nname: phonon-conventions\n"
            "description: Unit conventions for phonon work.\n---\nBody.\n")
        found = discover_skills(tmp_path)
        assert found == [{"name": "phonon-conventions",
                          "description": "Unit conventions for phonon work."}]

    def test_skills_absent(self, tmp_path):
        assert discover_skills(tmp_path) == []

    def test_mcp_json(self, tmp_path):
        (tmp_path / ".mcp.json").write_text(json.dumps(
            {"mcpServers": {"probe": {"command": "python",
                                      "args": ["srv.py"]}}}))
        servers, err = parse_mcp_json(tmp_path)
        assert err is None and list(servers) == ["probe"]

    def test_mcp_json_malformed_surfaces_not_crashes(self, tmp_path):
        (tmp_path / ".mcp.json").write_text("{nope")
        servers, err = parse_mcp_json(tmp_path)
        assert servers == {} and "unreadable" in err

    def test_mcp_json_absent(self, tmp_path):
        assert parse_mcp_json(tmp_path) == ({}, None)


class TestConfig:
    def test_allowed_servers_roundtrip(self, tmp_path):
        cfg = UIConfig()
        cfg.chat_allowed_mcp_servers.append("probe")
        cfg.save(tmp_path)
        again = UIConfig.load(tmp_path)
        assert again.chat_allowed_mcp_servers == ["probe"]
        assert again.chat_setting_sources == ["project"]


@pytest.fixture()
def setup_client(tmp_path):
    from weft_ui.chat.router import ChatManager, build_router
    (tmp_path / ".mcp.json").write_text(json.dumps(
        {"mcpServers": {"probe": {"command": "python", "args": ["s.py"]}}}))
    sk = tmp_path / ".claude" / "skills" / "beamline-notes"
    sk.mkdir(parents=True)
    (sk / "SKILL.md").write_text("---\nname: beamline-notes\n"
                                 "description: Beamline metadata.\n---\n")
    cfg = UIConfig()
    cfg.chat_allowed_mcp_servers.append("probe")
    app = FastAPI()
    app.include_router(build_router(ChatManager(None, tmp_path, cfg)))
    return TestClient(app)


def test_setup_endpoint(setup_client):
    r = setup_client.get("/api/chat/setup")
    assert r.status_code == 200
    body = r.json()
    names = [s["name"] for s in body["skills"]]
    assert names[0] == "weft" and "beamline-notes" in names
    servers = {s["name"]: s for s in body["mcp_servers"]}
    assert servers["weft"]["transport"] == "in-process"
    assert servers["probe"]["consent"] == "allowed durably"
    assert body["setting_sources"] == ["project"]
    assert isinstance(body["workspace_trusted"], bool)


def test_fmt_size_humane():
    from weft_ui.chat.session import _fmt_size
    assert _fmt_size(6.0) == "6.0 GB"
    assert _fmt_size(0.5) == "512 MB"
    assert _fmt_size(682 / 1024 ** 3) == "682 B"     # tiny stagings stay honest
    assert _fmt_size(1e-07) == "107 B"               # demo threshold, not "0.0 GB"
