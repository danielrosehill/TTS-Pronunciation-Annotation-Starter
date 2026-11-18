/* TTS pronunciation annotation: the single-page app.
   Data flow: /api/config -> /api/evals -> pick one -> /api/eval/<id> (clip manifest) and /api/annotations/<id> (latest
   row per run x sentence) -> annotate -> POST /api/annotations/<id>. Every save goes through a localStorage outbox
   first, so a failed upload is shown and retried, never lost. Word tags are structured: stress (heard vs correct
   syllable), mispronunciation (IPA heard vs expected) and minor tags. Schema: schema/annotation.schema.json. */
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const PUNCT = /^[.,!?:;"'()־׳״،؟]+|[.,!?:;"'()־׳״،؟]+$/g;
const LS = (k, v) => (v === undefined ? JSON.parse(localStorage.getItem("tpa." + k) || "null") : localStorage.setItem("tpa." + k, JSON.stringify(v)));

let C = {}; // config from /api/config
let L = { keypad: [], symbols: [] }; // language pack from /api/language
const S = { evals: [], evalId: null, data: null, notes: new Map(), mode: "compare", blind: true, voice: null, queue: [], pos: 0,
  draft: null, dirty: false, axis: 0, sel: [], multi: false, sort: { k: "mean", d: -1 }, tab: "start", pop: null };
const key = (run, sid) => run + "|" + sid;
const runs = () => S.data.models;
const runBy = (slug) => S.data.models.find((m) => m.slug === slug);
const sentBy = (sid) => S.data.sentences.find((s) => s.id === sid);
const field = (s, k) => (C.fields?.[k] ? s[C.fields[k]] : null);
// Axes (config `axes`): type "scale" (1-5, keys 1-5 on the highlighted row), "binary" (stored "yes" / "no") or
// "choice" (stored as the option text). Binary and choice options carry their own keyboard keys.
function axisOptions(a) {
  if (a.type === "binary") {
    const lab = a.labels || {}, keys = a.keys || {};
    return [{ v: "yes", label: lab.yes || "Yes", key: keys.yes || null }, { v: "no", label: lab.no || "No", key: keys.no || null }];
  }
  if (a.type === "choice") return (a.options || []).map((o) => ({ v: o, label: o, key: (a.keys || {})[o] ?? o[0].toLowerCase() }));
  return [1, 2, 3, 4, 5].map((v) => ({ v, label: String(v), key: null }));
}
const isScale = (a) => (a.type || "scale") === "scale";
const scaleAxes = () => C.axes.filter(isScale);

// ---------- seeded shuffle ----------
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function shuffled(arr, seed) {
  let a = hash(seed); const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = arr.slice(); for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out;
}
async function api(path, opts) { const r = await fetch("/api/" + path, opts); if (!r.ok) throw new Error((await r.text()).slice(0, 200) || r.status); return r.json(); }

// ---------- outbox ----------
const outbox = () => LS("outbox") || [];
function setOutbox(o) { LS("outbox", o); renderOutbox(); }
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
      const res = await fetch("/api/annotations/" + item.eval_id, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.row) });
      if (!res.ok) throw new Error("save failed (" + res.status + ")");
      setOutbox(outbox().filter((x) => x.id !== item.id));
    }
  } catch (e) { renderOutbox(); toast("Couldn't save: " + e.message + ". Kept on this device; it will retry.", 5000); }
  finally { flushing = false; }
}
setInterval(() => outbox().length && flush(), 30000);

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
      <span class="meta">${esc(e.date || "")}${e.n_clips != null ? ` · ${e.n_rated || 0} of ${e.n_clips} clips rated` : " · " + esc(e.error || "")}</span>
      <div class="prog"><div style="width:${pct}%"></div></div></button>`;
  }).join("") || `<div class="muted">No evaluations configured. Set evals_registry or manifest_url (see README).</div>`;
  document.querySelectorAll(".eval").forEach((b) => b.addEventListener("click", async () => { S.evalId = b.dataset.id; renderEvals(); await loadEval(); }));
}
async function loadEval() {
  S.data = await api("eval/" + S.evalId);
  const ns = await api("annotations/" + S.evalId);
  S.notes = new Map(ns.map((n) => [key(n.run, n.sentence), n]));
  for (const item of outbox()) if (item.eval_id === S.evalId) S.notes.set(key(item.row.run, item.row.sentence), item.row);
  $("voicePick").innerHTML = runs().map((m) => `<option value="${esc(m.slug)}">${esc(m.name)}</option>`).join("");
  if (S.voice && runBy(S.voice)) $("voicePick").value = S.voice;
}
function syncModeUi() {
  const m = document.querySelector("input[name=mode]:checked").value;
  $("voicePickWrap").hidden = m !== "voice";
  $("blind").closest("label").hidden = m !== "compare";
}

// ---------- queue ----------
function buildQueue() {
  const q = [];
  if (S.mode === "compare") {
    for (const s of S.data.sentences) {
      let rs = runs().filter((m) => m.clips[s.id]).map((m) => m.slug);
      if (S.blind) rs = shuffled(rs, S.evalId + s.id);
      rs.forEach((r, i) => q.push({ run: r, sid: s.id, group: s.id, idx: i, of: rs.length }));
    }
  } else {
    const m = runBy(S.voice) || runs()[0]; S.voice = m.slug;
    const ss = S.data.sentences.filter((s) => m.clips[s.id]);
    ss.forEach((s, i) => q.push({ run: m.slug, sid: s.id, group: m.slug, idx: i, of: ss.length + 1 }));
    q.push({ run: m.slug, sid: "overall", group: m.slug, idx: ss.length, of: ss.length + 1 });
  }
  S.queue = q;
}
const cur = () => S.queue[S.pos];
const letter = (i) => (i < 26 ? String.fromCharCode(65 + i) : "V" + (i + 1));
const isBlind = () => S.mode === "compare" && S.blind;
const voiceLabel = (c) => (isBlind() ? `Voice ${letter(c.idx)}` : runBy(c.run).name);
function voiceSub(c) {
  if (isBlind()) return "Name hidden until you save";
  const inp = runBy(c.run).run?.input;
  return inp ? `Input: ${inp}` : "";
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

// ---------- rate screen ----------
function blankDraft() { return { scores: {}, note: "", word_tags: [] }; }
function openClip(pos, play = true) {
  S.pos = Math.max(0, Math.min(S.queue.length - 1, pos));
  const c = cur(), n = S.notes.get(key(c.run, c.sid));
  S.draft = n ? { scores: { ...(n.scores || {}) }, note: n.note || "", word_tags: JSON.parse(JSON.stringify(n.word_tags || [])) } : blankDraft();
  S.dirty = false; S.axis = 0; S.sel = []; closePop();
  LS("pos." + S.evalId + "." + S.mode + (S.mode === "voice" ? "." + S.voice : ""), S.pos);
  renderClip();
  const a = $("audio"), m = runBy(c.run);
  a.pause();
  if (c.sid !== "overall" && m.clips[c.sid]) { a.src = S.data.clip_base + m.clips[c.sid]; if (play) a.play().catch(() => {}); }
  else a.removeAttribute("src");
}
function renderClip() {
  const c = cur(), s = sentBy(c.sid), overall = c.sid === "overall";
  const group = S.queue.filter((x) => x.group === c.group);
  const rated = S.queue.filter((x) => S.notes.has(key(x.run, x.sid))).length;
  $("whereText").innerHTML = S.mode === "compare"
    ? `Sentence <b>${esc(c.sid)}</b> of ${S.data.sentences.length} · voice <b>${c.idx + 1}</b> of ${c.of} · ${rated} of ${S.queue.length} rated`
    : `<b>${esc(runBy(c.run).name)}</b> · ${overall ? "overall note" : `sentence <b>${c.idx + 1}</b> of ${c.of - 1}`} · ${rated} of ${S.queue.length} rated`;
  $("groupPick").innerHTML = S.mode === "compare"
    ? S.data.sentences.map((x) => `<option value="${esc(x.id)}" ${x.id === c.sid ? "selected" : ""}>${esc(x.id)} · ${esc(String(field(x, "gloss") || field(x, "display") || "").slice(0, 48))}</option>`).join("")
    : runs().map((m) => `<option value="${esc(m.slug)}" ${m.slug === c.run ? "selected" : ""}>${esc(m.name)}</option>`).join("");
  $("dots").innerHTML = group.map((x) => {
    const i = S.queue.indexOf(x), done = S.notes.has(key(x.run, x.sid));
    const lab = S.mode === "compare" ? (isBlind() ? letter(x.idx) : x.idx + 1) : (x.sid === "overall" ? "★" : x.idx + 1);
    return `<button class="dot ${done ? "done" : ""} ${i === S.pos ? "cur" : ""}" data-i="${i}">${lab}</button>`;
  }).join("");
  $("barFill").style.width = (100 * rated / S.queue.length) + "%";
  document.querySelector(".sentence").hidden = overall;
  document.querySelector(".player").style.display = overall ? "none" : "";
  if (!overall) {
    $("focus").textContent = [s.id, s.focus].filter(Boolean).join(" · ");
    const sec = field(s, "secondary"); $("plain").textContent = sec || ""; $("plain").hidden = !sec;
    $("gloss").textContent = field(s, "gloss") || "";
    renderWords();
  }
  $("voiceName").textContent = overall ? `${runBy(c.run).name}: overall` : voiceLabel(c);
  $("voiceSub").textContent = overall ? "A note on this voice as a whole" : voiceSub(c);
  renderRatings();
  $("note").value = S.draft.note;
  renderState(); setPlayIcon();
}
const tagsAt = (pos) => S.draft.word_tags.filter((t) => (t.position === pos) || (t.positions || []).includes(pos));
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
  $("tagList").innerHTML = S.draft.word_tags.map((t, i) => {
    if (t.type === "stress") return `<div class="t"><span class="k s">Stress</span><span class="ww">${esc(t.word)}</span> heard <b>${esc(sylDisplay(t.syllables, t.heard))}</b>, should be <b>${esc(sylDisplay(t.syllables, t.correct))}</b>${t.comment ? ` · ${esc(t.comment)}` : ""}</div>`;
    if (t.type === "mispronunciation") return `<div class="t"><span class="k p">Pron.</span><span class="ww">${esc(t.word)}</span> heard <span class="ipa-t">/${esc(t.ipa_heard)}/</span>, expected <span class="ipa-t">/${esc(t.ipa_expected)}/</span>${t.comment ? ` · ${esc(t.comment)}` : ""}</div>`;
    return `<div class="t"><span class="k">${esc(t.tags.join(", ") || "Note")}</span><span class="ww">${esc(t.words.join(" "))}</span>${t.comment ? ` · ${esc(t.comment)}` : ""}</div>`;
  }).join("");
}
function renderRatings() {
  const hl = scaleAxes()[S.axis]?.key;
  $("ratings").innerHTML = C.axes.map((a) => {
    const opts = axisOptions(a), cur = S.draft.scores[a.key];
    const keys = isScale(a) ? "" : opts.filter((o) => o.key).map((o) => `<kbd>${esc(o.key.toUpperCase())}</kbd>`).join(" ");
    return `<div class="axis ${a.key === hl ? "hl" : ""} t-${a.type || "scale"}" data-key="${esc(a.key)}">
      <div class="axis-label">${esc(a.label)} ${keys} <span class="hint">${esc(a.hint || "")}</span></div>
      <div class="seg ${isScale(a) ? "" : "use"}">${opts.map((o, i) => `<button data-key="${esc(a.key)}" data-v="${esc(o.v)}" data-rank="${i === 0 ? "first" : i === opts.length - 1 ? "last" : "mid"}" class="${cur === o.v ? "on" : ""}">${esc(o.label)}</button>`).join("")}</div></div>`;
  }).join("");
}
function renderState() {
  const c = cur(), n = S.notes.get(key(c.run, c.sid));
  $("state").textContent = S.dirty ? "Unsaved changes" : n ? `Saved ${n.saved || "on this device"}` : "Not rated yet";
}
function setPlayIcon() { const p = !$("audio").paused; $("play").textContent = p ? "❚❚" : "▶"; $("play").classList.toggle("playing", p); }
function touch() { S.dirty = true; renderState(); }
function setScore(k, v) { if (v == null) delete S.draft.scores[k]; else S.draft.scores[k] = v; touch(); }

// ---------- word popover ----------
function openPop(idxs, anchor) {
  const ws = words(sentBy(cur().sid)), span = idxs.length > 1;
  const w = ws[idxs[0]];
  const tags = span ? [] : tagsAt(w.position);
  const st = tags.find((t) => t.type === "stress"), mp = tags.find((t) => t.type === "mispronunciation");
  const mn = S.draft.word_tags.find((t) => t.type === "minor" && JSON.stringify(t.positions) === JSON.stringify(idxs.map((i) => ws[i].position)));
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
  if (p === "stress") return S.draft.word_tags.find((t) => t.type === "stress" && t.position === pos);
  if (p === "mis") return S.draft.word_tags.find((t) => t.type === "mispronunciation" && t.position === pos);
  const ps = S.pop.idxs.map((i) => S.pop.ws[i].position);
  return S.draft.word_tags.find((t) => t.type === "minor" && JSON.stringify(t.positions) === JSON.stringify(ps));
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
  if (old) S.draft.word_tags[S.draft.word_tags.indexOf(old)] = tag; else S.draft.word_tags.push(tag);
  S.sel = []; closePop(); touch(); renderWords();
}
function removeTag() {
  const t = currentTag(S.pop.panel);
  if (t) S.draft.word_tags.splice(S.draft.word_tags.indexOf(t), 1);
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

// ---------- save & navigate ----------
const hasContent = (d) => Object.keys(d.scores).length || d.note.trim() || d.word_tags.length;
function save() {
  const c = cur(), m = runBy(c.run);
  S.draft.note = $("note").value;
  if (!hasContent(S.draft)) return false;
  const row = { run: c.run, run_name: m.name, input: m.run?.input || null, sentence: c.sid, scores: S.draft.scores,
    word_tags: S.draft.word_tags, note: S.draft.note.trim(), blind: isBlind(), client_id: LS("client") };
  setOutbox([...outbox(), { id: Date.now() + Math.random().toString(36).slice(2), eval_id: S.evalId, row }]);
  S.notes.set(key(c.run, c.sid), Object.assign({ saved: "just now" }, row));
  S.dirty = false;
  toast(isBlind() ? `Saved ✓  Voice ${letter(c.idx)} was ${m.name}` : "Saved ✓", isBlind() ? 3500 : 1400);
  flush();
  return true;
}
function go(delta, doSave) {
  S.draft.note = $("note").value;
  if (doSave) { if (!save() && delta > 0) toast("Nothing to save; skipped", 1200); }
  else if (S.dirty && hasContent(S.draft)) save();
  if (S.pos + delta >= S.queue.length) { toast("That was the last clip 🎉", 2500); renderClip(); return; }
  openClip(S.pos + delta);
}

// ---------- results ----------
const nameOf = (n) => runBy(n.run)?.name || n.run_name || n.run;
const rowsRated = () => [...S.notes.values()].filter((n) => n.sentence !== "overall");
function mean(xs) { const v = xs.filter((x) => x != null && !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
const f2 = (x) => (x == null ? "" : x.toFixed(2));
// Per-axis summary: scale -> mean; binary -> share of "yes" among judged clips; choice -> count of each option.
function axisSummary(a, ns) {
  const vals = ns.map((n) => n.scores?.[a.key]).filter((v) => v != null && v !== "");
  if (isScale(a)) return { sort: mean(vals.map(Number)), text: null };
  if (a.type === "binary") { const y = vals.filter((v) => v === "yes").length; const p = vals.length ? 100 * y / vals.length : null;
    return { sort: p, text: p == null ? "" : `${Math.round(p)}% yes (${y}/${vals.length})` }; }
  const opts = axisOptions(a);
  return { sort: vals.filter((v) => v === opts[0]?.v).length, text: opts.map((o) => `${o.label} ${vals.filter((v) => v === o.v).length}`).join(" · ") };
}
function renderResults() {
  if (!S.data) return;
  const ev = S.evals.find((e) => e.eval_id === S.evalId);
  $("resTitle").textContent = "Results · " + (ev?.title || S.evalId);
  const rows = runs().map((m) => {
    const ns = rowsRated().filter((n) => n.run === m.slug);
    const r = { name: m.name, input: m.run?.input, n: ns.length, _txt: {} };
    for (const a of C.axes) { const x = axisSummary(a, ns); r[a.key] = x.sort; if (x.text != null) r._txt[a.key] = x.text; }
    r.mean = mean(scaleAxes().map((a) => r[a.key]));
    const tags = ns.flatMap((n) => n.word_tags || []);
    const wc = {}; tags.forEach((t) => [].concat(t.word || t.words || []).forEach((w) => (wc[w] = (wc[w] || 0) + 1)));
    Object.assign(r, { stress: tags.filter((t) => t.type === "stress").length, mis: tags.filter((t) => t.type === "mispronunciation").length,
      minor: tags.filter((t) => t.type === "minor").length,
      words: Object.entries(wc).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, c]) => `${w} ×${c}`).join(", "),
      overall: S.notes.get(key(m.slug, "overall"))?.note || "" });
    return r;
  }).filter((r) => r.n || r.overall);
  const cols = [["name", "Voice"], ["n", "Clips"], ...C.axes.map((a) => [a.key, a.short || a.label]), ["mean", "Mean (scales)"],
    ["stress", "Stress errors"], ["mis", "Mispron."], ["minor", "Other tags"], ["words", "Most-tagged words"], ["overall", "Overall note"]];
  const { k, d } = S.sort;
  rows.sort((a, b) => ((a[k] ?? -1) > (b[k] ?? -1) ? 1 : (a[k] ?? -1) < (b[k] ?? -1) ? -1 : 0) * d);
  const ints = ["n", "stress", "mis", "minor"];
  $("byVoice").innerHTML = `<thead><tr>${cols.map(([c, l]) => `<th data-k="${c}">${esc(l)}${k === c ? (d > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>` +
    (rows.map((r) => `<tr>${cols.map(([c]) => {
      const v = r[c];
      if (r._txt[c] != null) return `<td class="n">${esc(r._txt[c])}</td>`;
      if (ints.includes(c)) return `<td class="n">${v}</td>`;
      if (typeof v === "number" || v === null) return `<td class="n">${f2(v)}${v != null ? `<span class="sbar" style="width:${v * 10}px"></span>` : ""}</td>`;
      return `<td>${esc(v)}${c === "name" && r.input ? `<div class="muted">input: ${esc(r.input)}</div>` : ""}</td>`;
    }).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length}" class="muted">Nothing rated yet.</td></tr>`) + "</tbody>";
  document.querySelectorAll("#byVoice th").forEach((th) => th.addEventListener("click", () => { S.sort = { k: th.dataset.k, d: S.sort.k === th.dataset.k ? -S.sort.d : -1 }; renderResults(); }));
  const srows = S.data.sentences.map((s) => {
    const ns = rowsRated().filter((n) => n.sentence === s.id);
    const scored = ns.map((n) => ({ n, m: mean(scaleAxes().map((a) => n.scores?.[a.key] ?? null)) })).filter((x) => x.m != null).sort((a, b) => b.m - a.m);
    const wc = {}; ns.flatMap((n) => n.word_tags || []).forEach((t) => [].concat(t.word || t.words || []).forEach((w) => (wc[w] = (wc[w] || 0) + 1)));
    const tw = Object.entries(wc).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, c]) => `${w} ×${c}`).join(", ");
    const bin = C.axes.filter((a) => a.type === "binary").map((a) => axisSummary(a, ns).text).filter(Boolean).join(" · ");
    return `<tr><td>${esc(s.id)}</td><td>${esc(field(s, "gloss") || field(s, "display") || "")}</td><td class="n">${ns.length}</td><td class="n">${f2(mean(scored.map((x) => x.m)))}</td>
      <td class="n">${esc(bin)}</td><td>${scored[0] ? esc(nameOf(scored[0].n)) : ""}</td><td>${scored.length > 1 ? esc(nameOf(scored.at(-1).n)) : ""}</td><td ${C.rtl ? 'dir="rtl"' : ""}>${esc(tw)}</td></tr>`;
  }).join("");
  $("bySentence").innerHTML = `<thead><tr><th>ID</th><th>Sentence</th><th>Rated</th><th>Mean (scales)</th><th>Yes/no axes</th><th>Best voice</th><th>Worst voice</th><th>Most-tagged words</th></tr></thead><tbody>${srows}</tbody>`;
}
function download(name, text, type) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); }
function csvCell(v) { const s = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

// ---------- tabs, toast ----------
function tab(t) {
  ["start", "rate", "results"].forEach((x) => ($(x).hidden = x !== t));
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  document.querySelector("main").classList.toggle("wide", t === "results");
  if (t === "results") renderResults();
  if (t !== "rate") $("audio").pause();
  S.tab = t;
}
let toastT;
function toast(msg, ms = 1500) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }

