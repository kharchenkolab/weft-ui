"""R1: embedding — frame-ancestors CSP + embed_origins allowlist."""

import json

from fastapi.testclient import TestClient

from weft_ui.main import create_app

AUTH = {"authorization": "Bearer t-embed"}


def test_frame_ancestors_default_self(client):
    r = client.get("/")
    assert r.headers.get("content-security-policy") == "frame-ancestors 'self'"


def test_embed_origins_frame_and_api(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / ".weft-ui.json").write_text(
        json.dumps({"embed_origins": ["http://localhost:7777"]}))
    app = create_app(ws, token="t-embed")
    with TestClient(app) as c:
        # the host origin may frame the UI…
        csp = c.get("/", headers=AUTH).headers["content-security-policy"]
        assert csp == "frame-ancestors 'self' http://localhost:7777"
        # …and call /api from its pages
        ok = c.get("/api/ping", headers={**AUTH, "origin": "http://localhost:7777"})
        assert ok.status_code == 200
        # anything unconfigured keeps getting rejected
        bad = c.get("/api/ping", headers={**AUTH, "origin": "http://localhost:9999"})
        assert bad.status_code == 403


def test_attach_in_process_mount(tmp_path):
    """docs/embedding.md option A: one host process, same-origin panels."""
    from fastapi import FastAPI

    from weft_ui.embed import attach
    from weft_ui.main import WEB_DIST

    host = FastAPI()
    attach(host, path="/weft/a", workspace=tmp_path / "wsA", token="tA")
    attach(host, path="/weft/b", workspace=tmp_path / "wsB", token="tB")
    with TestClient(host) as c:
        # both mounts serve the SPA with mount-relative asset refs
        for mount in ("/weft/a", "/weft/b"):
            page = c.get(f"{mount}/")
            assert page.status_code == 200
            assert '"/assets' not in page.text and "'/assets" not in page.text, \
                "built index must reference assets relatively (vite base ./)"
        # …and both lifespans actually ran (controller answers)
        ok = c.get("/weft/a/api/ping", headers={"authorization": "Bearer tA"})
        assert ok.status_code == 200 and ok.json()["ok"]
        # auth is enforced under the mount (scope-path, not full path)
        assert c.get("/weft/a/api/ping").status_code == 401
        # tokens are per mount
        assert c.get("/weft/b/api/ping",
                     headers={"authorization": "Bearer tA"}).status_code == 401
        # same-origin Origin (the host page's) passes without any allowlist
        so = c.get("/weft/a/api/ping",
                   headers={"authorization": "Bearer tA",
                            "origin": "http://testserver"})
        assert so.status_code == 200
        # foreign Origin still rejected
        assert c.get("/weft/a/api/ping",
                     headers={"authorization": "Bearer tA",
                              "origin": "http://evil:1"}).status_code == 403
    # built js must not hard-code absolute /api/ URLs
    if WEB_DIST.exists():
        js = sorted((WEB_DIST / "assets").glob("index-*.js"))
        assert js and '"/api/' not in js[-1].read_text() \
            and "`/api/" not in js[-1].read_text(), \
            "client must build API URLs from its mount point (apiUrl)"


def test_attach_same_workspace_twice_fails(tmp_path):
    from fastapi import FastAPI

    import pytest as _pytest
    from weft_ui.embed import attach
    from weft_ui.lock import WorkspaceLocked

    host = FastAPI()
    ws = tmp_path / "ws"
    attach(host, path="/weft/x", workspace=ws, token="t1")
    attach(host, path="/weft/y", workspace=ws, token="t2")
    with _pytest.raises(WorkspaceLocked):
        with TestClient(host):
            pass


def test_env_packages_endpoint_unknown(client):
    r = client.get("/api/ui/envs/env:v1:doesnotexist/packages")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "unknown_env"
