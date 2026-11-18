# TTS Pronunciation Annotation Starter

A small, self-hostable app for **listening evaluations of text-to-speech voices**. It runs as a Docker Space on
Hugging Face, or anywhere Docker runs, and saves annotations as JSON lines to a Hugging Face dataset.

The app implements the **screen, then rank** method:

1. **Pass 1, screen.** Each clip gets an acceptability verdict.
2. **Pass 2, rank.** The clips that survive the screen get a blind pairwise preference, and a Bradley–Terry fit
   turns those preferences into a ranking.

It is the reference implementation, for audio, of the `screen-then-rank` skill in the `ai-eval` plugin.

## Why

This came out of training and evaluating TTS models for [Hebrish](https://hebrish.app). A synthetic voice can be
judged at many high levels, but the most common failure is plain **pronunciation accuracy**. It comes at two basic
levels: **stress on the wrong syllable**, and **mispronunciation** (the wrong sound, or the wrong reading of a
homograph). Rating every clip from 1 to 5 on several axes is slow, and the scores drift from one annotator to the
next, and from one session to the next.

Screen, then rank splits the work:

- **A fast first pass separates fine from problem.**
  - Each whole clip, the sentence as rendered, is **Pass** or **Fail**.
  - A fail takes one tap on a reason category: mispronunciation, wrong emphasis, glitch, truncation, wrong voice or
    language, or other.
  - Most clips take a few seconds.
- **The head-to-head comparisons happen only where they matter.** Pass 2 compares only clips that passed. It
  doesn't spend votes on voices that are already out.
- **Pairwise judgements are more reliable than absolute scores.** "Which of these two is better?" is easier to
  answer consistently than "is this a 3 or a 4?". Bradley–Terry turns the votes into one strength per voice.
- **The detail is optional and structured.** When it's worth recording, the word-level detail is a second layer:
  - **Stress:** the syllable heard vs. the syllable it should be.
  - **Mispronunciation:** the IPA heard vs. the IPA expected.
  
  This replaces brittle free-form comments with data you can count and turn into training targets. Annotators
  need **IPA** for it. A language pack supplies a keypad, a tooltip per symbol and a searchable cheat sheet.

The method is not specific to TTS. Any generated output that can be screened for acceptability and then compared
in pairs fits it: images, summaries, translations, voices.

## What it does

### Pass 1 · Screen

For each clip:

- **Verdict:** **Pass** (`P`) or **Fail** (`X`).
- **Voice gender:** female, male or unclear (`F` `M` `U`). When names aren't hidden, it is prefilled from the same
  voice's last clip.
- **On a fail:** pick one or more reason categories (keys `1`–`6` while failing). "Other" needs a comment.
- **Add detail** (optional, collapsed). It is available on a pass or a fail and never required:
  - **Word issues:** tap a word, then choose **Stress**, **Mispronounced** or **Other** (skipped, added sound,
    unnatural pause, accent; shift-tap for a span).
    - Stress offers syllable buttons in two rows: "voice stressed" and "should be".
    - Mispronounced has IPA "heard" and "expected" fields, plus a keypad.
    - When the manifest provides a word reference, it is shown and preselected, labelled as a machine reference to
      check.
  - **Quality ratings:** if `passes.quality` is on, the configured axes are here: 1 to 5 scales, yes/no, or a
    choice.

There are two ways through:

- **Compare voices on one sentence.** With blind on, voices show as A, B, C, in a stable shuffled order, and the
  name is revealed when you save.
- **One voice through every sentence,** with an overall note at the end.

### Pass 2 · Rank

- **What is shown:** for one sentence, two clips that both passed, as A and B. Their order is random and their names
  are hidden.
- **Keys:** `A` and `B` play them. `1` = A better, `2` = B better, `3` = tie, `4` = both bad. "Both bad" sends both
  clips back to the screen as late fails, with that reason. `Enter` confirms and `U` undoes the last comparison.
- **Scheduling, `rank.pairing: "playoff"` (the default):** an adaptive play-off for each sentence.
  1. An opening round, in which every survivor plays once. With an odd number, one plays twice.
  2. Any clip with a head-to-head loss is knocked out.
  3. The **leader** is the unbeaten clip with the most wins; Bradley–Terry breaks a tie between leaders. It then plays
     each unbeaten challenger it hasn't met.
  4. A draw between unbeaten finalists gets one tie-break rematch.

  A sentence is decided long before all n(n−1)/2 pairs have been voted. If every clip has a loss (a cycle), or the
  rematch also draws, Bradley–Terry decides.
- **`rank.pairing: "all"`:** serves every pair of passing clips instead.

### Voice notes: say it instead of clicking it

Annotation gets fiddly by hand. So every clip, and every pair, has a **🎙 Voice note** button (key **R**): say what you
heard, following the agreed structure (pass or fail, why, which word, which syllable was stressed and which should
have been, what it sounded like, the voice's gender). The recording uploads at once, and you can move on without
clicking anything else.

1. **Define** the annotation structure (the config: fail reasons, gender options, word-level tag types).
2. **Record** your feedback per clip, in that structure, by voice.
3. **Transcribe and apply:** `tools/apply_voice_notes.py` sends each note, with the clip's context (sentence, pointed
   text, per-word reference IPA and syllables, the allowed categories), to an audio-capable model on OpenRouter (default
   `google/gemini-3.5-flash`). It keeps the **verbatim transcript**, and writes the structured annotation as a screen row
   with `source: "voice:<id>"`. A verdict you later saved by hand is never overwritten; that case is logged as a conflict.

```bash
OPENROUTER_API_KEY=... python3 tools/apply_voice_notes.py --config config.json --verbose   # dry run: shows the reading
OPENROUTER_API_KEY=... python3 tools/apply_voice_notes.py --config config.json --apply     # writes to the dataset
```

The recordings are kept in the annotations dataset (`annotations/<eval_id>/voice/<id>.webm`, indexed in `voice.jsonl`
with the processed transcript), so the annotations can be published with the evidence behind them. Checked on
2026-11-18 with a spoken test note ("a fail, wrong emphasis on the third word, sefer ... female voice"). It came back as
verdict `fail`, reason `Wrong emphasis (stress)`, word 3 סֵפֶר stressed on syllable 1 where it should be 0, and gender
`female`, at under US$0.01 per note.

The same pattern works for any audio judgement where speaking is faster than clicking: voice clones, EQ and mix
choices, noise removal. It is the `spoken-annotations` skill of the ai-eval plugin; the method as a whole is its
`screen-then-rank` skill.

### Reader: a public page for the annotations

`viewer/index.html` is a static, read-only page for the annotations dataset: each annotated clip with its verdict,
reasons, word tags and note, plus the spoken notes (playable, with a lightly tidied transcript and the verbatim one on
request). It fetches everything live from the Hub. Deploy it as a static Space with a `config.json`
(`title, intro, notes_repo, evals_registry, font_stack, annotator`). Example:
[danielrosehill/Hebrew-TTS-Listening-Notes-Reader](https://huggingface.co/spaces/danielrosehill/Hebrew-TTS-Listening-Notes-Reader).

### Results

- **Screen:**
  - Pass rate per voice.
  - Failures by category.
  - When the detail layer was used: stress and mispronunciation counts, and the most-failed words.
  - Voice gender per voice.
  - Overall notes.
- **Rank:**
  - Per voice: comparisons, wins / ties / losses, and the win rate, counting a tie as half a win.
  - The **Bradley–Terry strength**: a minorization-maximization fit with ties as half wins and a small prior,
    normalised to a geometric mean of 1. It is computed over all sentences or a single sentence.
  - Each sentence's play-off status and winner.
- **Export:** screen rows as CSV or JSONL, and pairs as JSONL.

### Built to be used often

- **Keyboard-first.** `?` lists every key.
- **Works on a phone and in dark mode.**
- **Never loses work.** Every save goes through a browser outbox first, and is retried until the server confirms
  it.

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
| `passes` | `{screen, rank, quality}`. `rank: false` hides pass 2. `quality: true` adds the `axes` rows to the detail layer. |
| `fail_reasons` | The clip-level fail categories, keyed `1`–`n` while failing |
| `other_reason` | The category that needs a comment (default `"Other"`) |
| `tag_reasons` | Maps a word-issue type to a category, e.g. `{"stress": "Wrong emphasis (stress)"}`. A detail added to an unjudged clip then marks it Fail with that category. |
| `rank_reject_reason` | The category written for late fails from "both bad" |
| `gender` | `{label, options: {value: key}}` or `null` |
| `rank` | `{pairing: "playoff" \| "all"}` |
| `axes` | Optional quality rows `[{key, type, label, hint, short?}]`, used when `passes.quality` is on. See the table below. |
| `minor_tags` | The word-issue tags offered under "Other" |
| `reference_label` | How the machine word reference is labelled |
| `notes_repo` | The HF dataset annotations go to, e.g. `your-user/your-annotations`. If `null`, annotations stay local. |
| `notes_private` | Create the dataset as private (default `true`) |
| `evals_registry` | URL of a registry JSONL (below) |
| `manifest_url`, `manifest_eval_id`, `manifest_title` | Use a single manifest when there is no registry |

Types of quality axis:

| `type` | Stored as | Extra keys |
| --- | --- | --- |
| `scale` (default) | integer 1 to 5 | — |
| `binary` | `"yes"` / `"no"` | `labels: {yes, no}`, `keys: {yes, no}` |
| `choice` | the option text | `options: [...]`, `keys: {option: key}` |

`examples/hebrew.config.json` is a full right-to-left example: Hebrew with nikud, quality off, play-off ranking.

## Data formats

### Registry: `evals.jsonl`

One evaluation per line:

```json
{"eval_id": "my-eval-2611", "title": "My eval", "date": "2026-11-18", "manifest": "https://…/data.json"}
```

`data_json` is accepted as a synonym for `manifest`.

### Clip manifest

The schema is [`schema/manifest.schema.json`](schema/manifest.schema.json), and `static/examples/demo-manifest.json`
is an example. The manifest lists the sentences, the model runs, and each run's clip per sentence. Each sentence can
also carry `words` (`[{position, text, ipa_ref, syllables, stress_ref}]`): a reference that the detail layer shows
and preselects. Without it, annotators type the syllables and IPA themselves.

```json
{
  "sentences": [{"id": "s01", "text": "…", "focus": "what it tests",
                 "words": [{"position": 1, "text": "record", "ipa_ref": "ˈɹɛkɚd", "syllables": ["re", "cord"], "stress_ref": 0}],
                 "words_source": "machine (G2P name)"}],
  "models": [{"slug": "voice-a", "name": "Voice A", "run": {"input": "plain"}, "clips": {"s01": "audio/voice-a/s01.mp3"}}],
  "clip_base": "optional URL prefix; defaults to the manifest's folder"
}
```

### Output

Both files go to `notes_repo`, are append-only, and carry a versioned `schema` field.

**`annotations/<eval_id>/screen.jsonl`**, schema `tts-annotation/2` ([`schema/annotation.schema.json`](schema/annotation.schema.json)).
One line per save; the latest line per `(run, sentence)` is the clip's current verdict.

```json
{"run": "voice-a", "sentence": "s01", "verdict": "fail", "fail_reasons": ["Wrong emphasis (stress)"], "gender": "female",
 "word_issues": [{"type": "stress", "word": "record", "position": 2, "syllables": ["re", "cord"], "heard": 1, "correct": 0, "comment": ""}],
 "scores": null, "note": "", "blind": true, "source": "screen", "eval_id": "my-eval-2611", "saved": "2026-11-18T15:00:00Z",
 "schema": "tts-annotation/2"}
```

- `fail_reasons` is required on a fail.
- `word_issues` and `scores` are the optional detail layer.
- `source: "rank"` marks a late fail that came from a "both bad" comparison.

**`annotations/<eval_id>/pairs.jsonl`**, schema `tts-pairwise/1` ([`schema/pairwise.schema.json`](schema/pairwise.schema.json)).
One line per comparison:

```json
{"id": "lp3k9x…", "sentence": "s01", "pair": "s01|voice-a|voice-b", "left": "voice-b", "right": "voice-a", "outcome": "left",
 "stage": "opening", "note": "", "eval_id": "my-eval-2611", "saved": "…", "schema": "tts-pairwise/1"}
```

- `outcome` is `left`, `right`, `tie` or `both_bad`.
- An undo is its own line, `{"type": "undo", "target": "<id>"}`, which cancels that comparison.
- `stage` records where in the play-off the pair was served: `opening`, `playoff`, `tiebreak`, or `voting` for all
  pairs.

## Deploy as a Hugging Face Docker Space

1. Create a Space with the Docker SDK. Make it private if your annotations or clips are.
2. Push this repo to it, or deploy your own config on top of a pinned commit with the Dockerfile below. The app
   serves on port 7860.
3. Add a Space secret `HF_TOKEN` with write access to `notes_repo`, and read access to a private registry or manifest
   if you use one.
4. Check it works: screen one clip, then confirm that `annotations/<eval_id>/screen.jsonl` appears in the dataset.

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
- **Scratch evaluations:** eval ids starting with `test-` reuse the first evaluation's clips, so scratch annotations
  never land in a real evaluation's files.

## Licence

MIT. The Hebrew language pack's notes come from the Hebrish project.
