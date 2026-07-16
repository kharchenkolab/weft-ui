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
