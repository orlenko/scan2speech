/*
 * OCR Lab — a self-contained diagnostic page (not part of the main app flow).
 * Runs Google Vision + several OpenAI vision models on one image, optionally
 * sliced into horizontal bands, and lets you tune the reconciliation prompt
 * live. Reuses the keys/settings saved by the main app. Safe to delete.
 */
(function () {
  'use strict';

  const CHAT = 'https://api.openai.com/v1/chat/completions';
  const GVISION = 'https://vision.googleapis.com/v1/images:annotate';
  const LS_KEY = 's2s_openai_key', LS_GKEY = 's2s_google_key', LS_SETTINGS = 's2s_settings';

  const OCR_SYSTEM =
    'You are a verbatim transcriber. Reproduce the text on the page EXACTLY as ' +
    'printed — word for word, character for character. Do NOT paraphrase, reword, ' +
    'summarize, modernize, correct, or substitute synonyms. Preserve original ' +
    'wording, spelling, punctuation, capitalization and numbers. You may rejoin a ' +
    'word hyphenated across a line break. Transcribe ONLY text that is actually ' +
    'visible and legible; never guess at or invent words — if illegible, write ' +
    '[illegible]. Output ONLY the body text, no commentary. Omit running headers, ' +
    'footers and isolated page numbers.';

  const RECONCILE_DEFAULT =
    'You are reconciling two independent transcriptions of the SAME single book ' +
    'page into one correct text.\n' +
    'SOURCE A is from a dedicated OCR engine: its words/spelling are usually ' +
    'correct, but its reading order may be scrambled with stray dashes / split lines.\n' +
    'SOURCE B is from a vision model: its reading order and flow are usually ' +
    'correct, but it sometimes misreads or invents words.\n' +
    'Produce the single correct page text:\n' +
    '- Use SOURCE A as the authority for exact words, spelling, names, numbers.\n' +
    '- Use SOURCE B as the guide for reading order, paragraph flow, joining lines.\n' +
    '- When they disagree on a word, prefer SOURCE A unless A is clearly garbled.\n' +
    '- CRITICAL: never introduce a word, name, number, or sentence that is not in ' +
    'at least one source. Do not summarize, paraphrase, translate, or add anything.\n' +
    '- Rejoin hyphenated line breaks. Keep paragraph breaks. Output ONLY the text.';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const getKey = () => (localStorage.getItem(LS_KEY) || '').trim();
  const getGKey = () => (localStorage.getItem(LS_GKEY) || '').trim();

  let bitmap = null;      // decoded source image
  const results = {};     // label -> text

  /* ── image helpers ── */
  async function decode(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) {}
    }
    return await new Promise((res, rej) => {
      const img = new Image(); const u = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(u); res(img); };
      img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('decode failed')); };
      img.src = u;
    });
  }
  // Encode a (possibly cropped) region of the bitmap to a downscaled JPEG.
  async function encode(maxDim, crop) {
    const sx = crop ? crop.sx : 0, sy = crop ? crop.sy : 0;
    const sw = crop ? crop.sw : bitmap.width, sh = crop ? crop.sh : bitmap.height;
    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    const cw = Math.max(1, Math.round(sw * scale)), ch = Math.max(1, Math.round(sh * scale));
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    cv.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, cw, ch);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9));
    const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
    return { dataUrl, base64: String(dataUrl).slice(String(dataUrl).indexOf(',') + 1) };
  }
  // N horizontal bands with overlap so no text line is lost at a cut.
  async function slices(n, maxDim) {
    if (n <= 1) return [await encode(maxDim)];
    const H = bitmap.height, band = H / n, ov = Math.round(band * 0.15);
    const out = [];
    for (let i = 0; i < n; i++) {
      const sy = Math.max(0, Math.round(i * band) - ov);
      const ey = Math.min(H, Math.round((i + 1) * band) + ov);
      out.push(await encode(maxDim, { sx: 0, sy, sw: bitmap.width, sh: ey - sy }));
    }
    return out;
  }

  /* ── line-level dedup join for sliced output ── */
  function norm(s) { return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim(); }
  function mergeTwo(a, b) {
    const A = a.split('\n').filter((x) => x.trim()), B = b.split('\n').filter((x) => x.trim());
    const maxK = Math.min(6, A.length, B.length);
    for (let k = maxK; k >= 1; k--) {
      let ok = true;
      for (let i = 0; i < k; i++) {
        const na = norm(A[A.length - k + i]), nb = norm(B[i]);
        if (!na || !nb || (na !== nb && !na.includes(nb) && !nb.includes(na))) { ok = false; break; }
      }
      if (ok) return A.concat(B.slice(k)).join('\n');
    }
    return A.concat(B).join('\n');
  }
  function mergeParts(parts) { return parts.filter((p) => p.trim()).reduce((acc, p) => acc ? mergeTwo(acc, p) : p, ''); }

  /* ── API calls ── */
  async function errMsg(r) {
    let d = ''; try { const j = await r.json(); d = j && j.error && j.error.message || ''; } catch (_) {}
    return 'HTTP ' + r.status + (d ? ': ' + d : '');
  }
  // Chat completion that downgrades params on 400 so newer/reasoning models work.
  async function chatComplete(model, messages) {
    const bodies = [
      { model, messages, temperature: 0, max_completion_tokens: 4096 },
      { model, messages, max_completion_tokens: 4096 },
      { model, messages },
    ];
    let last = '';
    for (const body of bodies) {
      const r = await fetch(CHAT, { method: 'POST', headers: { Authorization: 'Bearer ' + getKey(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) { const d = await r.json(); return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '').trim(); }
      last = await errMsg(r);
      if (r.status !== 400) break;
    }
    throw new Error(last);
  }
  async function openaiVision(model, dataUrl, lang) {
    const sys = OCR_SYSTEM + (lang ? ' The page is written in ' + lang + '.' : '');
    return chatComplete(model, [
      { role: 'system', content: sys },
      { role: 'user', content: [
        { type: 'text', text: 'Transcribe this page verbatim.' },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      ] },
    ]);
  }
  async function googleVision(base64, lang) {
    const body = { requests: [{ image: { content: base64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }], imageContext: lang ? { languageHints: [lang] } : undefined }] };
    const r = await fetch(GVISION + '?key=' + encodeURIComponent(getGKey()), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await errMsg(r));
    const d = await r.json(); const o = d.responses && d.responses[0];
    if (o && o.error) throw new Error(o.error.message || 'vision error');
    return (o && o.fullTextAnnotation && o.fullTextAnnotation.text || '').trim();
  }

  /* ── run one engine, possibly across slices ── */
  async function runEngine(label, fn, parts) {
    const t0 = performance.now();
    try {
      const texts = [];
      for (const p of parts) texts.push(await fn(p)); // sequential = gentler on rate limits
      const text = mergeParts(texts);
      results[label] = text;
      renderCard('ocrResults', label, { text, ms: Math.round(performance.now() - t0), bands: parts.length });
    } catch (e) {
      renderCard('ocrResults', label, { err: e.message, ms: Math.round(performance.now() - t0) });
    }
  }

  function renderCard(container, label, r) {
    const id = 'card-' + label.replace(/[^a-z0-9]/gi, '_');
    let card = $(id);
    if (!card) { card = document.createElement('div'); card.className = 'lab-card'; card.id = id; $(container).appendChild(card); }
    card.classList.toggle('err', !!r.err);
    const meta = [r.ms != null ? r.ms + ' ms' : '', r.bands > 1 ? r.bands + ' bands' : '', r.text != null ? r.text.length + ' chars' : '']
      .filter(Boolean).join(' · ');
    card.innerHTML = `<h3>${esc(label)} <span class="pill">${esc(meta)}</span></h3>` +
      (r.err ? `<div class="errmsg">⚠ ${esc(r.err)}</div>`
             : `<textarea id="out-${esc(label)}" spellcheck="false">${esc(r.text || '')}</textarea>`);
    refreshSourceSelects();
  }

  function refreshSourceSelects() {
    const labels = Object.keys(results);
    for (const sel of [$('srcA'), $('srcB')]) {
      const cur = sel.value;
      sel.innerHTML = labels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
      if (labels.includes(cur)) sel.value = cur;
    }
    if (!$('srcB').value && labels.length > 1) $('srcB').selectedIndex = 1;
    $('runReconcile').disabled = labels.length < 2;
  }

  /* ── wire up ── */
  function setKeyStatus() {
    const ok = getKey(), gk = getGKey();
    $('keyStatus').innerHTML = `OpenAI key: ${ok ? '✓ saved' : '<b style="color:var(--bad)">missing</b>'} · ` +
      `Google Vision key: ${gk ? '✓ saved' : '<b style="color:var(--bad)">missing</b>'} ` +
      `<span class="muted">(set them on the <a href="index.html">main page</a>)</span>`;
  }

  async function runOcr() {
    if (!bitmap) return;
    $('ocrStatus').textContent = 'Running…';
    $('runOcr').disabled = true;
    for (const k of Object.keys(results)) delete results[k];
    $('ocrResults').innerHTML = '';
    const lang = $('lang').value.trim();
    const gLang = mapLang(lang);
    const maxDim = Math.max(768, parseInt($('maxDim').value, 10) || 1568);
    const n = parseInt($('slices').value, 10) || 1;
    const parts = await slices(n, maxDim);

    const jobs = [];
    if ($('useGoogle').checked && getGKey()) {
      jobs.push(runEngine('Google Vision', (p) => googleVision(p.base64, gLang), parts));
    }
    const models = $('models').value.split(',').map((m) => m.trim()).filter(Boolean);
    for (const m of models) {
      if (getKey()) jobs.push(runEngine('OpenAI ' + m, (p) => openaiVision(m, p.dataUrl, lang), parts));
    }
    await Promise.all(jobs);
    $('ocrStatus').textContent = 'Done.';
    $('runOcr').disabled = false;
  }

  async function runReconcile() {
    const aLabel = $('srcA').value, bLabel = $('srcB').value;
    const aEl = $('out-' + aLabel), bEl = $('out-' + bLabel);
    if (!aEl || !bEl) { $('recStatus').textContent = 'Pick two sources.'; return; }
    $('recStatus').textContent = 'Reconciling…';
    $('runReconcile').disabled = true;
    const model = $('recModel').value.trim() || 'gpt-4o';
    const sys = $('recPrompt').value;
    const user = 'SOURCE A (' + aLabel + '):\n' + aEl.value + '\n\n----------\n\nSOURCE B (' + bLabel + '):\n' + bEl.value + '\n\nReconciled page text:';
    const t0 = performance.now();
    try {
      const text = await chatComplete(model, [{ role: 'system', content: sys }, { role: 'user', content: user }]);
      renderRecResult({ text, ms: Math.round(performance.now() - t0), model });
      $('recStatus').textContent = 'Done.';
    } catch (e) {
      renderRecResult({ err: e.message, model });
      $('recStatus').textContent = 'Failed.';
    }
    $('runReconcile').disabled = false;
  }
  function renderRecResult(r) {
    $('reconcileResult').innerHTML =
      `<div class="lab-card ${r.err ? 'err' : ''}"><h3>Reconciled (${esc(r.model)}) <span class="pill">${esc((r.ms != null ? r.ms + ' ms · ' : '') + (r.text != null ? r.text.length + ' chars' : ''))}</span></h3>` +
      (r.err ? `<div class="errmsg">⚠ ${esc(r.err)}</div>` : `<textarea spellcheck="false">${esc(r.text || '')}</textarea>`) + `</div>`;
  }

  const LANG_CODES = { ukrainian: 'uk', ukranian: 'uk', russian: 'ru', english: 'en', french: 'fr', german: 'de', spanish: 'es', italian: 'it', polish: 'pl', czech: 'cs' };
  function mapLang(raw) {
    const s = (raw || '').trim().toLowerCase();
    if (!s) return '';
    if (LANG_CODES[s]) return LANG_CODES[s];
    if (/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(s)) return s;
    return '';
  }

  function init() {
    setKeyStatus();
    $('recPrompt').value = RECONCILE_DEFAULT;
    try { const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); if (s.ocrLang) $('lang').value = s.ocrLang; } catch (_) {}
    $('file').addEventListener('change', async () => {
      const f = $('file').files[0]; if (!f) return;
      try {
        bitmap = await decode(f);
        const t = $('thumb'); t.src = URL.createObjectURL(f); t.hidden = false;
        $('runOcr').disabled = false;
      } catch (e) { $('ocrStatus').textContent = 'Could not decode image: ' + e.message; }
    });
    $('runOcr').addEventListener('click', runOcr);
    $('runReconcile').addEventListener('click', runReconcile);
  }
  document.addEventListener('DOMContentLoaded', init);
})();
