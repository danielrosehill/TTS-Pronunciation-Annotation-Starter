"""TTS pronunciation annotation: a small FastAPI server in front of one static page (static/).

Configuration: config.json (path in CONFIG_PATH, default ./config.json), with environment overrides (see README).
Evaluations come from a registry JSONL (one evaluation per line: eval_id, title, date, manifest) or from one clip
manifest. Method "screen, then rank": annotations/<eval_id>/screen.jsonl (pass/fail per clip) and
annotations/<eval_id>/pairs.jsonl (pairwise preferences among passing clips), append-only JSON lines in a Hugging Face
dataset. LOCAL_ONLY=1 keeps them in a local folder.
"""
import json, os, re, threading, time, urllib.request
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

HERE = Path(__file__).parent
DEFAULTS = {
    "title": "TTS pronunciation annotation",
    "language": "en",
    "rtl": False,
    "font_stack": "system-ui, sans-serif",
    "fields": {"display": "text", "secondary": None, "gloss": "translation"},
    "language_pack": "en",   # languages/<code>/ipa.json (+ optional cliff notes): keypad, tooltips, IPA help drawer
    "ipa_keypad": None,      # overrides the pack's keypad when set
    # type: "scale" (1-5), "binary" (stored "yes"/"no"; `labels`, `keys`) or "choice" (`options`, `keys`)
    "axes": [
        {"key": "naturalness", "type": "scale", "label": "Naturalness", "hint": "Does it sound like a person?"},
        {"key": "pronunciation", "type": "scale", "label": "Pronunciation", "hint": "Right sounds and stress, word by word?"},
        {"key": "use", "type": "choice", "label": "Use this voice?", "options": ["Yes", "Maybe", "No"]},
    ],
    "minor_tags": ["Skipped", "Added sound", "Unnatural pause", "Accent", "Other"],
    # Screen, then rank: pass 1 screens each clip pass/fail (a fail needs a reason); pass 2 ranks the survivors pairwise.
    # `quality` adds the `axes` rows to the optional detail layer (off by default).
    "passes": {"screen": True, "rank": True, "quality": False},
    # Pass 1 judges the whole clip; a fail needs one or more of these categories (keys 1-n while failing).
    "fail_reasons": ["Mispronunciation", "Wrong emphasis (stress)", "Glitch / artefact", "Truncated / skipped words", "Wrong voice or language", "Other"],
    "other_reason": "Other",                      # needs a comment
    "tag_reasons": {"stress": "Wrong emphasis (stress)", "mispronunciation": "Mispronunciation"},  # optional detail -> category
    "rank_reject_reason": "Rejected in ranking (both bad)",
    "gender": {"label": "Voice gender", "options": {"female": "f", "male": "m", "unclear": "u"}},
    # pairing "playoff" (default): opening round, knock out any head-to-head loss, leader vs each unbeaten challenger,
    # one tie-break rematch between drawn finalists. "all": every pair of passing clips.
    "rank": {"pairing": "playoff"},
    "reference_label": "Reference (machine): check it",
    "notes_repo": None,
    "notes_private": True,
    "evals_registry": None,
    "manifest_url": None,
    "manifest_eval_id": "default",
    "manifest_title": None,
}
ENV = {"APP_TITLE": "title", "NOTES_REPO": "notes_repo", "EVALS_REGISTRY": "evals_registry", "MANIFEST_URL": "manifest_url"}


def load_config():
    cfg = dict(DEFAULTS)
    p = Path(os.environ.get("CONFIG_PATH", HERE / "config.json"))
    if p.exists():
        cfg.update(json.loads(p.read_text(encoding="utf8")))
    for env, k in ENV.items():
        if os.environ.get(env):
            cfg[k] = os.environ[env]
    if cfg.get("verdict"):  # older configs: a separate verdict becomes a choice axis
        v = cfg.pop("verdict")
        cfg["axes"] = list(cfg["axes"]) + [{"key": "verdict", "type": "choice", "label": v["label"], "options": v["options"]}]
    for a in cfg["axes"]:
        a.setdefault("type", "scale")
    return cfg


CFG = load_config()