// ---------- events ----------
function start() {
  S.mode = document.querySelector("input[name=mode]:checked").value;
  S.blind = $("blind").checked; S.voice = $("voicePick").value;
  LS("eval", S.evalId); LS("mode", S.mode); LS("blind", S.blind); LS("voice", S.voice);
  buildQueue();
  const saved = LS("pos." + S.evalId + "." + S.mode + (S.mode === "voice" ? "." + S.voice : ""));
  const firstOpen = S.queue.findIndex((x) => !S.notes.has(key(x.run, x.sid)));
  tab("rate"); openClip(saved != null ? saved : Math.max(0, firstOpen));
}
function wire() {
  $("go").addEventListener("click", async () => { if (!S.data) await loadEval(); start(); });
  document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", syncModeUi));
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => tab(b.dataset.tab === "rate" && !S.queue.length ? "start" : b.dataset.tab)));
  $("play").addEventListener("click", () => { const a = $("audio"); a.paused ? a.play() : a.pause(); });
  ["play", "pause", "ended"].forEach((e) => $("audio").addEventListener(e, setPlayIcon));
  $("ratings").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]"), row = e.target.closest(".axis");
    if (row) { const si = scaleAxes().findIndex((a) => a.key === row.dataset.key); if (si >= 0) S.axis = si; }
    if (b) {
      const a = C.axes.find((x) => x.key === b.dataset.key), v = isScale(a) ? Number(b.dataset.v) : b.dataset.v;
      setScore(a.key, S.draft.scores[a.key] === v ? null : v);
      if (isScale(a)) S.axis = Math.min(scaleAxes().length - 1, scaleAxes().indexOf(a) + 1);
    }
    renderRatings();
  });
  $("note").addEventListener("input", () => { S.draft.note = $("note").value; touch(); });
  $("words").addEventListener("click", (e) => {
    const b = e.target.closest(".w"); if (!b) return;
    const i = Number(b.dataset.i);
    if (e.shiftKey || S.multi) { S.sel = S.sel.includes(i) ? S.sel.filter((x) => x !== i) : [...S.sel, i]; renderWords(); return; }
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
  $("keypad").addEventListener("mousedown", (e) => e.preventDefault()); // keep the caret in the IPA field
  $("keypad").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) insertIpa(b.dataset.s); });
  $("minorChips").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) b.classList.toggle("on"); });
  $("popOk").addEventListener("click", savePop);
  $("popCancel").addEventListener("click", () => { S.sel = []; closePop(); renderWords(); });
  $("popRemove").addEventListener("click", removeTag);
  $("pop").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input")) { e.preventDefault(); savePop(); } });
  $("save").addEventListener("click", () => go(1, true));
  $("next").addEventListener("click", () => go(1, false));
  $("prev").addEventListener("click", () => go(-1, false));
  $("dots").addEventListener("click", (e) => { const b = e.target.closest(".dot"); if (b) go(Number(b.dataset.i) - S.pos, false); });
  $("groupPick").addEventListener("change", (e) => {
    if (S.mode === "compare") go(S.queue.findIndex((x) => x.sid === e.target.value) - S.pos, false);
    else { if (S.dirty && hasContent(S.draft)) save(); S.voice = e.target.value; LS("voice", S.voice); buildQueue(); openClip(0); }
  });
  $("helpBtn").addEventListener("click", () => ($("help").hidden = false));
  document.querySelectorAll(".ipahelp-open").forEach((b) => b.addEventListener("click", () => { $("help").hidden = true; openIpaHelp(); }));
  $("ipaDrawerClose").addEventListener("click", () => ($("ipaDrawer").hidden = true));
  $("ipaSearch").addEventListener("input", renderIpaList);
  $("ipaList").addEventListener("mousedown", (e) => e.target.closest(".ins") && e.preventDefault());
  $("ipaList").addEventListener("click", (e) => { const b = e.target.closest(".ins"); if (b) insertIpa(b.dataset.s); });
  $("helpClose").addEventListener("click", () => ($("help").hidden = true));
  $("dlJson").addEventListener("click", () => download(`${S.evalId}-annotations.jsonl`, [...S.notes.values()].map((n) => JSON.stringify({ eval_id: S.evalId, ...n })).join("\n") + "\n", "application/jsonl"));
  $("dlCsv").addEventListener("click", () => {
    const cols = ["eval_id", "run", "run_name", "input", "sentence", ...C.axes.map((a) => a.key), "word_tags", "note", "blind", "saved"];
    const lines = [cols.join(",")].concat([...S.notes.values()].map((n) => cols.map((c) => csvCell(c === "eval_id" ? S.evalId : C.axes.some((a) => a.key === c) ? n.scores?.[c] : n[c])).join(",")));
    download(`${S.evalId}-annotations.csv`, lines.join("\n"), "text/csv");
  });
  document.addEventListener("click", (e) => { if (!e.target.isConnected) return; /* re-rendered inside the popover */ if (!$("pop").hidden && !e.target.closest("#pop") && !e.target.closest(".w") && !e.target.closest("#tagSel") && !e.target.closest("#ipaDrawer")) closePop(); });
  window.addEventListener("beforeunload", () => { if (S.dirty && S.draft && hasContent(S.draft)) save(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (!$("ipaDrawer").hidden) { $("ipaDrawer").hidden = true; return; } closePop(); $("help").hidden = true; return; }
    if (e.target.matches("textarea, input, select")) { if (e.target.id === "note" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(1, true); } return; }
    if (e.key === "?") { $("help").hidden = !$("help").hidden; return; }
    if (S.tab !== "rate" || !$("pop").hidden || !$("help").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const sa = scaleAxes(), lk = e.key.toLowerCase();
    let hit = null;
    if (e.key.length === 1) for (const a of C.axes) if (!isScale(a)) for (const o of axisOptions(a)) if (o.key && o.key.toLowerCase() === lk) hit = { a, o };
    if (e.key === " ") { e.preventDefault(); $("play").click(); }
    else if (/^[1-5]$/.test(e.key) && sa.length) { setScore(sa[S.axis].key, Number(e.key)); S.axis = Math.min(sa.length - 1, S.axis + 1); renderRatings(); }
    else if (e.key === "Backspace" && sa.length) { setScore(sa[S.axis].key, null); renderRatings(); }
    else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); S.axis = (S.axis + 1) % Math.max(1, sa.length); renderRatings(); }
    else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) { e.preventDefault(); S.axis = (S.axis + sa.length - 1) % Math.max(1, sa.length); renderRatings(); }
    else if (hit) { setScore(hit.a.key, hit.o.v); renderRatings(); } // a key always sets (clicking a selected button clears it)
    else if (e.key === "Enter") { e.preventDefault(); go(1, true); }
    else if (e.key === "ArrowRight") go(1, false);
    else if (e.key === "ArrowLeft") go(-1, false);
  });
}

