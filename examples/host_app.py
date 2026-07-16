"""A minimal host app embedding weft-ui in-process (docs/embedding.md).

    pixi shell
    uvicorn examples.host_app:app --port 7900
    open http://127.0.0.1:7900/

One process, one origin: the panel iframe is same-origin, so the host
page can drive it (set its location.hash) and read it — no postMessage,
no CSP configuration, no CORS.
"""

from fastapi import FastAPI
from fastapi.responses import HTMLResponse

from weft_ui.embed import attach

TOKEN = "host-demo"
app = FastAPI(title="host-app")
attach(app, path="/weft/demo", workspace="demo/workspace", token=TOKEN)

PAGE = f"""<!doctype html><meta charset="utf-8"><title>host app</title>
<style>
 body {{ font: 14px system-ui; margin: 0; background: #1e2530; color: #dde3ea }}
 header {{ padding: 10px 16px; background: #141a22; display: flex; gap: 10px; align-items: center }}
 button {{ font: inherit; padding: 3px 10px }}
 .panel {{ margin: 14px; border: 1px solid #3a4656; border-radius: 8px; overflow: hidden }}
 iframe {{ width: 100%; height: 640px; border: 0; display: block; background: #fff }}
</style>
<header>
  <b>host app</b> — same-origin weft-ui panel (in-process mount)
  <button onclick="drive('#/jobs/kernels')">kernels</button>
  <button onclick="drive('#/jobs/envs')">envs</button>
  <button onclick="drive('#/compute')">compute</button>
  <span id="watch" style="margin-left:auto;opacity:.7"></span>
</header>
<div class="panel">
  <iframe id="p" src="/weft/demo/?token={TOKEN}&embed=1#/jobs/kernels"></iframe>
</div>
<script>
  const p = document.getElementById("p");
  function drive(h) {{ p.contentWindow.location.hash = h; }}  // same-origin superpower
  setInterval(() => {{
    try {{ document.getElementById("watch").textContent = "panel at " + p.contentWindow.location.hash; }}
    catch (e) {{ /* not loaded yet */ }}
  }}, 500);
</script>
"""


@app.get("/", response_class=HTMLResponse)
async def home():
    return PAGE
