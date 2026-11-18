/* TTS pronunciation annotation, method "screen, then rank".
   Pass 1, Screen: each clip is Pass or Fail (a fail needs a reason: a structured word tag or a clip-level reason),
   plus the voice gender; optional quality rows when the config enables them. -> annotations/<eval>/screen.jsonl
   Pass 2, Rank: blind pairwise preference between passing clips of the same sentence; "both bad" sends both back as
   late fails. Bradley-Terry ranking in the Results tab. -> annotations/<eval>/pairs.jsonl
   Every save goes through a localStorage outbox first, so a failed upload is shown and retried, never lost.
   Schemas: schema/annotation.schema.json (tts-annotation/2), schema/pairwise.schema.json (tts-pairwise/1). */
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const PUNCT = /^[.,!?:;"'()־׳״،؟]+|[.,!?:;"'()־׳״،؟]+$/g;
const LS = (k, v) => (v === undefined ? JSON.parse(localStorage.getItem("tpa." + k) || "null") : localStorage.setItem("tpa." + k, JSON.stringify(v)));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

let C = {}; // config from /api/config
let L = { keypad: [], symbols: [] }; // language pack from /api/language
const S = { evals: [], evalId: null, data: null, screen: new Map(), pairs: [], mode: "compare", blind: true, voice: null,
  queue: [], pos: 0, draft: null, dirty: false, axis: 0, sel: [], multi: false, sort: { k: "pass", d: -1 }, tab: "start", pop: null,
  rank: { list: [], i: 0, choice: null, history: [] } };
const key = (run, sid) => run + "|" + sid;
const runs = () => S.data.models;
const runBy = (slug) => S.data.models.find((m) => m.slug === slug);
const sentBy = (sid) => S.data.sentences.find((s) => s.id === sid);
const field = (s, k) => (C.fields?.[k] ? s[C.fields[k]] : null);
const genderOpts = () => Object.entries(C.gender?.options || {}).map(([v, k]) => ({ v, k }));
// Optional quality rows (config `axes`, shown only when passes.quality): scale 1-5, binary yes/no, choice.
function axisOptions(a) {
  if (a.type === "binary") { const lab = a.labels || {}, keys = a.keys || {};
    return [{ v: "yes", label: lab.yes || "Yes", key: keys.yes || null }, { v: "no", label: lab.no || "No", key: keys.no || null }]; }
  if (a.type === "choice") return (a.options || []).map((o) => ({ v: o, label: o, key: (a.keys || {})[o] ?? null }));
  return [1, 2, 3, 4, 5].map((v) => ({ v, label: String(v), key: null }));
}
const isScale = (a) => (a.type || "scale") === "scale";
const qualityOn = () => !!C.passes?.quality;
const qAxes = () => (qualityOn() ? C.axes : []);
const scaleAxes = () => qAxes().filter(isScale);

// ---------- seeded shuffle ----------
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = hash(seed); return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffled(arr, seed) { const r = rng(seed), out = arr.slice(); for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; }
async function api(path, opts) { const r = await fetch("/api/" + path, opts); if (!r.ok) throw new Error((await r.text()).slice(0, 200) || r.status); return r.json(); }

// ---------- outbox ----------
const outbox = () => LS("outbox2") || [];
function setOutbox(o) { LS("outbox2", o); renderOutbox(); }
function queueRow(kind, row) { setOutbox([...outbox(), { id: uid(), eval_id: S.evalId, kind, row }]); flush(); }
function renderOutbox() {
  const o = outbox(), b = $("outbox");
  b.hidden = !o.length;
  if (o.length) b.innerHTML = `${o.length} annotation${o.length > 1 ? "s" : ""} not saved to the server yet. <button class="ghost" id="retry">Retry now</button>`;
  $("retry")?.addEventListener("click", flush);
}
let flushing = false;
async function flush() {
  if (flushing) return; flushing = true;
  try {
    for (const item of outbox()) {
      let res;
      for (let attempt = 0; attempt < 3; attempt++) { // a Hub commit can collide with another one a second earlier: retry quietly first
        res = await fetch(`/api/annotations/${item.eval_id}/${item.kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.row) });
        if (res.ok || res.status === 400) break;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
      if (res.status === 400) { toast("Rejected by the server: " + (await res.text()).slice(0, 120), 5000); setOutbox(outbox().filter((x) => x.id !== item.id)); continue; }
      if (!res.ok) throw new Error("save failed (" + res.status + ")");
      setOutbox(outbox().filter((x) => x.id !== item.id));
      setTimeout(pollSync, 500);
    }
  } catch (e) { renderOutbox(); toast("Couldn't save: " + e.message + ". Kept on this device; it will retry.", 5000); }
  finally { flushing = false; }
}
setInterval(() => outbox().length && flush(), 30000);
// Server-to-dataset sync, shown in the header: saves are kept on the server at once and committed in the background.
async function pollSync() {
  try {
    const st = await api("sync");
    $("syncState").textContent = st.local_only ? "· local only" : st.pending ? `· ☁ copying ${st.pending} to the dataset…` :
      st.last_error ? "· ☁ dataset copy retrying" : st.last_commit ? "· ☁ all saved to the dataset" : "";
    clearTimeout(pollSync.t); pollSync.t = setTimeout(pollSync, st.pending || st.last_error ? 3000 : 20000);
  } catch { clearTimeout(pollSync.t); pollSync.t = setTimeout(pollSync, 10000); }
}
setTimeout(pollSync, 1500);

// ---------- start ----------
async function loadEvals() {
  $("evalList").innerHTML = `<div class="muted">Loading evaluations…</div>`;
  S.evals = await api("evals");
  const last = LS("eval");
  if (!S.evalId) S.evalId = S.evals.some((e) => e.eval_id === last) ? last : S.evals[0]?.eval_id;
  renderEvals();
}
function renderEvals() {
  $("evalList").innerHTML = S.evals.map((e) => {
    const pct = e.n_clips ? Math.round(100 * (e.n_rated || 0) / e.n_clips) : 0;
    return `<button class="eval ${e.eval_id === S.evalId ? "on" : ""}" data-id="${esc(e.eval_id)}"><b>${esc(e.title || e.eval_id)}</b>
      <span class="meta">${esc(e.date || "")}${e.n_clips != null ? ` · ${e.n_rated || 0} of ${e.n_clips} clips screened · ${e.n_pairs || 0} comparisons` : " · " + esc(e.error || "")}</span>
      <div class="prog"><div style="width:${pct}%"></div></div></button>`;
  }).join("") || `<div class="muted">No evaluations configured. Set evals_registry or manifest_url (see README).</div>`;
  document.querySelectorAll(".eval").forEach((b) => b.addEventListener("click", async () => { S.evalId = b.dataset.id; renderEvals(); await loadEval(); }));
}
function applyScreenRow(r) { S.screen.set(key(r.run, r.sentence), r); }
async function loadEval() {
  S.data = await api("eval/" + S.evalId);
  const [sc, pr] = await Promise.all([api(`annotations/${S.evalId}/screen`), api(`annotations/${S.evalId}/pairs`)]);
  S.screen = new Map(); sc.forEach(applyScreenRow);
  S.pairs = pr;
  for (const item of outbox()) if (item.eval_id === S.evalId) (item.kind === "screen" ? applyScreenRow(item.row) : S.pairs.push(item.row));
  // Rounds (Daniel, 2026-11-18: generate in rounds, only for survivors). Items may carry `round`; the queue then holds
  // only the chosen round's items (default: the latest), so earlier or unused items are never served again.
  const rounds = [...new Set(S.data.sentences.map((s) => s.round).filter((r) => r != null))].sort((a, b) => a - b);
  $("roundPickWrap").hidden = !rounds.length;
  $("roundPick").innerHTML = rounds.map((r) => `<option value="${r}">Round ${r}: ${esc(S.data.sentences.filter((s) => s.round === r).map((s) => s.id).join(", "))}</option>`).join("") +
    (rounds.length ? `<option value="all">Every item</option>` : "");
  if (rounds.length) $("roundPick").value = String(LS("round") && (LS("round") === "all" || rounds.includes(Number(LS("round")))) ? LS("round") : rounds[rounds.length - 1]);
  $("voicePick").innerHTML = runs().map((m) => `<option value="${esc(m.slug)}">${esc(m.name)}</option>`).join("");
  if (S.voice && runBy(S.voice)) $("voicePick").value = S.voice;
  S.rank.history = [];
}
function syncModeUi() {
  const m = document.querySelector("input[name=mode]:checked").value;
  $("voicePickWrap").hidden = m !== "voice";
  $("blind").closest("label").hidden = m !== "compare";
}

// ---------- screen queue ----------
// Runs with at least one Fail anywhere in the screen. Computed once per queue build, so a run failed mid-session drops
// out from the next sentence on, not from under the current one.
function failedRuns() { return new Set([...S.screen.values()].filter((r) => r.verdict === "fail").map((r) => r.run)); }
const inRound = (s) => !S.round || S.round === "all" || s.round === Number(S.round);
function buildQueue() {
  const q = [];
  if (S.mode === "compare") {
    for (const s of S.data.sentences.filter(inRound)) {
      // Daniel, 2026-11-18: "I don't need to keep hearing the failure voices because we know that they fail."
      let rs = runs().filter((m) => m.clips[s.id] && (!S.skipFailed || !failedRuns().has(m.slug) || S.screen.has(key(m.slug, s.id)))).map((m) => m.slug);
      if (S.blind) rs = shuffled(rs, S.evalId + s.id);
      rs.forEach((r, i) => q.push({ run: r, sid: s.id, group: s.id, idx: i, of: rs.length }));
    }
  } else {
    const m = runBy(S.voice) || runs()[0]; S.voice = m.slug;
    const ss = S.data.sentences.filter((s) => inRound(s) && m.clips[s.id]);
    ss.forEach((s, i) => q.push({ run: m.slug, sid: s.id, group: m.slug, idx: i, of: ss.length + 1 }));
    q.push({ run: m.slug, sid: "overall", group: m.slug, idx: ss.length, of: ss.length + 1 });
  }
  S.queue = q;
}
const cur = () => S.queue[S.pos];
const letter = (i) => (i < 26 ? String.fromCharCode(65 + i) : "V" + (i + 1));
const isBlind = () => S.mode === "compare" && S.blind;
const voiceLabel = (c) => (isBlind() ? `Voice ${letter(c.idx)}` : runBy(c.run).name);
function voiceSub(c) { if (isBlind()) return "Name hidden until you save"; const inp = runBy(c.run).run?.input; return inp ? `Input: ${inp === "nikud" ? "given the nikud" : "plain text (infers the vowels)"}` : ""; }
// Measured, not judged (manifest `metrics[sid]`, e.g. from a clip_metrics script): pace, level, clipping, pauses.
function metricLine(m, sid) {
  const x = m?.metrics?.[sid]; if (!x) return "";
  const pct = (v) => (v > 0 ? "+" : "") + Math.round(v * 100) + "%";
  return [x.pace_vs_median != null && `pace ${pct(x.pace_vs_median)} vs median`, x.lufs != null && `${x.lufs} LUFS`,
    x.true_peak != null && `peak ${x.true_peak} dBTP${x.clipped ? " ⚠ clipped" : ""}`,
    x.pauses ? `${x.pauses} pause${x.pauses > 1 ? "s" : ""} (longest ${x.longest_pause_s} s)` : null].filter(Boolean).join(" · ");
}
// How and when the clip was made (manifest run fields `generated`, `generated_via`); hidden in blind mode, since the route
// (an API, a GPU) can give the voice away.
function voiceProv(c) {
  if (isBlind()) return "";
  const r = runBy(c.run).run || {};
  return [r.generated && `Generated ${r.generated}`, r.generated_via && `via ${r.generated_via}`, metricLine(runBy(c.run), c.sid)].filter(Boolean).join(" · ");
}

// ---------- words and reference ----------
function words(s) {
  if (Array.isArray(s.words) && s.words.length) {
    return s.words.map((w, i) => ({ position: w.position ?? i + 1, text: w.text ?? w.nikud ?? w.display ?? "", ipa_ref: w.ipa_ref || "",
      syllables: w.syllables || [], stress_ref: w.stress_ref ?? null }));
  }
  return String(field(s, "display") || s.text || "").split(/\s+/).map((w) => w.replace(PUNCT, "")).filter(Boolean)
    .map((w, i) => ({ position: i + 1, text: w, ipa_ref: "", syllables: [], stress_ref: null }));
}
const refShown = (w) => w.ipa_ref || w.syllables.length;
// IPA convention: ˈ before the stressed syllable (upper-casing would corrupt IPA, e.g. χ -> Χ).
function sylDisplay(syls, stress) { return syls.map((x, i) => (i === stress ? "ˈ" + x : x)).join("."); }

// ---------- screen view ----------
function blankDraft() { return { verdict: null, fail_reasons: [], word_issues: [], gender: null, scores: {}, note: "" }; }
function lastGender(run) {
  let best = null;
  for (const r of S.screen.values()) if (r.run === run && r.gender && (!best || (r.saved || "") > (best.saved || ""))) best = r;
  return best?.gender || null;
}
function openClip(pos, play = true) {
  S.pos = Math.max(0, Math.min(S.queue.length - 1, pos));
  const c = cur(), n = S.screen.get(key(c.run, c.sid));
  S.draft = n ? { verdict: n.verdict || null, fail_reasons: [...(n.fail_reasons || [])], word_issues: JSON.parse(JSON.stringify(n.word_issues || [])),
    gender: n.gender || null, scores: { ...(n.scores || {}) }, note: n.note || "" } : blankDraft();
  S.prefilled = false;
  if (!n && !isBlind() && C.gender) { const g = lastGender(c.run); if (g) { S.draft.gender = g; S.prefilled = true; } }
  S.dirty = false; S.axis = 0; S.sel = []; closePop();
  $("detail").open = !!(S.draft.word_issues.length || Object.keys(S.draft.scores || {}).length);
  LS("pos." + S.evalId + "." + S.mode + (S.mode === "voice" ? "." + S.voice : ""), S.pos);
  renderClip();
  const a = $("audio"), m = runBy(c.run);
  a.pause();
  if (c.sid !== "overall" && m.clips[c.sid]) { a.src = S.data.clip_base + m.clips[c.sid]; if (play) a.play().catch(() => {}); }
  else a.removeAttribute("src");
}
function renderClip() {
  setTimeout(renderVn);
  const c = cur(), s = sentBy(c.sid), overall = c.sid === "overall";
  const group = S.queue.filter((x) => x.group === c.group);
  const done = S.queue.filter((x) => S.screen.has(key(x.run, x.sid))).length;
  $("whereText").innerHTML = S.mode === "compare"
    ? `Sentence <b>${esc(c.sid)}</b> of ${S.data.sentences.length} · voice <b>${c.idx + 1}</b> of ${c.of} · ${done} of ${S.queue.length} screened`
    : `<b>${esc(runBy(c.run).name)}</b> · ${overall ? "overall note" : `sentence <b>${c.idx + 1}</b> of ${c.of - 1}`} · ${done} of ${S.queue.length} screened`;
  $("groupPick").innerHTML = S.mode === "compare"
    ? S.data.sentences.map((x) => `<option value="${esc(x.id)}" ${x.id === c.sid ? "selected" : ""}>${esc(x.id)} · ${esc(String(field(x, "gloss") || field(x, "display") || "").slice(0, 48))}</option>`).join("")
    : runs().map((m) => `<option value="${esc(m.slug)}" ${m.slug === c.run ? "selected" : ""}>${esc(m.name)}</option>`).join("");
  $("dots").innerHTML = group.map((x) => {
    const i = S.queue.indexOf(x), r = S.screen.get(key(x.run, x.sid));
    const lab = S.mode === "compare" ? (isBlind() ? letter(x.idx) : x.idx + 1) : (x.sid === "overall" ? "★" : x.idx + 1);
    return `<button class="dot ${r ? (r.verdict === "fail" ? "fail" : "done") : ""} ${i === S.pos ? "cur" : ""}" data-i="${i}" title="${r ? r.verdict : "not screened"}">${lab}</button>`;
  }).join("");
  $("barFill").style.width = (100 * done / S.queue.length) + "%";
  document.querySelector(".sentence").hidden = overall;
  document.querySelector(".player").style.display = overall ? "none" : "";
  document.querySelector(".card.screen .seg.pf").parentElement.querySelectorAll(".pf, .axis-label:first-child").forEach((e) => (e.hidden = overall));
  if (!overall) {
    $("focus").textContent = [s.id, s.focus].filter(Boolean).join(" · ");
    const sec = field(s, "secondary"); $("plain").textContent = sec || ""; $("plain").hidden = !sec;
    $("gloss").textContent = field(s, "gloss") || "";
    renderWords();
  }
  $("voiceName").textContent = overall ? `${runBy(c.run).name}: overall` : voiceLabel(c);
  $("voiceSub").textContent = overall ? "A note on this voice as a whole" : voiceSub(c);
  $("voiceProv").textContent = overall ? "" : voiceProv(c);
  renderVerdict(); renderRatings();
  $("note").value = S.draft.note;
  renderState(); setPlayIcon();
}
function renderVerdict() {
  const d = S.draft;
  document.querySelectorAll("#pf button").forEach((b) => b.classList.toggle("on", d.verdict === b.dataset.v));
  $("failBox").hidden = d.verdict !== "fail";
  $("failBox").classList.toggle("ok", !!d.fail_reasons.length);
  $("reasons").innerHTML = (C.fail_reasons || []).map((r, i) => `<button class="chip ${d.fail_reasons.includes(r) ? "on" : ""}" data-r="${esc(r)}"><kbd>${i + 1}</kbd> ${esc(r)}</button>`).join("");
  const g = genderOpts();
  $("gender").parentElement.querySelectorAll("#gender, .axis-label.gl").forEach((e) => (e.hidden = !g.length));
  $("genderKeys").innerHTML = g.map((o) => `<kbd>${esc(o.k.toUpperCase())}</kbd>`).join(" ") + (S.prefilled ? ` <span class="muted">(prefilled from this voice's last clip)</span>` : "");
  $("gender").innerHTML = g.map((o) => `<button data-v="${esc(o.v)}" class="${d.gender === o.v ? "on" : ""}">${esc(o.v[0].toUpperCase() + o.v.slice(1))}</button>`).join("");
}
function renderRatings() {
  const hl = scaleAxes()[S.axis]?.key;
  $("ratings").innerHTML = qAxes().map((a) => {
    const opts = axisOptions(a), v = S.draft.scores[a.key];
    const keys = isScale(a) ? "" : opts.filter((o) => o.key).map((o) => `<kbd>${esc(o.key.toUpperCase())}</kbd>`).join(" ");
    return `<div class="axis ${a.key === hl ? "hl" : ""}" data-key="${esc(a.key)}">
      <div class="axis-label">${esc(a.label)} ${keys} <span class="hint">${esc(a.hint || "")}</span></div>
      <div class="seg ${isScale(a) ? "" : "use"}">${opts.map((o) => `<button data-key="${esc(a.key)}" data-v="${esc(o.v)}" class="${v === o.v ? "on" : ""}">${esc(o.label)}</button>`).join("")}</div></div>`;
  }).join("");
}
const tagsAt = (pos) => S.draft.word_issues.filter((t) => (t.position === pos) || (t.positions || []).includes(pos));
function renderWords() {
  const ws = words(sentBy(cur().sid));
  $("words").innerHTML = ws.map((w, i) => {
    const ts = tagsAt(w.position);
    const badges = ts.map((t) => `<span class="badge ${t.type === "stress" ? "s" : t.type === "mispronunciation" ? "p" : ""}">${t.type === "stress" ? "S" : t.type === "mispronunciation" ? "P" : "•"}</span>`).join("");
    return `<button class="w ${ts.length ? "tagged" : ""} ${S.sel.includes(i) ? "sel" : ""}" data-i="${i}">${esc(w.text)}${ts.length ? `<span class="badges">${badges}</span>` : ""}</button>`;
  }).join("");
  $("tagSel").hidden = S.sel.length < 2;
  $("tagSel").textContent = `Tag ${S.sel.length} selected words`;
  $("multiBtn").classList.toggle("on", S.multi);
  $("tagList").innerHTML = S.draft.word_issues.map((t) => {
    if (t.type === "stress") return `<div class="t"><span class="k s">Stress</span><span class="ww">${esc(t.word)}</span> heard <b>${esc(sylDisplay(t.syllables, t.heard))}</b>, should be <b>${esc(sylDisplay(t.syllables, t.correct))}</b>${t.comment ? ` · ${esc(t.comment)}` : ""}</div>`;
    if (t.type === "mispronunciation") return `<div class="t"><span class="k p">Pron.</span><span class="ww">${esc(t.word)}</span> heard <span class="ipa-t">/${esc(t.ipa_heard)}/</span>, expected <span class="ipa-t">/${esc(t.ipa_expected)}/</span>${t.comment ? ` · ${esc(t.comment)}` : ""}</div>`;
    return `<div class="t"><span class="k">${esc(t.tags.join(", ") || "Note")}</span><span class="ww">${esc(t.words.join(" "))}</span>${t.comment ? ` · ${esc(t.comment)}` : ""}</div>`;
  }).join("");
  renderVerdict();
}
function renderState() {
  const c = cur(), n = S.screen.get(key(c.run, c.sid));
  $("state").textContent = S.dirty ? "Unsaved changes" : n ? `${n.verdict === "fail" ? "Failed" : "Passed"} · saved ${n.saved || "on this device"}${n.source === "rank" ? " (from ranking)" : ""}` : "Not screened yet";
}
function setPlayIcon() { const p = !$("audio").paused; $("play").textContent = p ? "❚❚" : "▶"; $("play").classList.toggle("playing", p); }
function touch() { S.dirty = true; renderState(); }
function setResult(v) { S.draft.verdict = v; touch(); renderVerdict(); }
function setScore(k, v) { if (v == null) delete S.draft.scores[k]; else S.draft.scores[k] = v; touch(); }

// ---------- word popover ----------
function openPop(idxs, anchor) {
  const ws = words(sentBy(cur().sid)), span = idxs.length > 1;
  const w = ws[idxs[0]];
  const tags = span ? [] : tagsAt(w.position);
  const st = tags.find((t) => t.type === "stress"), mp = tags.find((t) => t.type === "mispronunciation");
  const mn = S.draft.word_issues.find((t) => t.type === "minor" && JSON.stringify(t.positions) === JSON.stringify(idxs.map((i) => ws[i].position)));
  S.pop = { idxs, ws, span, panel: span ? "minor" : st ? "stress" : mp ? "mis" : "stress",
    syllables: st?.syllables || w.syllables.slice(), heard: st?.heard ?? null, correct: st?.correct ?? w.stress_ref ?? null };
  $("popTitle").textContent = idxs.map((i) => ws[i].text).join(" ");
  $("popRef").innerHTML = !span && refShown(w)
    ? `<span title="${esc(sentBy(cur().sid).words_source || S.data.words_source || "")}">${esc(C.reference_label)}</span>: ${w.ipa_ref ? `<span class="ipa-t">/${esc(w.ipa_ref)}/</span>` : ""}${w.syllables.length ? ` · ${esc(sylDisplay(w.syllables, w.stress_ref))}` : ""}`
    : span ? "Tag for the whole span" : "No reference for this word: type the syllables and IPA yourself.";
  document.querySelectorAll(".ptab").forEach((b) => { b.hidden = span && b.dataset.p !== "minor"; });
  $("sylInput").value = S.pop.syllables.join("-");
  $("stressComment").value = st?.comment || "";
  $("ipaHeard").value = mp?.ipa_heard || "";
  $("ipaExpected").value = mp?.ipa_expected ?? w.ipa_ref ?? "";
  $("misComment").value = mp?.comment || "";
  $("minorChips").innerHTML = C.minor_tags.map((x) => `<button class="chip ${mn?.tags.includes(x) ? "on" : ""}" data-x="${esc(x)}">${esc(x)}</button>`).join("");
  $("minorComment").value = mn?.comment || "";
  renderSyls(); showPanel(S.pop.panel); markTabs();
  const pop = $("pop"); pop.hidden = false;
  const r = anchor.getBoundingClientRect(), wd = pop.offsetWidth;
  pop.style.top = (window.scrollY + r.bottom + 8) + "px";
  pop.style.left = Math.max(10, Math.min(window.innerWidth - wd - 10, window.scrollX + r.left + r.width / 2 - wd / 2)) + "px";
}
function closePop() { $("pop").hidden = true; S.pop = null; }
function showPanel(p) {
  S.pop.panel = p;
  document.querySelectorAll(".ptab").forEach((b) => b.classList.toggle("on", b.dataset.p === p));
  document.querySelectorAll(".ppanel").forEach((d) => (d.hidden = d.dataset.p !== p));
  const t = currentTag(p); $("popRemove").hidden = !t;
  if (p === "mis") setTimeout(() => $("ipaHeard").focus(), 0);
}
function currentTag(p) {
  if (!S.pop) return null;
  const pos = S.pop.ws[S.pop.idxs[0]].position;
  if (p === "stress") return S.draft.word_issues.find((t) => t.type === "stress" && t.position === pos);
  if (p === "mis") return S.draft.word_issues.find((t) => t.type === "mispronunciation" && t.position === pos);
  const ps = S.pop.idxs.map((i) => S.pop.ws[i].position);
  return S.draft.word_issues.find((t) => t.type === "minor" && JSON.stringify(t.positions) === JSON.stringify(ps));
}
function markTabs() {
  ["stress", "mis", "minor"].forEach((p) => { const b = document.querySelector(`.ptab[data-p=${p}]`); b.innerHTML = b.textContent.replace(" ●", "") + (currentTag(p) ? ' <span class="dotmark">●</span>' : ""); });
}
function renderSyls() {
  const syls = S.pop.syllables;
  const row = (sel) => syls.length ? syls.map((x, i) => `<button data-i="${i}" class="${sel === i ? "on" : ""}">${esc(x)}</button>`).join("") : `<span class="muted">Type the syllables above</span>`;
  $("sylHeard").innerHTML = row(S.pop.heard);
  $("sylCorrect").innerHTML = row(S.pop.correct);
}
function savePop() {
  const p = S.pop.panel, ws = S.pop.ws, w = ws[S.pop.idxs[0]];
  const old = currentTag(p);
  let tag = null;
  if (p === "stress") {
    if (!S.pop.syllables.length || S.pop.heard == null || S.pop.correct == null) { toast("Pick the stressed syllable in both rows"); return; }
    tag = { type: "stress", word: w.text, position: w.position, syllables: S.pop.syllables.slice(), heard: S.pop.heard, correct: S.pop.correct, comment: $("stressComment").value.trim() };
  } else if (p === "mis") {
    const h = $("ipaHeard").value.trim(), e = $("ipaExpected").value.trim();
    if (!h || !e) { toast("Fill in both IPA fields"); return; }
    tag = { type: "mispronunciation", word: w.text, position: w.position, ipa_heard: h, ipa_expected: e, comment: $("misComment").value.trim() };
  } else {
    const tags = [...document.querySelectorAll("#minorChips .chip.on")].map((b) => b.dataset.x), cm = $("minorComment").value.trim();
    if (!tags.length && !cm) { toast("Pick a tag or write a comment"); return; }
    tag = { type: "minor", words: S.pop.idxs.map((i) => ws[i].text), positions: S.pop.idxs.map((i) => ws[i].position), tags, comment: cm };
  }
  if (old) S.draft.word_issues[S.draft.word_issues.indexOf(old)] = tag; else S.draft.word_issues.push(tag);
  // Helper only: a stress or pronunciation detail on an unjudged clip marks it Fail with the matching category.
  const cat = (C.tag_reasons || {})[tag.type];
  if (cat && S.draft.verdict !== "pass") { S.draft.verdict = "fail"; if (!S.draft.fail_reasons.includes(cat)) S.draft.fail_reasons.push(cat); }
  S.sel = []; closePop(); touch(); renderWords();
}
function removeTag() {
  const t = currentTag(S.pop.panel);
  if (t) S.draft.word_issues.splice(S.draft.word_issues.indexOf(t), 1);
  S.sel = []; closePop(); touch(); renderWords();
}
let lastIpa = null;
function insertIpa(sym) {
  const el = lastIpa || $("ipaHeard");
  const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, a) + sym + el.value.slice(b);
  el.focus(); el.setSelectionRange(a + sym.length, a + sym.length);
}

// ---------- IPA help drawer ----------
function symInfo(sym) { return (L.symbols || []).find((x) => x.symbol === sym); }
function symTip(x) {
  if (!x) return "";
  return [x.symbol + (x.letters ? "  " + x.letters : ""), x.sounds_like, x.example, x.common_errors?.length ? "Often wrongly: " + x.common_errors.join("; ") : ""].filter(Boolean).join("\n");
}
function renderIpaList() {
  const q = $("ipaSearch").value.trim().toLowerCase();
  const xs = (L.symbols || []).filter((x) => !q || JSON.stringify(x).toLowerCase().includes(q));
  $("ipaList").innerHTML = xs.map((x) => `<div class="ipa-e">${S.pop ? `<button class="ghost ins" data-s="${esc(x.symbol)}">Insert</button>` : ""}
      <span class="sym">${esc(x.symbol)}</span><span class="lt">${esc(x.letters || "")}</span> <span class="muted">${esc(x.kind || "")}</span>
      ${x.sounds_like ? `<div>${esc(x.sounds_like)}</div>` : ""}${x.example ? `<div class="ex">${esc(x.example)}</div>` : ""}
      ${x.common_errors?.length ? `<div class="err">Often wrongly: ${esc(x.common_errors.join("; "))}</div>` : ""}</div>`).join("") || `<div class="muted">No match.</div>`;
}
function openIpaHelp() { $("ipaDrawer").hidden = false; renderIpaList(); $("ipaSearch").focus(); }
function md(text) { // a small Markdown renderer for the cliff notes: headings, tables, lists, paragraphs, **bold**, *italic*, `code`
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\*([^*]+)\*/g, "<i>$1</i>");
  const out = []; let table = null, list = null;
  const flush = () => { if (table) { out.push(`<table>${table.join("")}</table>`); table = null; } if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; } };
  for (const line of text.split("\n")) {
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      (table ||= []).push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`); continue;
    }
    const li = line.match(/^\s*[-*] (.*)/);
    if (li) { if (table) flush(); (list ||= []).push(`<li>${inline(li[1])}</li>`); continue; }
    flush();
    const h = line.match(/^(#{1,4}) (.*)/);
    if (h) out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flush(); return out.join("");
}

// ---------- screen: save & navigate ----------
function screenValid(d) {
  if (cur().sid === "overall") return d.note.trim() ? null : "Write a note, or skip";
  if (!d.verdict) return "Pass or fail? (P / X)";
  if (d.verdict === "fail" && !d.fail_reasons.length) return "Why did it fail? Tap a category (1–" + (C.fail_reasons || []).length + ")";
  return null;
}
const hasContent = (d) => d.verdict || d.fail_reasons.length || d.word_issues.length || d.gender || Object.keys(d.scores).length || d.note.trim();
function saveScreen() {
  const c = cur(), m = runBy(c.run), d = S.draft;
  d.note = $("note").value;
  const err = screenValid(d);
  if (err) { toast(err, 2200); return false; }
  const row = { run: c.run, run_name: m.name, input: m.run?.input || null, sentence: c.sid,
    verdict: c.sid === "overall" ? "pass" : d.verdict, fail_reasons: d.fail_reasons, word_issues: d.word_issues, gender: d.gender,
    scores: qualityOn() ? d.scores : null, note: d.note.trim(), blind: isBlind(), source: "screen", client_id: LS("client"), annotator: C.annotator || null };
  queueRow("screen", row);
  applyScreenRow(Object.assign({ saved: "just now" }, row));
  S.dirty = false;
  toast(`${row.verdict === "fail" ? "Failed ✗" : "Passed ✓"}${isBlind() ? `  Voice ${letter(c.idx)} was ${m.name}` : ""}`, isBlind() ? 3500 : 1300);
  return true;
}
function go(delta, doSave) {
  S.draft.note = $("note").value;
  if (doSave && !S.draft.verdict && VN.done.has(key(cur().run, cur().sid))) { S.dirty = false; }
  else if (doSave) { if (!saveScreen()) return; }
  else if (S.dirty && hasContent(S.draft) && !screenValid(S.draft)) saveScreen();
  const nx = S.queue[S.pos + delta];
  if (nx && S.skipFailed && S.mode === "compare" && delta > 0 && nx.group !== cur().group) { // new sentence: drop voices failed so far
    buildQueue();
    const i = S.queue.findIndex((x) => x.group === nx.group);
    if (i >= 0) { openClip(i); return; }
  }
  if (S.pos + delta >= S.queue.length) { toast("That was the last clip 🎉 Next: 2 · Rank", 2500); renderClip(); return; }
  openClip(S.pos + delta);
}

// ---------- voice notes: spoken feedback per clip, uploaded at once, applied later by tools/apply_voice_notes.py ----------
const VN = { rec: null, chunks: [], t0: 0, ctx: null, done: new Set(), failed: null };
function vnCtx() {
  if (S.tab === "rank" && S.rank?.pair) { const p = S.rank.pair; return { pass: "rank", sentence: p.sid, left: p.left, right: p.right, blind: true }; }
  const c = cur(); if (!c) return null;
  const m = runBy(c.run);
  return { pass: "screen", run: c.run, run_name: isBlind() ? "" : m.name, sentence: c.sid, blind: isBlind() };
}
const vnKey = (x) => x && (x.pass === "rank" ? `rank|${x.sentence}|${x.left}|${x.right}` : key(x.run, x.sentence));
function renderVn() {
  const b = $("vnBtn"); if (!b) return;
  const ctx = vnCtx(), on = !!VN.rec;
  b.classList.toggle("rec", on);
  b.innerHTML = on ? "■ Stop and send <kbd>R</kbd>" : "🎙 Voice note <kbd>R</kbd>";
  $("vnState").textContent = on ? "Recording… say what you heard: pass or fail, why, which word." :
    VN.failed ? "Upload failed: press R twice to record again, or check the connection." :
    VN.done.has(vnKey(ctx)) ? "Voice note saved ✓ (transcribed and applied later)" : "";
}
async function vnToggle() {
  if (VN.rec) { VN.rec.stop(); return; }
  const ctx = vnCtx(); if (!ctx) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { toast("Microphone blocked: allow it for this page", 3000); return; }
  $("audio").pause();
  const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  VN.rec = rec; VN.chunks = []; VN.t0 = Date.now(); VN.ctx = ctx; VN.failed = null;
  rec.ondataavailable = (e) => e.data.size && VN.chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(VN.chunks, { type: rec.mimeType || "audio/webm" }), c = VN.ctx, secs = (Date.now() - VN.t0) / 1000;
    VN.rec = null; renderVn();
    if (secs < 0.6) { toast("Too short: hold R or tap again to stop", 1800); return; }
    const fd = new FormData();
    fd.append("audio", blob, "note");
    Object.entries(c).forEach(([k, v]) => fd.append(k, String(v)));
    fd.append("seconds", String(secs)); fd.append("client_id", LS("client") || ""); fd.append("annotator", C.annotator || "");
    try {
      const r = await fetch(`/api/voice/${encodeURIComponent(S.evalId)}`, { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      VN.done.add(vnKey(c)); toast("Voice note saved ✓", 1300); setTimeout(pollSync, 500);
    } catch (e) { VN.failed = c; toast("Voice note upload failed: " + String(e).slice(0, 80), 4000); }
    renderVn();
  };
  rec.start(); renderVn();
}

// ---------- rank: adaptive play-off per sentence ----------
const passing = (sid) => runs().filter((m) => m.clips[sid] && S.screen.get(key(m.slug, sid))?.verdict === "pass").map((m) => m.slug);
const pairId = (sid, a, b) => [sid, ...[a, b].sort()].join("|");
function votes() { // valid comparisons: not undone; latest per row id
  const undone = new Set(S.pairs.filter((p) => p.type === "undo").map((p) => p.target));
  return S.pairs.filter((p) => p.type !== "undo" && !undone.has(p.id));
}
function sentVotes(sid, items) {
  const set = new Set(items);
  return votes().filter((v) => v.sentence === sid && v.outcome !== "both_bad" && set.has(v.left) && set.has(v.right));
}
function sides(sid, a, b) { return rng(pairId(sid, a, b))() < 0.5 ? [a, b] : [b, a]; }
// Returns {status, pairs (pending, in order), leader, unbeaten, total, done}. Rules (pairwise-eval run-playoff):
// opening round where every survivor plays once (an odd one twice); out = any head-to-head loss; leader = the unbeaten
// item with most wins (Bradley-Terry breaks ties); next = leader vs every unbeaten item it hasn't met; a draw between
// unbeaten finalists gets one tie-break rematch. `pairing: "all"` serves every pair instead.
function schedule(sid) {
  const items = passing(sid), vs = sentVotes(sid, items);
  const met = new Map(); vs.forEach((v) => { const k = pairId(sid, v.left, v.right); met.set(k, (met.get(k) || 0) + 1); });
  const res = { items, done: vs.length, pairs: [], status: "open", leader: null, unbeaten: items.slice() };
  if (items.length < 2) { res.status = items.length ? "single" : "empty"; res.leader = items[0] || null; return res; }
  if ((C.rank?.pairing || "playoff") === "all") {
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (!met.has(pairId(sid, items[i], items[j]))) res.pairs.push(sides(sid, items[i], items[j]));
    res.status = res.pairs.length ? "voting" : "done"; res.total = res.done + res.pairs.length; return res;
  }
  // opening round
  const order = shuffled(items, S.evalId + sid + "open"), opening = [];
  for (let i = 0; i < order.length; i += 2) opening.push([order[i], order[(i + 1) % order.length]]);
  const pendingOpen = opening.filter(([a, b]) => a !== b && !met.has(pairId(sid, a, b)));
  if (pendingOpen.length) { res.status = "opening"; res.pairs = pendingOpen.map(([a, b]) => sides(sid, a, b)); res.total = res.done + res.pairs.length; return res; }
  const wins = {}, losses = {}; items.forEach((x) => { wins[x] = 0; losses[x] = 0; });
  vs.forEach((v) => { if (v.outcome === "left") { wins[v.left]++; losses[v.right]++; } else if (v.outcome === "right") { wins[v.right]++; losses[v.left]++; } });
  const unbeaten = items.filter((x) => !losses[x]);
  res.unbeaten = unbeaten;
  if (!unbeaten.length) { res.status = "cycle"; res.leader = btFit(vs, items).order[0]; res.total = res.done; return res; }
  const bt = btFit(vs, items).p;
  const leader = unbeaten.slice().sort((a, b) => wins[b] - wins[a] || (bt[b] || 0) - (bt[a] || 0))[0];
  res.leader = leader;
  const unmet = unbeaten.filter((x) => x !== leader && !met.has(pairId(sid, leader, x)));
  if (unmet.length) { res.status = "playoff"; res.pairs = unmet.map((x) => sides(sid, leader, x)); res.total = res.done + res.pairs.length; return res; }
  if (unbeaten.length === 1) { res.status = "decided"; res.total = res.done; return res; }
  const rival = unbeaten.find((x) => x !== leader); // unbeaten finalists that drew
  if ((met.get(pairId(sid, leader, rival)) || 0) < 2) { res.status = "tiebreak"; res.pairs = [sides(sid, rival, leader)]; res.total = res.done + 1; return res; }
  res.status = "tie"; res.total = res.done; return res;
}
// Bradley-Terry by minorization-maximization; a tie counts half a win to each side; a small symmetric prior keeps
// unbeaten or winless items finite. Returns strengths p (geometric mean 1) and the order.
function btFit(vs, items) {
  const ids = items.filter((x) => vs.some((v) => v.left === x || v.right === x));
  const W = {}, N = {}; ids.forEach((i) => { W[i] = 0; N[i] = {}; ids.forEach((j) => (N[i][j] = 0)); });
  const prior = 0.1;
  for (const v of vs) {
    if (!(v.left in W) || !(v.right in W)) continue;
    const s = v.outcome === "left" ? 1 : v.outcome === "right" ? 0 : 0.5;
    W[v.left] += s; W[v.right] += 1 - s; N[v.left][v.right]++; N[v.right][v.left]++;
  }
  ids.forEach((i) => ids.forEach((j) => { if (i !== j && N[i][j]) { W[i] += prior; N[i][j] += 2 * prior; } }));
  let p = Object.fromEntries(ids.map((i) => [i, 1]));
  for (let it = 0; it < 300; it++) {
    const q = {};
    for (const i of ids) { let den = 0; for (const j of ids) if (i !== j && N[i][j]) den += N[i][j] / (p[i] + p[j]); q[i] = den ? W[i] / den : p[i]; }
    const g = Math.exp(ids.reduce((a, i) => a + Math.log(Math.max(q[i], 1e-9)), 0) / (ids.length || 1));
    ids.forEach((i) => (q[i] = Math.max(q[i], 1e-9) / g)); p = q;
  }
  return { p, order: ids.slice().sort((a, b) => p[b] - p[a]) };
}
function rankSentences() { return S.data.sentences.map((s) => s.id).filter((sid) => passing(sid).length >= 2); }
function nextRankSentence(from) {
  const ss = rankSentences(), start = Math.max(0, ss.indexOf(from));
  for (let k = 0; k < ss.length; k++) { const sid = ss[(start + k) % ss.length]; if (schedule(sid).pairs.length) return sid; }
  return null;
}
function openRank(sid) {
  S.rank.sid = sid || nextRankSentence(S.rank.sid) || null;
  S.rank.choice = null; $("rNote").value = "";
  ["playL", "playR"].forEach((id) => (S.rank[id] = null));
  $("audio").pause();
  renderRank();
}
const STATUS = { opening: "Opening round", playoff: "Play-off: the leader against each unbeaten challenger", tiebreak: "Tie-break between unbeaten finalists",
  decided: "Decided", tie: "Tie between unbeaten finalists (Bradley–Terry decides)", cycle: "Cycle: every voice has a loss (Bradley–Terry decides)",
  voting: "All pairs", done: "All pairs voted", empty: "No clip passed the screen yet", single: "Only one clip passed: nothing to compare" };
function renderRank() {
  const ss = rankSentences();
  const all = ss.map((sid) => schedule(sid));
  const pend = all.reduce((a, x) => a + x.pairs.length, 0), done = all.reduce((a, x) => a + x.done, 0);
  $("rankFill").style.width = (done + pend ? 100 * done / (done + pend) : 0) + "%";
  $("rankPick").innerHTML = ss.map((sid, i) => `<option value="${esc(sid)}" ${sid === S.rank.sid ? "selected" : ""}>${esc(sid)} · ${esc(STATUS[all[i].status] || all[i].status)}${all[i].pairs.length ? ` (${all[i].pairs.length} to vote)` : ""}</option>`).join("");
  const sid = S.rank.sid;
  if (!sid) {
    $("rankBody").hidden = true; $("rankEmpty").hidden = false;
    $("rankEmpty").textContent = ss.length ? `Every sentence is decided (${done} comparisons). See Results.` : "No sentence has two passing clips yet: screen first (1 · Screen).";
    $("rankWhere").textContent = ""; return;
  }
  const sc = schedule(sid), pair = sc.pairs[0];
  $("rankWhere").innerHTML = `Sentence <b>${esc(sid)}</b> · ${esc(STATUS[sc.status] || sc.status)} · ${sc.done} voted here, ${sc.pairs.length} to go · ${done} of ${done + pend} overall`;
  const s = sentBy(sid);
  $("rFocus").textContent = [s.id, s.focus].filter(Boolean).join(" · ");
  $("rText").textContent = field(s, "display") || s.text || "";
  $("rGloss").textContent = field(s, "gloss") || "";
  $("rankEmpty").hidden = !!pair; $("rankBody").hidden = !pair;
  if (!pair) { $("rankEmpty").textContent = `${STATUS[sc.status]}. Pick another sentence, or see Results.`; return; }
  S.rank.pair = { sid, left: pair[0], right: pair[1], status: sc.status };
  document.querySelectorAll("#outcomes button").forEach((b) => b.classList.toggle("on", b.dataset.o === S.rank.choice));
  document.querySelectorAll(".side").forEach((el) => {
    const side = el.dataset.side, ch = S.rank.choice;
    el.classList.toggle("chosen", (ch === "left" && side === "left") || (ch === "right" && side === "right"));
    el.classList.toggle("tie", ch === "tie"); el.classList.toggle("bad", ch === "both_bad");
  });
  $("undo").disabled = !S.rank.history.length;
}
function playSide(side) {
  const p = S.rank.pair; if (!p) return;
  const run = side === "left" ? p.left : p.right, m = runBy(run), a = $("audio");
  const src = S.data.clip_base + m.clips[p.sid];
  if (S.rank.playing === side && !a.paused) { a.pause(); return; }
  a.src = src; a.play().catch(() => {}); S.rank.playing = side;
}
function confirmPair() {
  const p = S.rank.pair, o = S.rank.choice;
  if (!p) return;
  if (!o) { toast("Pick 1 A better, 2 B better, 3 tie or 4 both bad", 2000); return; }
  const note = $("rNote").value.trim();
  const row = { id: uid(), sentence: p.sid, pair: pairId(p.sid, p.left, p.right), left: p.left, right: p.right, outcome: o, note, stage: p.status, client_id: LS("client"), annotator: C.annotator || null };
  queueRow("pairs", row); S.pairs.push(row);
  const late = [];
  if (o === "both_bad") for (const run of [p.left, p.right]) { // both go back as late fails, with the reason
    const prev = S.screen.get(key(run, p.sid)), m = runBy(run);
    late.push(prev);
    const fail = { run, run_name: m.name, input: m.run?.input || null, sentence: p.sid, verdict: "fail", fail_reasons: [C.rank_reject_reason || "Rejected in ranking (both bad)"],
      word_issues: prev?.word_issues || [], gender: prev?.gender || null, scores: prev?.scores || null, note: note || prev?.note || "", blind: true, source: "rank", client_id: LS("client") };
    queueRow("screen", fail); applyScreenRow(Object.assign({ saved: "just now" }, fail));
  }
  S.rank.history.push({ id: row.id, late });
  toast(`Saved ✓  A was ${runBy(p.left).name}, B was ${runBy(p.right).name}`, 3500);
  openRank(p.sid);
}
function undoPair() {
  const h = S.rank.history.pop(); if (!h) return;
  queueRow("pairs", { type: "undo", target: h.id, client_id: LS("client") }); S.pairs.push({ type: "undo", target: h.id });
  for (const prev of h.late) if (prev) { const back = { ...prev, client_id: LS("client"), note: prev.note }; delete back.saved; delete back.eval_id; delete back.schema; queueRow("screen", back); applyScreenRow(Object.assign({ saved: "just now" }, back)); }
  toast("Undone", 1200); openRank(S.rank.sid);
}

// ---------- results ----------
const nameOf = (r) => runBy(r)?.name || r;
const rowsScreened = () => [...S.screen.values()].filter((n) => n.sentence !== "overall");
function renderResults() {
  if (!S.data) return;
  const ev = S.evals.find((e) => e.eval_id === S.evalId);
  $("resTitle").textContent = "Results · " + (ev?.title || S.evalId);
  // pass 1
  const rows = runs().map((m) => {
    const ns = rowsScreened().filter((n) => n.run === m.slug), fails = ns.filter((n) => n.verdict === "fail");
    const tags = fails.flatMap((n) => n.word_issues || []);
    const why = {}; fails.forEach((n) => (n.fail_reasons || []).forEach((r) => (why[r] = (why[r] || 0) + 1)));
    const st = tags.filter((t) => t.type === "stress").length, mp = tags.filter((t) => t.type === "mispronunciation").length;
    const wc = {}; tags.forEach((t) => [].concat(t.word || t.words || []).forEach((w) => (wc[w] = (wc[w] || 0) + 1)));
    const g = {}; ns.forEach((n) => n.gender && (g[n.gender] = (g[n.gender] || 0) + 1));
    return { name: m.name, input: m.run?.input, n: ns.length, pass: ns.length ? 100 * (ns.length - fails.length) / ns.length : null, fails: fails.length,
      stress: st, mis: mp, ...Object.fromEntries(Object.entries(why).map(([k, v]) => ["r:" + k, v])),
      words: Object.entries(wc).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, c]) => `${w} ×${c}`).join(", "),
      gender: Object.entries(g).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "), overall: S.screen.get(key(m.slug, "overall"))?.note || "" };
  }).filter((r) => r.n || r.overall);
  const cats = [...new Set([...(C.fail_reasons || []), ...rowsScreened().flatMap((n) => n.fail_reasons || [])])];
  const detail = rowsScreened().some((n) => (n.word_issues || []).length);
  rows.forEach((r) => cats.forEach((c) => (r["r:" + c] ??= 0)));
  const cols = [["name", "Voice"], ["n", "Screened"], ["pass", "Pass rate"], ["fails", "Fails"], ...cats.map((c) => ["r:" + c, c]),
    ...(detail ? [["stress", "Stress details"], ["mis", "Mispron. details"], ["words", "Most-failed words"]] : []), ["gender", "Gender"], ["overall", "Overall note"]];
  sortTable("byVoice", cols, rows, (c, v) => (c === "pass" ? (v == null ? "" : `${Math.round(v)}%<span class="sbar" style="width:${v / 2}px"></span>`) : null), ["n", "fails", "stress", "mis", ...cats.map((c) => "r:" + c)]);
  // pass 2
  const scope = $("btScope").value || "all";
  const vs = votes().filter((v) => v.outcome !== "both_bad" && (scope === "all" || v.sentence === scope));
  const fit = btFit(vs, runs().map((m) => m.slug));
  const rk = fit.order.map((slug, i) => {
    const mine = vs.filter((v) => v.left === slug || v.right === slug);
    const w = mine.filter((v) => (v.outcome === "left" && v.left === slug) || (v.outcome === "right" && v.right === slug)).length;
    const t = mine.filter((v) => v.outcome === "tie").length;
    return { rank: i + 1, name: nameOf(slug), n: mine.length, wtl: `${w} / ${t} / ${mine.length - w - t}`, rate: mine.length ? 100 * (w + t / 2) / mine.length : null, bt: fit.p[slug] };
  });
  $("btScope").innerHTML = `<option value="all">All sentences (${votes().filter((v) => v.outcome !== "both_bad").length} comparisons)</option>` +
    S.data.sentences.map((s) => `<option value="${esc(s.id)}" ${scope === s.id ? "selected" : ""}>${esc(s.id)} · ${esc(STATUS[schedule(s.id).status] || "")}</option>`).join("");
  $("byRank").innerHTML = `<thead><tr><th>#</th><th>Voice</th><th>Comparisons</th><th>W / T / L</th><th>Win rate</th><th>BT strength</th></tr></thead><tbody>` +
    (rk.map((r) => `<tr><td class="n">${r.rank}</td><td>${esc(r.name)}</td><td class="n">${r.n}</td><td class="n">${r.wtl}</td><td class="n">${r.rate == null ? "" : Math.round(r.rate) + "%"}</td>
      <td class="n">${r.bt.toFixed(2)}<span class="sbar" style="width:${Math.min(120, 30 * r.bt)}px"></span></td></tr>`).join("") || `<tr><td colspan="6" class="muted">No comparisons yet.</td></tr>`) + "</tbody>";
  // by sentence
  $("bySentence").innerHTML = `<thead><tr><th>ID</th><th>Sentence</th><th>Screened</th><th>Passed</th><th>Play-off</th><th>Winner</th><th>Most-failed words</th></tr></thead><tbody>` +
    S.data.sentences.map((s) => {
      const ns = rowsScreened().filter((n) => n.sentence === s.id), sc = schedule(s.id);
      const wc = {}; ns.filter((n) => n.verdict === "fail").flatMap((n) => n.word_issues || []).forEach((t) => [].concat(t.word || t.words || []).forEach((w) => (wc[w] = (wc[w] || 0) + 1)));
      const win = ["decided", "tie", "cycle", "single", "done"].includes(sc.status) && sc.leader ? nameOf(sc.leader) + ({ tie: " (BT)", cycle: " (BT)", single: " (only pass)" }[sc.status] || "") : "";
      return `<tr><td>${esc(s.id)}</td><td>${esc(field(s, "gloss") || field(s, "display") || "")}</td><td class="n">${ns.length}</td><td class="n">${ns.filter((n) => n.verdict === "pass").length}</td>
        <td>${esc(STATUS[sc.status] || sc.status)} · ${sc.done} votes</td><td>${esc(win)}</td><td ${C.rtl ? 'dir="rtl"' : ""}>${esc(Object.entries(wc).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, c]) => `${w} ×${c}`).join(", "))}</td></tr>`;
    }).join("") + "</tbody>";
  // optional quality
  $("qualityWrap").hidden = !qualityOn();
  if (qualityOn()) {
    $("byQuality").innerHTML = `<thead><tr><th>Voice</th>${qAxes().map((a) => `<th>${esc(a.short || a.label)}</th>`).join("")}</tr></thead><tbody>` +
      runs().map((m) => { const ns = rowsScreened().filter((n) => n.run === m.slug && n.scores); if (!ns.length) return "";
        return `<tr><td>${esc(m.name)}</td>${qAxes().map((a) => { const vals = ns.map((n) => n.scores[a.key]).filter((v) => v != null);
          if (isScale(a)) return `<td class="n">${vals.length ? (vals.reduce((x, y) => x + Number(y), 0) / vals.length).toFixed(2) : ""}</td>`;
          if (a.type === "binary") return `<td class="n">${vals.length ? Math.round(100 * vals.filter((v) => v === "yes").length / vals.length) + "% yes" : ""}</td>`;
          return `<td>${axisOptions(a).map((o) => `${esc(o.label)} ${vals.filter((v) => v === o.v).length}`).join(" · ")}</td>`; }).join("")}</tr>`; }).join("") + "</tbody>";
  }
}
function sortTable(id, cols, rows, fmt, ints) {
  const { k, d } = S.sort;
  rows.sort((a, b) => ((a[k] ?? -1) > (b[k] ?? -1) ? 1 : (a[k] ?? -1) < (b[k] ?? -1) ? -1 : 0) * d);
  $(id).innerHTML = `<thead><tr>${cols.map(([c, l]) => `<th data-k="${c}">${esc(l)}${k === c ? (d > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>` +
    (rows.map((r) => `<tr>${cols.map(([c]) => { const f = fmt(c, r[c]); if (f != null) return `<td class="n">${f}</td>`;
      if (ints.includes(c)) return `<td class="n">${r[c]}</td>`;
      return `<td>${esc(r[c])}${c === "name" && r.input ? `<div class="muted">input: ${esc(r.input)}</div>` : ""}</td>`; }).join("")}</tr>`).join("")
      || `<tr><td colspan="${cols.length}" class="muted">Nothing screened yet.</td></tr>`) + "</tbody>";
  document.querySelectorAll(`#${id} th`).forEach((th) => th.addEventListener("click", () => { S.sort = { k: th.dataset.k, d: S.sort.k === th.dataset.k ? -S.sort.d : -1 }; renderResults(); }));
}
function download(name, text, type) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); }
function csvCell(v) { const s = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

// ---------- tabs, toast ----------
function tab(t) {
  ["start", "rate", "rank", "results"].forEach((x) => ($(x).hidden = x !== t));
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  document.querySelector("main").classList.toggle("wide", t === "results");
  $("audio").pause();
  S.tab = t;
  if (t === "results") renderResults();
  if (t === "rank") openRank(S.rank.sid);
}
let toastT;
function toast(msg, ms = 1500) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }

// ---------- events ----------
function start() {
  S.mode = document.querySelector("input[name=mode]:checked").value;
  S.blind = $("blind").checked; S.skipFailed = $("skipFailed").checked; S.voice = $("voicePick").value;
  S.round = $("roundPickWrap").hidden ? null : $("roundPick").value; LS("round", S.round);
  LS("eval", S.evalId); LS("mode", S.mode); LS("blind", S.blind); LS("skipFailed", S.skipFailed); LS("voice", S.voice);
  buildQueue();
  const saved = LS("pos." + S.evalId + "." + S.mode + (S.mode === "voice" ? "." + S.voice : ""));
  const firstOpen = S.queue.findIndex((x) => !S.screen.has(key(x.run, x.sid)));
  tab("rate"); openClip(saved != null ? saved : Math.max(0, firstOpen));
}
function wire() {
  $("go").addEventListener("click", async () => { if (!S.data) await loadEval(); start(); });
  document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", syncModeUi));
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", async () => {
    if (!S.data && b.dataset.tab !== "start") await loadEval();
    if (b.dataset.tab === "rate" && !S.queue.length) { start(); return; }
    tab(b.dataset.tab);
  }));
  $("play").addEventListener("click", () => { const a = $("audio"); a.paused ? a.play() : a.pause(); });
  ["play", "pause", "ended"].forEach((e) => $("audio").addEventListener(e, setPlayIcon));
  $("pf").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setResult(S.draft.verdict === b.dataset.v ? null : b.dataset.v); });
  $("reasons").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (!b) return; const r = b.dataset.r, d = S.draft;
    d.fail_reasons = d.fail_reasons.includes(r) ? d.fail_reasons.filter((x) => x !== r) : [...d.fail_reasons, r]; touch(); renderVerdict(); });
  $("gender").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.draft.gender = S.draft.gender === b.dataset.v ? null : b.dataset.v; S.prefilled = false; touch(); renderVerdict(); });
  $("ratings").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]"), row = e.target.closest(".axis");
    if (row) { const si = scaleAxes().findIndex((a) => a.key === row.dataset.key); if (si >= 0) S.axis = si; }
    if (b) { const a = qAxes().find((x) => x.key === b.dataset.key), v = isScale(a) ? Number(b.dataset.v) : b.dataset.v;
      setScore(a.key, S.draft.scores[a.key] === v ? null : v); if (isScale(a)) S.axis = Math.min(scaleAxes().length - 1, scaleAxes().indexOf(a) + 1); }
    renderRatings();
  });
  $("note").addEventListener("input", () => { S.draft.note = $("note").value; touch(); });
  $("words").addEventListener("click", (e) => {
    const b = e.target.closest(".w"); if (!b) return;
    const i = Number(b.dataset.i);
    if (e.shiftKey || S.multi) { S.sel = S.sel.includes(i) ? S.sel.filter((x) => x !== i) : [...S.sel, i]; renderWords(); return; }
    $("detail").open = true;
    S.sel = [i]; renderWords(); openPop([i], document.querySelector(`.w[data-i="${i}"]`));
  });
  $("multiBtn").addEventListener("click", () => { S.multi = !S.multi; if (!S.multi) S.sel = []; renderWords(); });
  $("tagSel").addEventListener("click", () => openPop(S.sel.slice().sort((a, b) => a - b), $("tagSel")));
  document.querySelectorAll(".ptab").forEach((b) => b.addEventListener("click", () => showPanel(b.dataset.p)));
  $("sylInput").addEventListener("input", () => {
    S.pop.syllables = $("sylInput").value.split(/[-·.\s]+/).map((x) => x.trim()).filter(Boolean);
    if (S.pop.heard >= S.pop.syllables.length) S.pop.heard = null;
    if (S.pop.correct >= S.pop.syllables.length) S.pop.correct = null;
    renderSyls();
  });
  $("sylHeard").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { S.pop.heard = Number(b.dataset.i); renderSyls(); } });
  $("sylCorrect").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { S.pop.correct = Number(b.dataset.i); renderSyls(); } });
  ["ipaHeard", "ipaExpected"].forEach((id) => $(id).addEventListener("focus", () => (lastIpa = $(id))));
  $("keypad").addEventListener("mousedown", (e) => e.preventDefault());
  $("keypad").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) insertIpa(b.dataset.s); });
  $("minorChips").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) b.classList.toggle("on"); });
  $("popOk").addEventListener("click", savePop);
  $("popCancel").addEventListener("click", () => { S.sel = []; closePop(); renderWords(); });
  $("popRemove").addEventListener("click", removeTag);
  $("pop").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input")) { e.preventDefault(); savePop(); } });
  $("save").addEventListener("click", () => go(1, true));
  $("vnBtn").addEventListener("click", vnToggle);
  $("next").addEventListener("click", () => go(1, false));
  $("prev").addEventListener("click", () => go(-1, false));
  $("dots").addEventListener("click", (e) => { const b = e.target.closest(".dot"); if (b) go(Number(b.dataset.i) - S.pos, false); });
  $("groupPick").addEventListener("change", (e) => {
    if (S.mode === "compare") go(S.queue.findIndex((x) => x.sid === e.target.value) - S.pos, false);
    else { if (S.dirty && hasContent(S.draft) && !screenValid(S.draft)) saveScreen(); S.voice = e.target.value; LS("voice", S.voice); buildQueue(); openClip(0); }
  });
  // rank
  $("playL").addEventListener("click", () => playSide("left"));
  $("playR").addEventListener("click", () => playSide("right"));
  $("outcomes").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { S.rank.choice = b.dataset.o; renderRank(); } });
  $("confirm").addEventListener("click", confirmPair);
  $("undo").addEventListener("click", undoPair);
  $("rSkip").addEventListener("click", () => { const ss = rankSentences(); const i = ss.indexOf(S.rank.sid); openRank(nextRankSentence(ss[(i + 1) % ss.length]) || S.rank.sid); });
  $("rankPick").addEventListener("change", (e) => openRank(e.target.value));
  // results
  $("btScope").addEventListener("change", renderResults);
  $("helpBtn").addEventListener("click", () => ($("help").hidden = false));
  $("helpClose").addEventListener("click", () => ($("help").hidden = true));
  document.querySelectorAll(".ipahelp-open").forEach((b) => b.addEventListener("click", () => { $("help").hidden = true; openIpaHelp(); }));
  $("ipaDrawerClose").addEventListener("click", () => ($("ipaDrawer").hidden = true));
  $("ipaSearch").addEventListener("input", renderIpaList);
  $("ipaList").addEventListener("mousedown", (e) => e.target.closest(".ins") && e.preventDefault());
  $("ipaList").addEventListener("click", (e) => { const b = e.target.closest(".ins"); if (b) insertIpa(b.dataset.s); });
  const jsonl = (rows) => rows.map((n) => JSON.stringify({ eval_id: S.evalId, ...n })).join("\n") + "\n";
  $("dlJson").addEventListener("click", () => download(`${S.evalId}-screen.jsonl`, jsonl([...S.screen.values()]), "application/jsonl"));
  $("dlPairs").addEventListener("click", () => download(`${S.evalId}-pairs.jsonl`, jsonl(S.pairs), "application/jsonl"));
  $("dlCsv").addEventListener("click", () => {
    const cols = ["eval_id", "run", "run_name", "input", "sentence", "verdict", "fail_reasons", "word_issues", "gender", ...qAxes().map((a) => a.key), "note", "blind", "source", "saved"];
    const lines = [cols.join(",")].concat([...S.screen.values()].map((n) => cols.map((c) => csvCell(c === "eval_id" ? S.evalId : qAxes().some((a) => a.key === c) ? n.scores?.[c] : n[c])).join(",")));
    download(`${S.evalId}-screen.csv`, lines.join("\n"), "text/csv");
  });
  document.addEventListener("click", (e) => { if (!e.target.isConnected) return; /* re-rendered inside the popover */ if (!$("pop").hidden && !e.target.closest("#pop") && !e.target.closest(".w") && !e.target.closest("#tagSel") && !e.target.closest("#ipaDrawer")) closePop(); });
  window.addEventListener("beforeunload", () => { if (S.dirty && S.draft && hasContent(S.draft) && !screenValid(S.draft)) saveScreen(); });
  document.addEventListener("keydown", onKey);
}
function onKey(e) {
  if (e.key === "Escape") { if (!$("ipaDrawer").hidden) { $("ipaDrawer").hidden = true; return; } closePop(); $("help").hidden = true; return; }
  if (e.target.matches("textarea, input, select")) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.id === "note") { e.preventDefault(); go(1, true); }
    else if (e.key === "Enter" && e.target.id === "rNote") { e.preventDefault(); confirmPair(); }
    return;
  }
  if (e.key === "?") { $("help").hidden = !$("help").hidden; return; }
  if (!$("pop").hidden || !$("help").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (S.tab === "rate") {
    const sa = scaleAxes(), g = genderOpts().find((o) => o.k === k);
    let hit = null;
    if (e.key.length === 1) for (const a of qAxes()) if (!isScale(a)) for (const o of axisOptions(a)) if (o.key && o.key.toLowerCase() === k) hit = { a, o };
    if (e.key === " ") { e.preventDefault(); $("play").click(); }
    else if (k === "r") vnToggle();
    else if (k === "p") setResult("pass");
    else if (k === "x") setResult("fail");
    else if (g) { S.draft.gender = g.v; S.prefilled = false; touch(); renderVerdict(); }
    else if (hit) { setScore(hit.a.key, hit.o.v); renderRatings(); }
    else if (/^[1-9]$/.test(e.key) && S.draft.verdict === "fail" && (C.fail_reasons || [])[Number(e.key) - 1]) {
      const r = C.fail_reasons[Number(e.key) - 1], d = S.draft;
      d.fail_reasons = d.fail_reasons.includes(r) ? d.fail_reasons.filter((x) => x !== r) : [...d.fail_reasons, r]; touch(); renderVerdict(); }
    else if (/^[1-5]$/.test(e.key) && sa.length && $("detail").open) { setScore(sa[S.axis].key, Number(e.key)); S.axis = Math.min(sa.length - 1, S.axis + 1); renderRatings(); }
    else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && sa.length) { e.preventDefault(); S.axis = (S.axis + (e.key === "ArrowDown" ? 1 : sa.length - 1)) % sa.length; renderRatings(); }
    else if (e.key === "Enter") { e.preventDefault(); go(1, true); }
    else if (e.key === "ArrowRight") go(1, false);
    else if (e.key === "ArrowLeft") go(-1, false);
  } else if (S.tab === "rank") {
    const map = { 1: "left", 2: "right", 3: "tie", 4: "both_bad" };
    if (k === "r") vnToggle();
    else if (k === "a") playSide("left");
    else if (k === "b") playSide("right");
    else if (map[e.key]) { S.rank.choice = map[e.key]; renderRank(); }
    else if (e.key === "Enter") { e.preventDefault(); confirmPair(); }
    else if (k === "u") undoPair();
    else if (e.key === " ") { e.preventDefault(); $("audio").paused ? $("audio").play() : $("audio").pause(); }
  }
}