def load_pack(code):
    d = HERE / "languages" / code
    try:
        pack = json.loads((d / "ipa.json").read_text(encoding="utf8"))
    except Exception as ex:
        print(f"language pack {code!r} unreadable: {ex}")
        return {"language": code, "name": code, "keypad": [], "symbols": [], "notes_md": None}
    known = {x["symbol"] for x in pack.get("symbols", [])}
    missing = [k for k in pack.get("keypad", []) if k not in known]
    if missing:
        print(f"language pack {code!r}: keypad symbols without an entry: {missing}")
    notes = pack.get("notes")
    pack["notes_md"] = (d / notes).read_text(encoding="utf8") if notes and (d / notes).exists() else None
    return pack


PACK = load_pack(CFG["language_pack"])
TOKEN = os.environ.get("HF_TOKEN")
LOCAL_ONLY = os.environ.get("LOCAL_ONLY") == "1" or not CFG["notes_repo"]
STORE = Path(os.environ.get("ANNOTATION_CACHE", "/tmp/annotations"))
STORE.mkdir(parents=True, exist_ok=True)
ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,80}$")

lock = threading.Lock()
_evals = {"t": 0, "v": None}
_manifests = {}
_pulled = {}  # (eval_id, kind) -> time of the last pull from the dataset
app = FastAPI()


def fetch_json_lines(url):
    headers = {"Authorization": f"Bearer {TOKEN}"} if TOKEN and "huggingface.co" in url else {}
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
        text = r.read().decode("utf8")
    return [json.loads(l) for l in text.splitlines() if l.strip()]


def evals():
    if _evals["v"] is None or time.time() - _evals["t"] > 120:
        rows = []
        if CFG["evals_registry"]:
            try:
                rows = fetch_json_lines(CFG["evals_registry"])
            except Exception as ex:
                print("registry unreadable:", ex)
        if not rows and CFG["manifest_url"]:
            rows = [{"eval_id": CFG["manifest_eval_id"], "title": CFG["manifest_title"] or CFG["title"], "manifest": CFG["manifest_url"]}]
        for r in rows:  # registries written before `manifest` was the field name
            r.setdefault("manifest", r.get("data_json"))
        _evals.update(t=time.time(), v=sorted(rows, key=lambda r: r.get("date", ""), reverse=True))
    return _evals["v"]


def find(eval_id):
    if not ID.match(eval_id):
        raise HTTPException(400, "bad eval id")
    for e in evals():
        if e["eval_id"] == eval_id:
            return e
    if eval_id.startswith("test-") and evals():  # scratch ids for testing reuse the first evaluation's clips
        return dict(evals()[0], eval_id=eval_id)
    raise HTTPException(404, "unknown evaluation")


def manifest(eval_id):
    e = find(eval_id)
    t, d = _manifests.get(eval_id, (0, None))
    if d is None or time.time() - t > 600:
        src = e["manifest"]
        if src.startswith(("http://", "https://")):
            headers = {"Authorization": f"Bearer {TOKEN}"} if TOKEN and "huggingface.co" in src else {}
            url = src + ("&" if "?" in src else "?") + "t=" + str(int(time.time()))
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
                d = json.load(r)
        else:  # a path served by this app, e.g. /static/examples/demo-manifest.json
            d = json.loads((HERE / src.lstrip("/")).read_text(encoding="utf8"))
        d.setdefault("clip_base", src.rsplit("/", 1)[0] + "/")
        _manifests[eval_id] = (time.time(), d)
    return d


# Passes and their files: annotations/<eval_id>/<kind>.jsonl, append-only.
#   screen: tts-annotation/2, one pass/fail per clip; the latest line per (run, sentence) wins.
#   pairs:  tts-pairwise/1, one line per comparison; {"type": "undo", "target": id} lines cancel one.
KINDS = {"screen": "tts-annotation/2", "pairs": "tts-pairwise/1", "voice": "tts-voice-note/1"}
# voice: spoken feedback recorded in the browser (Daniel, 2026-11-18: "record my annotation ... run those through speech
# to text ... and the AI tool could apply the annotations"). One line per note: the audio is stored beside it as
# annotations/<eval_id>/voice/<id>.<ext>; tools/apply_voice_notes.py later adds {"type": "processed", "target": id,
# "transcript": ..., "applied": {...}} lines and writes the derived screen rows (source "voice:<id>").
VOICE_ROW = ["id", "pass", "run", "run_name", "sentence", "left", "right", "blind", "mime", "seconds", "client_id"]
SCREEN_ROW = ["run", "run_name", "input", "sentence", "verdict", "fail_reasons", "word_issues", "gender", "scores", "note", "blind", "source", "client_id"]
PAIR_ROW = ["id", "type", "target", "sentence", "pair", "left", "right", "outcome", "stage", "note", "client_id"]


