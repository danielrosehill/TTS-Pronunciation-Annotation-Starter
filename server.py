"""TTS pronunciation annotation: a small FastAPI server in front of one static page (static/).

Configuration: config.json (path in CONFIG_PATH, default ./config.json), with environment overrides (see README).
Evaluations come from a registry JSONL (one evaluation per line: eval_id, title, date, manifest) or from one clip
manifest. Annotations are append-only JSON lines in a Hugging Face dataset, one file per evaluation,
annotations/<eval_id>.jsonl; the latest line per (run, sentence) wins. LOCAL_ONLY=1 keeps them in a local folder.
"""
import json, os, re, threading, time, urllib.request
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
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
ROW = ["run", "run_name", "input", "sentence", "scores", "word_tags", "note", "blind", "client_id"]

lock = threading.Lock()
_evals = {"t": 0, "v": None}
_manifests = {}
_pulled = set()
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


def path_for(eval_id):
    p = STORE / f"{eval_id}.jsonl"
    if eval_id not in _pulled:
        if not LOCAL_ONLY:
            from huggingface_hub import hf_hub_download
            try:
                src = hf_hub_download(CFG["notes_repo"], f"annotations/{eval_id}.jsonl", repo_type="dataset", token=TOKEN, force_download=True)
                p.write_text(Path(src).read_text(encoding="utf8"), encoding="utf8")
            except Exception:
                p.exists() or p.write_text("", encoding="utf8")
        else:
            p.exists() or p.write_text("", encoding="utf8")
        _pulled.add(eval_id)
    if not p.exists():
        p.write_text("", encoding="utf8")
    return p


def latest(eval_id):
    out = {}
    for l in path_for(eval_id).read_text(encoding="utf8").splitlines():
        if l.strip():
            n = json.loads(l)
            out[(n["run"], n["sentence"])] = n
    return list(out.values())


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
            r["n_rated"] = sum(1 for n in latest(e["eval_id"]) if n["sentence"] != "overall")
        except Exception as ex:
            r["error"] = str(ex)[:200]
        rows.append(r)
    return rows


@app.get("/api/eval/{eval_id}")
def get_eval(eval_id: str):
    return manifest(eval_id)


@app.get("/api/annotations/{eval_id}")
def get_annotations(eval_id: str):
    find(eval_id)
    with lock:
        return latest(eval_id)


@app.post("/api/annotations/{eval_id}")
async def post_annotation(eval_id: str, request: Request):
    find(eval_id)
    body = await request.json()
    if not body.get("run") or not body.get("sentence"):
        raise HTTPException(400, "run and sentence are required")
    row = {k: body.get(k) for k in ROW}
    row.update(eval_id=eval_id, saved=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), schema="tts-annotation/1")
    with lock:
        p = path_for(eval_id)
        with open(p, "a", encoding="utf8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        if not LOCAL_ONLY:
            from huggingface_hub import HfApi
            try:
                api = HfApi(token=TOKEN)
                api.create_repo(CFG["notes_repo"], repo_type="dataset", private=CFG["notes_private"], exist_ok=True)
                api.upload_file(path_or_fileobj=str(p), path_in_repo=f"annotations/{eval_id}.jsonl", repo_id=CFG["notes_repo"],
                                repo_type="dataset", commit_message=f"{eval_id}: {row['run']} {row['sentence']}")
            except Exception as ex:  # roll back so the client keeps the row in its outbox and retries
                lines = p.read_text(encoding="utf8").splitlines()
                p.write_text("".join(l + "\n" for l in lines[:-1]), encoding="utf8")
                return JSONResponse({"ok": False, "error": str(ex)[:300]}, status_code=502)
    return {"ok": True, "row": row}


@app.get("/")
def index():
    return FileResponse(HERE / "static/index.html", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
