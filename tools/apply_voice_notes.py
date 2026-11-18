#!/usr/bin/env python3
"""Turn spoken annotations into structured ones.

The app's 🎙 Voice note button stores each recording at annotations/<eval_id>/voice/<id>.<ext> with a line in
annotations/<eval_id>/voice.jsonl (the clip or pair it was about). For every note not yet processed, this script:

  1. converts the audio to 16 kHz mono MP3 (ffmpeg) and sends it, with the clip's context (sentence, pointed text,
     gloss, per-word reference IPA and syllables, the config's fail-reason categories and gender options), to an
     audio-capable model on OpenRouter (default google/gemini-3.5-flash);
  2. keeps the model's verbatim transcript and its structured reading of it, as a `processed` line in voice.jsonl;
  3. for a screen note that states a verdict, appends a screen row with source "voice:<id>", unless the annotator
     already saved a verdict for that clip by hand after the note was recorded (then it only records a conflict);
     a rank note's stated preference is kept in the processed line for review, not turned into a vote.

    OPENROUTER_API_KEY=... python3 tools/apply_voice_notes.py --config config.json            # dry run, prints
    OPENROUTER_API_KEY=... python3 tools/apply_voice_notes.py --config config.json --apply    # writes to the dataset

Needs huggingface_hub (and a token with write access to notes_repo for --apply) and ffmpeg. Stdlib otherwise.
"""
import argparse, base64, json, os, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

PROMPT = """You are turning an annotator's spoken feedback on one text-to-speech clip into structured annotations.

The clip read this sentence:
{context}

Fail-reason categories (use these exact strings): {reasons}
Voice gender options: {genders}

Listen to the annotator's recording. Return JSON only:
{{"transcript": "<verbatim transcript of the annotator, in the language(s) they spoke, Hebrew words in Hebrew script>",
  "verdict": "pass" | "fail" | null,            // null if they did not say or imply one
  "fail_reasons": [<categories that apply>],    // empty unless verdict is fail
  "gender": <one gender option or null>,
  "word_issues": [{{"type": "stress" | "mispronunciation" | "other", "position": <1-based word position in the sentence>,
                   "word": "<the word as written>", "heard": <stressed syllable index heard, 0-based, stress only>,
                   "correct": <syllable index it should be, 0-based, stress only>, "ipa_heard": "<IPA, mispronunciation only>",
                   "ipa_expected": "<IPA>", "comment": "<their words, short>"}}],
  "preference": "left" | "right" | "tie" | "both_bad" | null,   // only for a comparison of two voices
  "note": "<anything else they said that is worth keeping, short, or empty>",
  "confidence": "high" | "medium" | "low"}}
Only record what the annotator said or clearly implied. Use the reference syllables and IPA to locate words and syllables;
when they describe a sound in words ("it said ch like in chana masala"), write the IPA for it."""


def hub():
    from huggingface_hub import HfApi, hf_hub_download
    return HfApi(), hf_hub_download


def read_lines(repo, path):
    _, dl = hub()
    try:
        return [json.loads(l) for l in open(dl(repo, path, repo_type="dataset", force_download=True), encoding="utf8") if l.strip()]
    except Exception:
        return []


def manifest_for(cfg, eval_id):
    for line in urllib.request.urlopen(cfg["evals_registry"]).read().decode().splitlines():
        if line.strip() and json.loads(line)["eval_id"] == eval_id:
            return json.load(urllib.request.urlopen(json.loads(line)["data_json"]))
    raise SystemExit(f"{eval_id} is not in the registry")


def context(man, note):
    s = next(x for x in man["sentences"] if x["id"] == note.get("sentence"))
    lines = [f"Text: {s.get('text_nikud') or s.get('text')}", f"Plain: {s.get('text', '')}", f"Gloss: {s.get('english', '')}"]
    for w in s.get("words") or []:
        lines.append(f"  word {w['position']}: {w['nikud']}  reference IPA /{w['ipa_ref']}/  syllables {w['syllables']}  reference stress index {w['stress_ref']}")
    runs = {m["slug"]: m["name"] for m in man["models"]}
    if note.get("pass") == "rank":
        lines.append(f"This note compares two voices: left = {runs.get(note.get('left'))}, right = {runs.get(note.get('right'))}.")
    else:
        lines.append(f"Voice: {runs.get(note.get('run'), note.get('run'))}")
    return "\n".join(lines)