def kind_ok(kind):
    if kind not in KINDS:
        raise HTTPException(404, "unknown annotation kind")


def path_for(eval_id, kind, max_age=60):
    """Local copy of the annotation file, re-pulled from the dataset when older than max_age seconds (0 = always, used
    before every write, so lines added outside the Space, e.g. by tools/apply_voice_notes.py, are never overwritten)."""
    p = STORE / eval_id / f"{kind}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    k = (eval_id, kind)
    if time.time() - _pulled.get(k, 0) > max_age:
        if not LOCAL_ONLY:
            from huggingface_hub import hf_hub_download
            try:
                src = hf_hub_download(CFG["notes_repo"], f"annotations/{eval_id}/{kind}.jsonl", repo_type="dataset", token=TOKEN, force_download=True)
                p.write_text(Path(src).read_text(encoding="utf8"), encoding="utf8")
            except Exception:
                pass
        _pulled[k] = time.time()
    if not p.exists():
        p.write_text("", encoding="utf8")
    return p


def rows(eval_id, kind):
    out = [json.loads(l) for l in path_for(eval_id, kind).read_text(encoding="utf8").splitlines() if l.strip()]
    if kind == "screen":
        latest = {}
        for n in out:
            latest[(n["run"], n["sentence"])] = n
        return list(latest.values())
    return out


@app.get("/api/config")
def get_config():
    return {k: v for k, v in CFG.items() if k not in ("notes_repo", "evals_registry", "manifest_url")} | {"local_only": LOCAL_ONLY}


@app.get("/api/language")
def get_language():
    return dict(PACK, keypad=CFG["ipa_keypad"] or PACK.get("keypad", []))


@app.get("/api/evals")
def get_evals():
    rows = []
    for e in evals():
        r = {k: e.get(k) for k in ("eval_id", "title", "date", "task", "n_models", "n_runs")}
        try:
            d = manifest(e["eval_id"])
            r["n_clips"] = sum(len(m["clips"]) for m in d["models"])
            r["n_rated"] = sum(1 for n in rows(e["eval_id"], "screen") if n["sentence"] != "overall")
            r["n_pairs"] = sum(1 for n in rows(e["eval_id"], "pairs") if n.get("type") != "undo")
        except Exception as ex:
            r["error"] = str(ex)[:200]
        rows.append(r)
    return rows


@app.get("/api/eval/{eval_id}")
def get_eval(eval_id: str):
    return manifest(eval_id)


@app.get("/api/annotations/{eval_id}/{kind}")
def get_annotations(eval_id: str, kind: str):
    find(eval_id); kind_ok(kind)
    with lock:
        return rows(eval_id, kind)