// ---------- boot ----------
(async function boot() {
  C = await api("config");
  document.title = C.title; $("appTitle").textContent = C.title;
  document.documentElement.lang = C.language || "en";
  document.body.classList.toggle("rtl", !!C.rtl);
  document.documentElement.style.setProperty("--lang-font", C.font_stack);
  $("localNote").hidden = !C.local_only;
  L = await api("language");
  $("keypad").innerHTML = (L.keypad || []).map((s) => `<button data-s="${esc(s)}" title="${esc(symTip(symInfo(s)) || s)}">${esc(s)}</button>`).join("");
  $("ipaDrawerTitle").textContent = `IPA help · ${L.name || L.language || ""}`;
  $("ipaNotesWrap").hidden = !L.notes_md;
  if (L.notes_md) $("ipaNotes").innerHTML = md(L.notes_md);
  $("axisKeyHelp").innerHTML = C.axes.filter((a) => !isScale(a)).map((a) => `<tr><td>${axisOptions(a).filter((o) => o.key).map((o) => `<kbd>${esc(o.key.toUpperCase())}</kbd>`).join(" ")}</td><td>${esc(a.label)}: ${axisOptions(a).map((o) => esc(o.label)).join(" / ")}</td></tr>`).join("");
  $("refNote").textContent = `Word references (IPA, syllables, stress) are labelled "${C.reference_label}". They are machine-made: correct them in the tag when they are wrong.`;
  if (!LS("client")) LS("client", Math.random().toString(36).slice(2, 10));
  wire();
  const m = LS("mode"); if (m) document.querySelector(`input[name=mode][value=${m}]`).checked = true;
  const b = LS("blind"); if (b != null) $("blind").checked = b;
  S.voice = LS("voice");
  syncModeUi(); renderOutbox(); tab("start");
  try { await loadEvals(); if (S.evalId) await loadEval(); } catch (e) { $("evalList").innerHTML = `<div class="banner">Couldn't load: ${esc(e.message)}</div>`; }
  flush();
})();
