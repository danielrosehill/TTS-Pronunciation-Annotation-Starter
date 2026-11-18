# TTS Pronunciation Annotation Starter

A small, self-hostable app for **listening evaluations of text-to-speech voices** with structured, word-level
pronunciation annotations. It runs as a Docker Space on Hugging Face (or anywhere Docker runs) and saves annotations
as JSON lines to a Hugging Face dataset.

## Why

This came out of training and evaluating TTS models for [Hebrish](https://hebrish.app). There is plenty to say about
a synthetic voice at a high level: naturalness, prosody, pace. In practice, though, the most common failure is plain
**pronunciation accuracy**, and it shows up at two basic levels:

1. **Stress on the wrong syllable.**
2. **Mispronunciation:** the wrong sound, or the wrong word read for a homograph.

Free-form comments like "sounds off on the third word" are brittle. They can't be counted, compared across voices or
turned into training targets. Here, each problem is a **structured tag on a word**:

- A **stress** tag records the syllable the voice stressed and the one it should have.
- A **mispronunciation** tag records the IPA the annotator heard and the IPA expected.

Annotators need to know **IPA** to use it. A language pack supplies an IPA keypad, a tooltip per symbol and a
searchable cheat sheet, so nobody has to hunt for characters.

## What it does

- **Evaluations:** you pick one from a registry (JSONL), or the app loads a single clip manifest.
- **Two ways through:**
  - **Compare voices on one sentence:** every voice reads the same sentence. With blind mode on, voices show as
    A, B, C in a shuffled order, and the name is revealed when you save.
  - **One voice through every sentence**, with an overall note on the voice at the end.
- **Per clip:**
  - Answers on configurable axes. Each axis is one of three types:
    - `scale`: a 1 to 5 score.
    - `binary`: yes or no, e.g. "Vowels match the nikud?".
    - `choice`: one option from a list, e.g. "Use this voice?" Yes / Maybe / No.
  - An overall comment.
  - **Word tags.** Tap a word, then choose a tag type:
    - **Stress:** pick the syllable the voice stressed and the syllable it should have. The reference stress is
      preselected and you can change it.
    - **Mispronounced:** fill in "Heard" and "Expected" in IPA. Expected is prefilled from the reference and is
      editable.
    - **Other:** skipped, added sound, unnatural pause, accent, other. Shift-tap to tag a span.
- **Reference per word.** When the manifest provides IPA, syllables and stress, they are shown labelled as a
  machine reference to check.
- **Keyboard-first:** Space plays, 1 to 5 scores the highlighted scale row, each yes/no or choice option has its
  own key, Enter saves and moves on, ? opens help.
- **No lost work.** Saves go through an outbox in the browser and are retried until the server confirms them.
- **Results tab:**
  - Per voice: the mean of each scale axis, % yes for each binary axis (out of the clips judged), the count of each
    option for each choice axis, and counts of stress errors, mispronunciations and other tags, plus the most-tagged
    words.
  - Per sentence: best and worst voice.
  - Download everything as CSV or JSONL.

Stack: FastAPI (`server.py`) and one static page (`static/`, vanilla JS, no build step).

## Quick start (local)

```bash
uv run --with fastapi --with 'uvicorn[standard]' --with huggingface_hub uvicorn server:app --port 7860
# open http://localhost:7860: the demo manifest, annotations kept locally (no dataset configured)
```

## Configuration

`config.json` sits next to `server.py`. Set `CONFIG_PATH` to use another file. These environment variables override
the matching config fields: `APP_TITLE`, `NOTES_REPO`, `EVALS_REGISTRY` and `MANIFEST_URL`.

| Key | Meaning |
| --- | --- |
| `title` | App title |
| `language`, `rtl` | Language code; `true` for right-to-left text |
| `font_stack` | CSS font stack for the sentence text |
| `language_pack` | `languages/<code>/`: IPA keypad, tooltips and IPA help ([languages/README.md](languages/README.md)) |
| `ipa_keypad` | Optional list of symbols that overrides the pack's keypad |
| `fields` | Which manifest sentence fields to show: `display` (the line with tappable words), `secondary` (shown small above it), `gloss` (a translation shown below) |
| `axes` | The rows to answer: `[{key, type, label, hint, short?}]`, see the table below |
| `minor_tags` | The tags offered under "Other" |
| `reference_label` | How the machine word reference is labelled |
| `notes_repo` | The HF dataset annotations go to, e.g. `your-user/your-annotations`. If `null`, annotations stay local. |
| `notes_private` | Create the dataset as private (default `true`) |
| `evals_registry` | URL of a registry JSONL (below) |
| `manifest_url`, `manifest_eval_id`, `manifest_title` | Use a single manifest when there is no registry |

Axis types:

| `type` | Stored as | Extra keys | Keyboard |
| --- | --- | --- | --- |
| `scale` (default) | integer 1 to 5 | — | 1 to 5 on the highlighted scale row; ↑ ↓ move between scale rows |
| `binary` | `"yes"` / `"no"` | `labels: {yes, no}`, `keys: {yes, no}` | the keys you give, e.g. `{"yes": "v", "no": "x"}` |
| `choice` | the option text | `options: [...]`, `keys: {option: key}` | the keys you give; default is the option's first letter |

Give each binary and choice axis keys that don't clash with another axis's keys. `short` is an optional column title
for the Results tab. A config with the older `verdict: {label, options}` still works: it becomes a `choice` axis
named `verdict`.

`examples/hebrew.config.json` is a full right-to-left example. Its sentences are Hebrew with nikud. It has three scale
axes, a binary "Vowels match the nikud?" axis on the keys V and X, and a "Use it as the reference voice?" choice axis
on Y, M and N.

## Data formats

### Registry: `evals.jsonl`

One evaluation per line:

```json
{"eval_id": "my-eval-2611", "title": "My eval", "date": "2026-11-18", "manifest": "https://…/data.json"}
```

`data_json` is accepted as a synonym for `manifest`. Other fields are ignored.

### Clip manifest

The manifest lists the sentences, the model runs, and each run's clip per sentence. Its schema is
[`schema/manifest.schema.json`](schema/manifest.schema.json), and `static/examples/demo-manifest.json` is an example.

```json
{
  "sentences": [{"id": "s01", "text": "…", "focus": "what it tests",
                 "words": [{"position": 1, "text": "record", "ipa_ref": "ˈɹɛkɚd", "syllables": ["re", "cord"], "stress_ref": 0}],
                 "words_source": "machine (G2P name)"}],
  "models": [{"slug": "voice-a", "name": "Voice A", "run": {"input": "plain"}, "clips": {"s01": "audio/voice-a/s01.mp3"}}],
  "clip_base": "optional URL prefix; defaults to the manifest's folder"
}
```

`words` is optional. Without it, the display text is split into words, and annotators type the syllables and IPA
themselves.

### Output: `annotations/<eval_id>.jsonl`

Annotations are append-only. The latest line per `(run, sentence)` is the current annotation for that clip. The schema
is [`schema/annotation.schema.json`](schema/annotation.schema.json) (`"schema": "tts-annotation/1"`). An example
line:

```json
{"run": "voice-a", "run_name": "Voice A", "input": "plain", "sentence": "s01",
 "scores": {"naturalness": 4, "pronunciation": 2, "use": "Maybe"},
 "word_tags": [
   {"type": "stress", "word": "record", "position": 2, "syllables": ["re", "cord"], "heard": 1, "correct": 0, "comment": ""},
   {"type": "mispronunciation", "word": "thought", "position": 4, "ipa_heard": "tɔt", "ipa_expected": "θɔt", "comment": "th as t"},
   {"type": "minor", "words": ["it", "through"], "positions": [5, 6], "tags": ["Unnatural pause"], "comment": ""}],
 "note": "", "blind": true, "client_id": "k3j9…", "eval_id": "my-eval-2611", "saved": "2026-11-18T15:00:00Z",
 "schema": "tts-annotation/1"}
```

## Deploy as a Hugging Face Docker Space

1. Create a Space with the Docker SDK. Make it private if your annotations or clips are.
2. Push this repo to it. The Dockerfile serves on port 7860. Put your `config.json` at the root, or copy this repo
   and add the config in your copy.
3. Add a Space secret `HF_TOKEN` with write access to `notes_repo`, and read access to a private registry or manifest
   if you use one.
4. Open the Space. To check it, save one annotation and confirm that `annotations/<eval_id>.jsonl` appears in the
   dataset.

To deploy your own config on top of a pinned version of this starter, use a Dockerfile like this:

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/danielrosehill/TTS-Pronunciation-Annotation-Starter /app && cd /app && git checkout <commit>
WORKDIR /app
RUN pip install --no-cache-dir -r requirements.txt
COPY config.json /app/config.json
RUN useradd -m -u 1000 user && chown -R user /app
USER user
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "7860"]
```

## Testing

- **Annotations:** set `LOCAL_ONLY=1`. Annotations then stay in `/tmp/annotations` (set `ANNOTATION_CACHE` to move
  them) and nothing is uploaded.
- **Scratch evaluations:** eval ids starting with `test-` reuse the first evaluation's clips, so a scratch annotation
  never lands in a real evaluation's file.

## Licence

MIT. The Hebrew language pack's notes come from the Hebrish project.
