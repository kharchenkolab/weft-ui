"""Facade contract: 1:1 passthrough, errors inside 200, transport codes only."""

from weft.api import PUBLIC_TOOLS

from .conftest import TOKEN


def test_tool_index_covers_public_tools(client):
    r = client.get("/api/w")
    assert r.status_code == 200
    names = {t["name"] for t in r.json()["tools"]}
    assert names == set(PUBLIC_TOOLS)
    # every def carries a JSON schema a cold client can render a form from
    for t in r.json()["tools"]:
        assert "inputSchema" in t and t["inputSchema"]["type"] == "object"


def test_passthrough_list(client):
    r = client.post("/api/w/sites_list", json={})
    assert r.status_code == 200
    assert r.json() == []  # fresh workspace: no sites, but a real reply


def test_weft_error_is_a_200_payload(client):
    r = client.post("/api/w/task_result", json={"job_id": "job-nope"})
    assert r.status_code == 200  # returns-never-raises crosses HTTP intact
    body = r.json()
    assert body["error"] == "task.invalid"
    assert body["stage"] == "infra"
    assert "meaning" in body and "retryable" in body


def test_unknown_tool_404(client):
    r = client.post("/api/w/definitely_not_a_tool", json={})
    assert r.status_code == 404


def test_bad_arguments_400(client):
    r = client.post("/api/w/task_result", json={"nonsense_kw": 1})
    assert r.status_code == 400
    assert "job_id" in r.json()["error"]["detail"]


def test_non_object_body_400(client):
    r = client.post("/api/w/sites_list", content=b"[1,2]")
    assert r.status_code == 400


def test_gated_tool_409_then_confirm(client):
    r = client.post("/api/w/site_teardown", json={"name": "nope"})
    assert r.status_code == 409
    assert r.json()["consent_required"]["tool"] == "site_teardown"
    # confirmed call goes through to weft, whose own error comes back as 200
    r = client.post("/api/w/site_teardown", json={"name": "nope", "_confirm": True})
    assert r.status_code == 200
    assert "error" in r.json()


def test_auth_required(client):
    r = client.post("/api/w/sites_list", json={}, headers={"authorization": ""})
    assert r.status_code == 401
    r = client.get("/api/ping", headers={"authorization": ""})
    assert r.status_code == 401
    r = client.get(f"/api/ping?token={TOKEN}", headers={"authorization": ""})
    assert r.status_code == 200


def test_foreign_origin_403(client):
    r = client.post("/api/w/sites_list", json={},
                    headers={"origin": "https://evil.example"})
    assert r.status_code == 403


def test_decycle_breaks_reference_cycles():
    """weft 69b22be ships a cyclic error envelope on failing env-target
    ensure_available (hints.attempts[0].error.hints IS the outer hints —
    round-25 report). The facade must degrade it to a marker, not 500,
    and must NOT touch legitimate shared-sibling (DAG) references."""
    from weft_ui.facade import decycle
    import json

    # the exact live shape: the attempt's error is a DISTINCT dict that
    # shares the outer hints object — the cycle closes one level down
    hints = {"lanes": ["extends_env"]}
    inner = {"error": "env.layer_conflict", "detail": "does not fit",
             "hints": hints}
    outer = {"error": "env.layer_conflict", "hints": hints}
    hints["attempts"] = [{"lane": "extends_env", "outcome": "failed",
                          "error": inner}]
    out = decycle(outer)
    flat = json.dumps(out)  # must not raise
    assert "circular ref" in flat
    assert out["error"] == "env.layer_conflict"
    # the typed refusal one level down survives verbatim; only the
    # back-reference collapses to the marker
    kept = out["hints"]["attempts"][0]["error"]
    assert kept["error"] == "env.layer_conflict" and kept["detail"]
    assert isinstance(kept["hints"], str)

    # a shared sibling is NOT a cycle — both copies survive as data
    shared = {"x": 1}
    ok = decycle({"a": shared, "b": shared})
    assert ok == {"a": {"x": 1}, "b": {"x": 1}}
    json.dumps(ok)
