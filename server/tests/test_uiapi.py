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

    r = client.get(f"/api/ui/runs/{job}/file", params={"rel": "results/nope"})
    assert r.status_code == 404
    assert r.json()["error"]["code"]

    # the preview endpoint sits behind the same bearer wall as everything
    r = client.get(f"/api/ui/runs/{job}/file", params={"rel": "results/fit.txt"},
                   headers={"authorization": "Bearer wrong"})
    assert r.status_code == 401