// ---------- boot ----------
(async function boot() {
  C = await api("config");
  if (C.annotator) $("annotatorName").textContent = "· annotator: " + C.annotator;
  document.title = C.title; $("appTitle").textContent = C.title;
  document.documentElement.lang = C.language || "en";
  document.body.classList.toggle("rtl", !!C.rtl);
  document.documentElement.style.setProperty("--lang-font", C.font_stack);
  $("localNote").hidden = !C.local_only;
  document.querySelector('.tab[data-tab="rank"]').hidden = C.passes?.rank === false;
  $("qualityHint").textContent = qualityOn() ? ", quality ratings" : "";
  L = await api("language");
  $("keypad").innerHTML = (L.keypad || []).map((s) => `<button data-s="${esc(s)}" title="${esc(symTip(symInfo(s)) || s)}">${esc(s)}</button>`).join("");
  $("ipaDrawerTitle").textContent = `IPA help · ${L.name || L.language || ""}`;
  $("ipaNotesWrap").hidden = !L.notes_md;
  if (L.notes_md) $("ipaNotes").innerHTML = md(L.notes_md);
  $("refNote").textContent = `Word references (IPA, syllables, stress) are labelled "${C.reference_label}". They are machine-made: correct them in the tag when they are wrong.`;
  $("axisKeyHelp").innerHTML = qAxes().filter((a) => !isScale(a)).map((a) => `<tr><td>${axisOptions(a).filter((o) => o.key).map((o) => `<kbd>${esc(o.key.toUpperCase())}</kbd>`).join(" ")}</td><td>${esc(a.label)}</td></tr>`).join("");
  if (!LS("client")) LS("client", Math.random().toString(36).slice(2, 10));
  wire();
  const m = LS("mode"); if (m) document.querySelector(`input[name=mode][value=${m}]`).checked = true;
  const b = LS("blind"); if (b != null) $("blind").checked = b;
  const sf = LS("skipFailed"); if (sf != null) $("skipFailed").checked = sf;
  S.voice = LS("voice");
  syncModeUi(); renderOutbox(); tab("start");
  try { await loadEvals(); if (S.evalId) await loadEval(); } catch (e) { $("evalList").innerHTML = `<div class="banner">Couldn't load: ${esc(e.message)}</div>`; }
  flush();
})();