def ask(model, prompt, mp3):
    body = {"model": model, "temperature": 0, "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": [{"type": "text", "text": prompt},
                                                      {"type": "input_audio", "input_audio": {"data": base64.b64encode(mp3).decode(), "format": "mp3"}}]}]}
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}", "Content-Type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=180))
    txt = r["choices"][0]["message"]["content"].strip().removeprefix("```json").removesuffix("```")
    return json.loads(txt), r.get("usage", {})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--eval", help="one eval_id (default: every eval with voice notes)")
    ap.add_argument("--model", default="google/gemini-3.5-flash")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--verbose", action="store_true", help="print the full structured reading of each note")
    a = ap.parse_args()
    cfg = json.load(open(a.config))
    repo = cfg["notes_repo"]
    api, dl = hub()
    files = api.list_repo_files(repo, repo_type="dataset")
    evals = [a.eval] if a.eval else sorted({f.split("/")[1] for f in files if f.endswith("/voice.jsonl")})
    for ev in evals:
        voice = read_lines(repo, f"annotations/{ev}/voice.jsonl")
        done = {v["target"] for v in voice if v.get("type") == "processed"}
        todo = [v for v in voice if not v.get("type") and v["id"] not in done]
        if not todo:
            print(ev, "nothing to process"); continue
        man = manifest_for(cfg, ev)
        screen = read_lines(repo, f"annotations/{ev}/screen.jsonl")
        new_voice, new_screen = [], []
        for v in todo:
            src = dl(repo, v["audio"], repo_type="dataset")
            with tempfile.NamedTemporaryFile(suffix=".mp3") as t:
                subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src, "-ac", "1", "-ar", "16000", "-b:a", "48k", t.name], check=True)
                mp3 = Path(t.name).read_bytes()
            prompt = PROMPT.format(context=context(man, v), reasons=json.dumps(cfg.get("fail_reasons", [])),
                                   genders=json.dumps(list((cfg.get("gender") or {}).get("options", {}))))
            out, usage = ask(a.model, prompt, mp3)
            p = {"type": "processed", "target": v["id"], "model": a.model, "transcript": out.get("transcript"), "applied": out,
                 "usage": usage, "processed": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            if v.get("pass") != "rank" and out.get("verdict") in ("pass", "fail"):
                manual = [r for r in screen if r["run"] == v["run"] and r["sentence"] == v["sentence"]
                          and not str(r.get("source", "")).startswith("voice") and r.get("saved", "") > v["saved"]]
                if manual and manual[-1]["verdict"] != out["verdict"]:
                    p["conflict"] = f"the verdict saved by hand ({manual[-1]['verdict']}) differs from the note's; not overwritten"
                elif manual:  # same verdict: keep the hand-saved row, fill what it lacks from the note
                    m = dict(manual[-1])
                    for k in ("fail_reasons", "word_issues"):
                        m[k] = m.get(k) or out.get(k) or []
                    m["gender"] = m.get("gender") or out.get("gender")
                    m["note"] = "; ".join(x for x in (m.get("note"), out.get("note")) if x)
                    m.update(source=f"{m.get('source') or 'screen'}+voice:{v['id']}", saved=p["processed"])
                    new_screen.append(m)
                    p["merged"] = "same verdict as the hand-saved row; its empty fields filled from the note"
                elif out["verdict"] == "pass" or out.get("fail_reasons"):
                    run = next((m for m in man["models"] if m["slug"] == v["run"]), {})
                    new_screen.append({"run": v["run"], "run_name": run.get("name"), "input": (run.get("run") or {}).get("input"),
                                       "sentence": v["sentence"], "verdict": out["verdict"], "fail_reasons": out.get("fail_reasons") or [],
                                       "word_issues": out.get("word_issues") or [], "gender": out.get("gender"), "scores": None,
                                       "note": out.get("note") or "", "blind": v.get("blind"), "source": f"voice:{v['id']}", "annotator": v.get("annotator"),
                                       "eval_id": ev, "saved": p["processed"], "schema": "tts-annotation/2"})
            new_voice.append(p)
            if a.verbose:
                print(json.dumps(out, ensure_ascii=False, indent=1))
            print(json.dumps({"note": v["id"], "clip": [v.get("run") or [v.get("left"), v.get("right")], v.get("sentence")],
                              "transcript": out.get("transcript"), "verdict": out.get("verdict"), "fail_reasons": out.get("fail_reasons"),
                              "word_issues": len(out.get("word_issues") or []), "conflict": p.get("conflict")}, ensure_ascii=False))
        if a.apply:
            with tempfile.TemporaryDirectory() as d:
                for name, rows in (("voice.jsonl", voice + new_voice), ("screen.jsonl", screen + new_screen)):
                    Path(d, name).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf8")
                    api.upload_file(path_or_fileobj=str(Path(d, name)), path_in_repo=f"annotations/{ev}/{name}", repo_id=repo,
                                    repo_type="dataset", commit_message=f"{ev}: apply {len(new_voice)} voice notes")
            print(ev, f"applied: {len(new_voice)} notes processed, {len(new_screen)} screen rows written")
        else:
            print(ev, f"dry run: {len(new_voice)} notes, {len(new_screen)} screen rows would be written (add --apply)")


if __name__ == "__main__":
    main()