@app.post("/api/annotations/{eval_id}/{kind}")
async def post_annotation(eval_id: str, kind: str, request: Request):
    find(eval_id); kind_ok(kind)
    if kind == "voice":
        raise HTTPException(400, "voice notes go to /api/voice/{eval_id}")
    body = await request.json()
    if kind == "screen":
        if not body.get("run") or not body.get("sentence") or body.get("verdict") not in ("pass", "fail"):
            raise HTTPException(400, "run, sentence and verdict (pass|fail) are required")
        if body["verdict"] == "fail" and not body.get("fail_reasons"):
            raise HTTPException(400, "a fail needs at least one fail_reasons category")
        row = {k: body.get(k) for k in SCREEN_ROW}
    else:
        if body.get("type") != "undo" and (not body.get("sentence") or body.get("outcome") not in ("left", "right", "tie", "both_bad")):
            raise HTTPException(400, "sentence and outcome (left|right|tie|both_bad) are required")
        row = {k: body.get(k) for k in PAIR_ROW if body.get(k) is not None}
    row.update(eval_id=eval_id, saved=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), schema=KINDS[kind])
    with lock:
        p = path_for(eval_id, kind, max_age=0)
        with open(p, "a", encoding="utf8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        if not LOCAL_ONLY:
            from huggingface_hub import HfApi
            try:
                api = HfApi(token=TOKEN)
                api.create_repo(CFG["notes_repo"], repo_type="dataset", private=CFG["notes_private"], exist_ok=True)
                api.upload_file(path_or_fileobj=str(p), path_in_repo=f"annotations/{eval_id}/{kind}.jsonl", repo_id=CFG["notes_repo"],
                                repo_type="dataset", commit_message=f"{eval_id} {kind}: {row.get('run') or row.get('id') or ''} {row.get('sentence') or ''}")
            except Exception as ex:  # roll back so the client keeps the row in its outbox and retries
                lines = p.read_text(encoding="utf8").splitlines()
                p.write_text("".join(l + "\n" for l in lines[:-1]), encoding="utf8")
                return JSONResponse({"ok": False, "error": str(ex)[:300]}, status_code=502)
    return {"ok": True, "row": row}


def upload_bytes(data, path_in_repo, msg):
    from huggingface_hub import HfApi
    api = HfApi(token=TOKEN)
    api.create_repo(CFG["notes_repo"], repo_type="dataset", private=CFG["notes_private"], exist_ok=True)
    api.upload_file(path_or_fileobj=data, path_in_repo=path_in_repo, repo_id=CFG["notes_repo"], repo_type="dataset", commit_message=msg)


@app.post("/api/voice/{eval_id}")
async def post_voice(eval_id: str, request: Request):
    """A spoken note on a clip (or a pair): the audio file plus its context, as multipart form fields."""
    find(eval_id)
    form = await request.form()
    audio = form.get("audio")
    if audio is None or not form.get("pass"):
        raise HTTPException(400, "audio and pass are required")
    data = await audio.read()
    if not data or len(data) > 20_000_000:
        raise HTTPException(400, "empty or too large (20 MB max)")
    mime = (audio.content_type or "audio/webm").split(";")[0]
    ext = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav"}.get(mime, "webm")
    vid = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "_" + os.urandom(3).hex()
    row = {k: form.get(k) for k in VOICE_ROW if form.get(k) not in (None, "")}
    row.update(id=vid, mime=mime, audio=f"annotations/{eval_id}/voice/{vid}.{ext}", eval_id=eval_id,
               saved=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), schema=KINDS["voice"])
    for k in ("blind",):
        if k in row:
            row[k] = row[k] == "true"
    if "seconds" in row:
        row["seconds"] = round(float(row["seconds"]), 1)
    with lock:
        local = STORE / eval_id / "voice" / f"{vid}.{ext}"
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(data)
        p = path_for(eval_id, "voice", max_age=0)
        with open(p, "a", encoding="utf8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        if not LOCAL_ONLY:
            try:
                upload_bytes(data, row["audio"], f"{eval_id} voice note {vid}")
                upload_bytes(str(p), f"annotations/{eval_id}/voice.jsonl", f"{eval_id} voice: {row.get('run') or ''} {row.get('sentence') or ''}")
            except Exception as ex:
                lines = p.read_text(encoding="utf8").splitlines()
                p.write_text("".join(l + "\n" for l in lines[:-1]), encoding="utf8")
                return JSONResponse({"ok": False, "error": str(ex)[:300]}, status_code=502)
    return {"ok": True, "row": row}


# Cache-busting: the page names the assets with the starter's commit (STARTER_COMMIT, set by the Dockerfile) so a new
# deploy is never served from a stale browser cache.
ASSET_V = (os.environ.get("STARTER_COMMIT") or str(int((HERE / "static/app.js").stat().st_mtime)))[:12]


@app.get("/")
def index():
    html = (HERE / "static/index.html").read_text(encoding="utf8")
    html = html.replace('/static/app.js"', f'/static/app.js?v={ASSET_V}"').replace('/static/style.css"', f'/static/style.css?v={ASSET_V}"')
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
