"""UI-only endpoints: the browser-friendly faces over tool seams.

run_file preview: decoded bytes + sniffed content type so <img>/<pre>
render directly; the X-Weft-* headers carry what the UI captions.
"""

import time


def _seed_job(client, tmp_path):
    r = client.post("/api/w/register_site", json={
        "name": "wkst", "kind": "local",
        "config": {"root": str(tmp_path / "site")}, "_confirm": True})
    assert r.status_code == 200 and "error" not in r.json(), r.text
    sub = client.post("/api/w/task_submit", json={"task": {
        "command": "mkdir -p results && printf 'phonon fit: chi2=1.02\\n' "
                   "> results/fit.txt && printf '\\x89PNG-not-really' "
                   "> results/fit.png",
        "outputs": ["results/"], "site": "wkst", "label": "phonon fit demo",
    }}).json()
    assert "job_id" in sub, sub
    job = sub["job_id"]
    for _ in range(120):
        rows = client.post("/api/w/task_status", json={"job_id": job}).json()
        if rows and rows[0]["state"] in ("DONE", "FAILED", "CANCELLED"):
            assert rows[0]["state"] == "DONE", rows[0]
            return job
        time.sleep(0.25)
    raise AssertionError("job never settled")


def test_run_file_preview(client, tmp_path):
    job = _seed_job(client, tmp_path)

    r = client.get(f"/api/ui/runs/{job}/file", params={"rel": "results/fit.txt"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/plain")
    assert "chi2=1.02" in r.text
    assert r.headers["X-Weft-Truncated"] == "0"
    assert r.headers["X-Weft-At"]  # sandbox or keep — named, not guessed

    r = client.get(f"/api/ui/runs/{job}/file", params={"rel": "results/fit.png"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"

    r = client.get(f"/api/ui/runs/{job}/file",
                   params={"rel": "results/fit.txt", "max_bytes": 5})
    assert r.status_code == 200
    assert len(r.content) == 5 and r.headers["X-Weft-Truncated"] == "1"

    # offset paging (run_file_read_range behind the same face): the
    # "Show more" pager reads byte slices; eof flips on the last one
    r = client.get(f"/api/ui/runs/{job}/file",
                   params={"rel": "results/fit.txt", "offset": 7,
                           "max_bytes": 4})
    assert r.status_code == 200 and r.content == b"fit:"
    assert r.headers["X-Weft-Eof"] == "0"
    assert int(r.headers["X-Weft-Total-Bytes"]) == 22

    r = client.get(f"/api/ui/runs/{job}/file",
                   params={"rel": "results/fit.txt", "offset": 7,
                           "max_bytes": 4096})
    assert r.content == b"fit: chi2=1.02\n"
    assert r.headers["X-Weft-Eof"] == "1"

    # past-EOF is not an error: empty + eof (the pager just stops)
    r = client.get(f"/api/ui/runs/{job}/file",
                   params={"rel": "results/fit.txt", "offset": 9999})
    assert r.status_code == 200 and r.content == b""
    assert r.headers["X-Weft-Eof"] == "1"

    r = client.get(f"/api/ui/runs/{job}/file", params={"rel": "results/nope"})
    assert r.status_code == 404
    assert r.json()["error"]["code"]

    # the preview endpoint sits behind the same bearer wall as everything
    r = client.get(f"/api/ui/runs/{job}/file", params={"rel": "results/fit.txt"},
                   headers={"authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_data_listing(client, tmp_path):
    """/api/ui/data: every dataref + its locations (the Data tab's list)."""
    (tmp_path / "ws" / "det.csv").write_text("t,adc\n0,112\n1,98\n")
    reg = client.post("/api/w/data_register", json={"path": "det.csv"}).json()
    assert reg.get("ref", "").startswith("dref:"), reg

    listing = client.get("/api/ui/data").json()
    assert listing["count"] >= 1
    row = next(d for d in listing["data"] if d["ref"] == reg["ref"])
    assert row["kind"] == "file" and row["bytes"] > 0
    assert isinstance(row["meta"], dict) and isinstance(row["locations"], list)

    assert client.get("/api/ui/data",
                      headers={"authorization": "Bearer wrong"}).status_code == 401


def test_data_file_preview(client, tmp_path):
    """/api/ui/data/{ref}/file + /members: the dataset peek —
    data_read_range behind the run peek's browser face."""
    ws = tmp_path / "ws"
    (ws / "spectrum.txt").write_text("eV,counts\n1.10,204\n1.12,371\n")
    reg = client.post("/api/w/data_register",
                      json={"path": "spectrum.txt"}).json()
    ref = reg["ref"]

    r = client.get(f"/api/ui/data/{ref}/file", params={"name": "spectrum.txt"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/plain")
    assert "1.12,371" in r.text
    assert r.headers["X-Weft-Eof"] == "1"
    assert r.headers["X-Weft-At"]  # workspace CAS or a site copy — named

    r = client.get(f"/api/ui/data/{ref}/file",
                   params={"offset": 3, "max_bytes": 6})
    assert r.content == b"counts" and r.headers["X-Weft-Eof"] == "0"

    # a file ref has no members; the 404 carries the typed code
    assert client.get(f"/api/ui/data/{ref}/members").status_code == 404

    # tree ref: members enumerate, rel= addresses one
    d = ws / "sweep"
    d.mkdir()
    (d / "a.txt").write_text("alpha\n")
    (d / "b" ).mkdir()
    (d / "b" / "c.txt").write_text("gamma gamma\n")
    tree = client.post("/api/w/data_register", json={"path": "sweep"}).json()
    tref = tree["ref"]
    m = client.get(f"/api/ui/data/{tref}/members").json()
    assert m["count"] == 2
    paths = {e["path"] for e in m["members"]}
    assert paths == {"a.txt", "b/c.txt"}
    assert all(e.get("size") is not None for e in m["members"])

    r = client.get(f"/api/ui/data/{tref}/file", params={"rel": "b/c.txt"})
    assert r.status_code == 200 and r.text == "gamma gamma\n"

    # tree without rel= refuses (typed upstream), face maps it to 404
    assert client.get(f"/api/ui/data/{tref}/file").status_code == 404
    assert client.get("/api/ui/data/dref:%s/file" % ("0" * 64)).status_code == 404
    assert client.get(f"/api/ui/data/{ref}/file",
                      headers={"authorization": "Bearer wrong"}).status_code == 401


def test_data_index(client, tmp_path):
    """/api/ui/data/index: the aggregated Data page — datasets + keeps +
    remains from the store alone, with file-deep search."""
    job1 = _seed_job(client, tmp_path)  # label "phonon fit demo"
    r = client.post("/api/w/run_retain", json={
        "target": job1, "dest": "@workspace",
        "label": "campaign-2024B", "background": False}).json()
    assert "error" not in r, r

    sub = client.post("/api/w/task_submit", json={"task": {
        "command": "mkdir -p results && echo ok > results/qc_report.txt",
        "outputs": ["results/"], "site": "wkst", "label": "qc pass",
    }}).json()
    job2 = sub["job_id"]
    for _ in range(120):
        rows = client.post("/api/w/task_status", json={"job_id": job2}).json()
        if rows and rows[0]["state"] == "DONE":
            break
        time.sleep(0.25)

    (tmp_path / "ws" / "det.csv").write_text("t,adc\n0,112\n")
    reg = client.post("/api/w/data_register", json={"path": "det.csv"}).json()

    idx = client.get("/api/ui/data/index").json()
    counts = idx["counts"]
    assert counts["dataset"] >= 1 and counts["keep"] == 1, counts
    assert counts["remains"] >= 1 and counts["local"] >= 2, counts

    keep = next(r for r in idx["rows"] if r["tier"] == "keep")
    assert keep["id"] == job1 and keep["campaign"] == "campaign-2024B"
    assert keep["local"] is True and keep["placement"] == "shipped home"
    assert keep["name"] == "phonon fit demo"
    # the keep row speaks for job1 — no remains double-entry
    assert not any(r["tier"] == "remains" and r["id"] == job1
                   for r in idx["rows"])
    rem = next(r for r in idx["rows"]
               if r["tier"] == "remains" and r["id"] == job2)
    assert rem["name"] == "qc pass" and rem["files"] >= 1
    ds = next(r for r in idx["rows"] if r.get("ref") == reg["ref"])
    assert ds["local"] is True and ds["name"] == "det.csv"

    # file-deep search: q matches a rel INSIDE the remains inventory —
    # and inside the declared-output TREE dataset the run minted, so the
    # same file honestly surfaces once per vocabulary that records it
    hit = client.get("/api/ui/data/index", params={"q": "qc_report"}).json()
    ids = [r["id"] for r in hit["rows"]]
    assert job2 in ids, ids
    rem_hit = next(r for r in hit["rows"] if r["id"] == job2)
    assert rem_hit["hits"][0]["rel"] == "results/qc_report.txt"
    assert rem_hit["hit_total"] == 1
    # the run's anonymous output refs ROLL UP by campaign — the tree's
    # member manifest still matches, riding the rollup row
    assert any(r["tier"] in ("dataset", "outputs") and r.get("hits")
               for r in hit["rows"]), \
        "the output tree's member manifest should match too"

    only_keeps = client.get("/api/ui/data/index",
                            params={"tier": "keep"}).json()
    assert {r["tier"] for r in only_keeps["rows"]} == {"keep"}
    loc = client.get("/api/ui/data/index", params={"local": 1}).json()
    assert loc["rows"] and all(r["local"] for r in loc["rows"])
    on_site = client.get("/api/ui/data/index",
                         params={"site": "wkst"}).json()
    assert any(r["id"] == job2 for r in on_site["rows"])
    assert not any(r.get("ref") == reg["ref"] for r in on_site["rows"]), \
        "a workspace-only dataset has no wkst copy"

    assert client.get("/api/ui/data/index",
                      headers={"authorization": "Bearer wrong"}).status_code == 401


def test_download_streaming(client, tmp_path, monkeypatch):
    """?download=1 streams whole files through the controller by looping
    the ranged verbs — proven multi-chunk with a tiny chunk size."""
    import weft_ui.uiapi as uiapi
    monkeypatch.setattr(uiapi, "DOWNLOAD_CHUNK", 7)  # 22-byte file → 4 calls
    job = _seed_job(client, tmp_path)

    r = client.get(f"/api/ui/runs/{job}/file",
                   params={"rel": "results/fit.txt", "download": 1})
    assert r.status_code == 200, r.text
    assert r.content == b"phonon fit: chi2=1.02\n"
    assert 'attachment; filename="fit.txt"' in r.headers["content-disposition"]
    assert r.headers["content-length"] == "22"

    (tmp_path / "ws" / "spec.csv").write_text("eV,counts\n1.1,204\n")
    reg = client.post("/api/w/data_register", json={"path": "spec.csv"}).json()
    r = client.get(f"/api/ui/data/{reg['ref']}/file",
                   params={"download": 1, "name": "spec.csv"})
    assert r.content == b"eV,counts\n1.1,204\n"
    assert "spec.csv" in r.headers["content-disposition"]

    monkeypatch.setattr(uiapi, "DOWNLOAD_MAX", 10)
    r = client.get(f"/api/ui/runs/{job}/file",
                   params={"rel": "results/fit.txt", "download": 1})
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "download.too_big"

    r = client.get(f"/api/ui/runs/{job}/file",
                   params={"rel": "results/nope", "download": 1})
    assert r.status_code == 404


def test_footprint_scopes(client, tmp_path):
    """M11.2: one rollup shape per scope — run / campaign / site / local.
    Lines carry sizes + the substrate calls that would free them; no
    safety re-derivation (that's data_evict dry_run at confirm time)."""
    job = _seed_job(client, tmp_path)

    # retain one result home so the run has a keep; keep the sandbox too
    r = client.post("/api/w/run_retain", json={
        "target": job, "include": ["results/fit.txt"],
        "dest": "@workspace", "background": False})
    assert r.status_code == 200 and "error" not in r.json(), r.text

    fp = client.get("/api/ui/footprint", params={"scope": f"run:{job}"}).json()
    assert fp["title"] == "phonon fit demo"
    tiers = {ln["tier"]: ln for ln in fp["lines"]}
    assert tiers["keep"]["files"] == 1
    assert tiers["keep"]["placement"] == "shipped home"
    assert tiers["keep"]["action"] == {
        "tool": "run_forget", "calls": [{"target": job}]}
    assert tiers["sandbox"]["site"] == "wkst"
    assert tiers["sandbox"]["files"] >= 2  # fit.txt + fit.png recorded
    # declared outputs leave site-CAS copies → an evictable copies line
    assert tiers["copies"]["site"] == "wkst" and tiers["copies"]["count"] >= 1
    assert all(c["at"] == "wkst" for c in tiers["copies"]["action"]["calls"])
    assert tiers["records"]["bytes"] > 0
    assert fp["total_bytes"] > 0

    # campaign scope aggregates the same run under its label
    fc = client.get("/api/ui/footprint",
                    params={"scope": "campaign:phonon fit demo"}).json()
    ctiers = {ln["tier"] for ln in fc["lines"]}
    assert {"keep", "sandbox", "records"} <= ctiers
    assert any(ln["tier"] == "keep" and ln["target"] == job
               for ln in fc["lines"])

    # site scope sees the keep and the copies at wkst
    fs = client.get("/api/ui/footprint", params={"scope": "site:wkst"}).json()
    stiers = {ln["tier"] for ln in fs["lines"]}
    assert "keep" in stiers and "copies" in stiers

    # local scope: the shipped-home keep put bytes under the workspace —
    # cache/saved lines are optional (CAS fill depends on the chain),
    # but the shape must answer
    fl = client.get("/api/ui/footprint", params={"scope": "local"}).json()
    assert fl["scope"] == "local" and isinstance(fl["lines"], list)

    bad = client.get("/api/ui/footprint", params={"scope": "nope:x"})
    assert bad.status_code == 400 and bad.json()["error"] == "bad_scope"


def test_campaign_declare_attach(client):
    """M11.3b: the conversation's current campaign is manager state —
    declared via endpoint (user) or tool (agent), inherited by submits."""
    meta = client.post("/api/chat/conversations", json={}).json()
    cid = meta["id"]
    assert meta.get("campaign") is None

    r = client.post(f"/api/chat/conversations/{cid}/campaign",
                    json={"label": "anharmonic study"}).json()
    assert r["ok"] and r["campaign"] == "anharmonic study"
    rows = client.get("/api/chat/conversations").json()
    mine = next(m for m in rows if m["id"] == cid)
    assert mine["campaign"] == "anharmonic study"
    assert mine["campaigns"] == ["anharmonic study"]

    # attach to a second label, then clear — history accumulates
    client.post(f"/api/chat/conversations/{cid}/campaign",
                json={"label": "qc checks"})
    client.post(f"/api/chat/conversations/{cid}/campaign", json={"label": ""})
    mine = next(m for m in client.get("/api/chat/conversations").json()
                if m["id"] == cid)
    assert mine["campaign"] is None
    assert mine["campaigns"] == ["anharmonic study", "qc checks"]
    client.delete(f"/api/chat/conversations/{cid}")


def test_inherit_campaign_unit():
    """the open campaign's label is AUTHORITATIVE — hand labels are
    replaced (two live runs showed the agent labeling beside its own
    declaration, orphaning the work from its campaign)"""
    from weft_ui.chat.tools import _inherit_campaign as inh

    out = inh("task_submit", {"task": {"command": "true"}}, "camp-A")
    assert out["task"]["label"] == "camp-A"
    out = inh("task_submit", {"task": {"command": "x", "label": "mine"}}, "camp-A")
    assert out["task"]["label"] == "camp-A"            # replaced, not kept
    assert inh("run_retain", {"target": "jb_x", "label": "mine"},
               "camp-A")["label"] == "camp-A"
    assert inh("kernel_start", {"site": "wkst"}, "camp-A")["label"] == "camp-A"
    args = {"task": {"command": "true", "label": "mine"}}
    assert inh("task_submit", args, None) is args      # no campaign: untouched
    assert inh("data_stat", {"ref": "dref:x"}, "camp-A") == {"ref": "dref:x"}


def test_chat_housekeeping(client):
    """rename + delete: transcript goes, weft's audit trail stays."""
    m = client.post("/api/chat/conversations", json={}).json()
    cid = m["id"]
    r = client.patch(f"/api/chat/conversations/{cid}",
                     json={"title": "phonon triage"}).json()
    assert r["title"] == "phonon triage"
    assert any(c["id"] == cid
               for c in client.get("/api/chat/conversations").json())
    assert client.delete(f"/api/chat/conversations/{cid}").json()["ok"]
    assert not any(c["id"] == cid
                   for c in client.get("/api/chat/conversations").json())
    assert client.delete(f"/api/chat/conversations/{cid}").status_code == 404


def test_data_index_outputs_rollup(client, tmp_path):
    """anonymous output refs collapse into ONE row per campaign — hash
    names orient nobody; the members ride the row for the detail pane."""
    client.post("/api/w/register_site", json={
        "name": "wkst", "kind": "local",
        "config": {"root": str(tmp_path / "site")}, "_confirm": True})
    sub = client.post("/api/w/task_submit", json={"task": {
        "command": "mkdir -p a b && echo x > a/x.txt && echo y > b/y.txt",
        "outputs": ["a/", "b/"], "site": "wkst", "label": "sweep alpha",
    }}).json()
    for _ in range(120):
        rows = client.post("/api/w/task_status",
                           json={"job_id": sub["job_id"]}).json()
        if rows and rows[0]["state"] == "DONE":
            break
        time.sleep(0.25)

    idx = client.get("/api/ui/data/index").json()
    roll = [r for r in idx["rows"] if r["tier"] == "outputs"]
    assert len(roll) == 1 and roll[0]["name"] == "sweep alpha", roll
    r = roll[0]
    assert r["n_refs"] >= 2 and len(r["outputs"]) == r["n_refs"]
    assert all(k["ref"].startswith("dref:") for k in r["outputs"])
    # members carry their manifest-recorded paths — result files have
    # NAMES, the hash is identity not identity crisis
    rels = {k.get("rel") for k in r["outputs"]}
    assert rels & {"a", "b", "a/", "b/"}, rels
    # ...and those names are file-deep searchable
    byname = client.get("/api/ui/data/index", params={"q": "x.txt"}).json()
    assert any(x["tier"] in ("outputs", "dataset") for x in byname["rows"]), \
        byname["rows"]
    # no anonymous "· output" dataset rows survive alongside the rollup
    assert not any(x["tier"] == "dataset" and "· output" in x["name"]
                   for x in idx["rows"])
    # the facet chip still counts the underlying datasets honestly
    assert idx["counts"]["dataset"] >= r["n_refs"]
