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
        "outputs": ["results/"], "site": "wkst",
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
