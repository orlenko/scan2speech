/*
 * Scan2Speech — photos of book pages → audio, entirely client-side.
 *
 * No build step, no framework, no backend. Plain DOM + fetch against the
 * OpenAI REST API using the user's own key (stored in localStorage).
 *
 * Pipeline per page:  image → downscale/normalize → vision transcription
 *                     → editable text → sentence-boundary chunking
 *                     → TTS per chunk → queued playback.
 */
(function () {
  'use strict';

  /* ───────────────────────────────────────────────────────────────
   * CONFIG — the ONE place to change model ids / defaults.
   * Model identifiers drift; these are also editable from the UI
   * (Advanced settings) and persisted, so nothing is locked in code.
   * Verified against the live OpenAI docs (June 2026):
   *   - Vision: chat-completions models that accept image input
   *             (gpt-4o-mini is the cheap/fast default).
   *   - Speech: POST /v1/audio/speech, 4096-char cap on tts-1/-hd,
   *             ~2000-token cap on gpt-4o-mini-tts.
   * ─────────────────────────────────────────────────────────────── */
  const CONFIG = {
    CHAT_ENDPOINT: 'https://api.openai.com/v1/chat/completions',
    SPEECH_ENDPOINT: 'https://api.openai.com/v1/audio/speech',
    GOOGLE_VISION_ENDPOINT: 'https://vision.googleapis.com/v1/images:annotate',
    OCR_ENGINE: 'openai',  // 'openai' | 'google'
    // gpt-4o (not -mini) — mini misreads non-English / handwriting badly.
    VISION_MODEL: 'gpt-4o',
    OCR_LANG: '',          // optional language hint, e.g. 'Ukrainian'
    TTS_MODEL: 'gpt-4o-mini-tts',
    VOICE: 'alloy',
    // Conservative: under the 4096-char tts-1 cap AND well under the
    // ~2000-token gpt-4o-mini-tts cap. Tunable in settings.
    MAX_CHARS: 3500,
    TTS_INSTRUCTIONS: 'Read in a clear, natural, unhurried narrator voice.',
    // 1568px is OpenAI's vision tiling sweet spot — larger images get
    // downscaled server-side anyway, so this trims cost/latency for free.
    MAX_IMAGE_DIM: 1568,   // downscale longest side before upload
    JPEG_QUALITY: 0.85,
    OCR_CONCURRENCY: 3,    // pages transcribed in parallel
    TTS_CONCURRENCY: 3,    // chunks synthesized in parallel
    MAX_RETRIES: 3,        // automatic retries on 429 / network blips
    // Widely supported across tts models; gpt-4o-mini-tts also accepts
    // newer voices — user can add a custom model/voice if needed.
    VOICES: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
             'nova', 'onyx', 'sage', 'shimmer', 'verse'],
  };

  const LS_KEY = 's2s_openai_key';
  const LS_GOOGLE_KEY = 's2s_google_key';
  const LS_SETTINGS = 's2s_settings';

  const OCR_SYSTEM =
    'You are a verbatim transcriber. Reproduce the text on the page EXACTLY ' +
    'as printed — word for word, character for character. Do NOT paraphrase, ' +
    'reword, summarize, simplify, modernize, correct grammar/spelling, or ' +
    'substitute synonyms. Preserve the original wording, spelling, ' +
    'punctuation, capitalization and numbers; render any italics or other ' +
    'emphasis as plain text. ' +
    'The ONLY change you may make: rejoin a single word that is hyphenated ' +
    'across a line break (e.g. "trans-\\ncription" → "transcription"). ' +
    'Transcribe ONLY text that is actually visible and legible. Never guess ' +
    'at or invent words, names, sentences, or punctuation you cannot clearly ' +
    'read — if a passage is illegible, write [illegible] rather than ' +
    'fabricating plausible text. ' +
    'Keep paragraph breaks. Output ONLY the body text — no commentary, ' +
    'titles, or markdown. Omit running headers, footers, isolated page ' +
    'numbers, and image captions unless they are part of the prose. If two ' +
    'pages are visible, transcribe the left page fully, then the right. If ' +
    'the image has no readable text, output exactly: [no readable text].';

  /* ───────────────────────────── state ───────────────────────────── */
  let settings = loadSettings();
  let pages = [];          // ordered page objects
  let playerCurrent = null;  // { page, chunk } currently loaded
  let userWantsPlaying = false;

  /* ─────────────────────────── DOM refs ──────────────────────────── */
  const $ = (id) => document.getElementById(id);
  const el = {
    apiKey: $('apiKey'), toggleKey: $('toggleKey'), saveKey: $('saveKey'),
    clearKey: $('clearKey'), keyStatus: $('keyStatus'),
    ocrEngine: $('ocrEngine'), googleKeyRow: $('googleKeyRow'),
    googleKey: $('googleKey'), toggleGoogleKey: $('toggleGoogleKey'),
    saveGoogleKey: $('saveGoogleKey'), clearGoogleKey: $('clearGoogleKey'),
    googleKeyStatus: $('googleKeyStatus'), visionModelRow: $('visionModelRow'),
    visionModel: $('visionModel'), ocrLang: $('ocrLang'), ttsModel: $('ttsModel'),
    ttsModelCustom: $('ttsModelCustom'), voice: $('voice'),
    maxChars: $('maxChars'), ttsInstructions: $('ttsInstructions'),
    dropzone: $('dropzone'), fileInput: $('fileInput'),
    batchActions: $('batchActions'), transcribeAll: $('transcribeAll'),
    generateAll: $('generateAll'), clearAll: $('clearAll'),
    batchSummary: $('batchSummary'),
    main: document.querySelector('main'),
    pagesSection: $('pagesSection'), pages: $('pages'),
    playerBar: $('playerBar'), audio: $('audio'),
    pBigPlay: $('pBigPlay'), pNow: $('pNow'), pSeek: $('pSeek'),
    pCur: $('pCur'), pDur: $('pDur'), pPrev: $('pPrev'), pNext: $('pNext'),
    pSpeed: $('pSpeed'), toast: $('toast'),
  };

  /* ════════════════════════════ utils ════════════════════════════ */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  }
  function toast(msg, ms = 5000) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.toast.hidden = true; }, ms);
  }
  function getKey() { return (localStorage.getItem(LS_KEY) || '').trim(); }

  // Minimal concurrency limiter.
  function pLimit(n) {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active >= n || !queue.length) return;
      active++;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active--; next();
      });
    };
    return (fn) => new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject }); next();
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function uid() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 's' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error('read failed'));
      fr.readAsDataURL(blob);
    });
  }
  async function blobToBase64(blob) {
    const url = await blobToDataURL(blob);
    return String(url).slice(String(url).indexOf(',') + 1); // strip data: prefix
  }
  // Map a free-text language ("Ukrainian", "uk") to an ISO code for Google's
  // languageHints. Passes through anything that already looks like a code.
  const LANG_CODES = {
    ukrainian: 'uk', russian: 'ru', english: 'en', french: 'fr', german: 'de',
    spanish: 'es', italian: 'it', portuguese: 'pt', polish: 'pl', dutch: 'nl',
    czech: 'cs', slovak: 'sk', bulgarian: 'bg', serbian: 'sr', croatian: 'hr',
    romanian: 'ro', greek: 'el', turkish: 'tr', swedish: 'sv', norwegian: 'no',
    danish: 'da', finnish: 'fi', hungarian: 'hu', japanese: 'ja', korean: 'ko',
    chinese: 'zh', arabic: 'ar', hebrew: 'he', hindi: 'hi', ukranian: 'uk',
  };
  function mapLang(raw) {
    const s = (raw || '').trim().toLowerCase();
    if (!s) return '';
    if (LANG_CODES[s]) return LANG_CODES[s];
    if (/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(s)) return s; // already a code
    return '';
  }

  /* ════════════════════ IndexedDB persistence ════════════════════
   * Pages — downscaled image + text + audio blobs — survive refreshes so a
   * big batch isn't lost (the spec's endorsed use for IndexedDB; audio is
   * far too large for localStorage). Blobs are stored directly; object URLs
   * are rebuilt on load. The API key stays in localStorage, never here.
   * If IndexedDB is unavailable or the quota is hit, the app degrades
   * gracefully to in-memory only. */
  const DB_NAME = 's2s', DB_STORE = 'pages', ORDER_ID = '__order__';
  let _dbPromise = null;
  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve) => {
      if (!('indexedDB' in window)) { resolve(null); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, 1); }
      catch (_) { resolve(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { console.warn('IndexedDB unavailable', req.error); resolve(null); };
    });
    return _dbPromise;
  }
  async function idbRun(mode, op) {
    const db = await openDB();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const req = op(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  const idbDelete = (id) => idbRun('readwrite', (s) => s.delete(id));
  const idbClear = () => idbRun('readwrite', (s) => s.clear());
  const idbGetAll = () => idbRun('readonly', (s) => s.getAll());

  function serializePage(page) {
    return {
      id: page.id,
      name: page.name,
      text: page.text || '',
      jpegBlob: page.jpegBlob || null,
      chunks: page.chunks ? page.chunks.map((c) => ({
        text: c.text,
        status: c.status === 'ready' ? 'ready' : 'pending',
        blob: c.status === 'ready' ? c.blob : null,
      })) : null,
    };
  }
  // Persist one page (fire-and-forget; never blocks the UI).
  function savePage(page) {
    if (!page.jpegBlob) return; // nothing worth persisting yet
    idbRun('readwrite', (s) => s.put(serializePage(page)))
      .catch((e) => console.warn('persist failed', e));
  }
  // Page order is a tiny separate record, so reordering never rewrites blobs.
  function saveOrder() {
    idbRun('readwrite', (s) => s.put({ id: ORDER_ID, ids: pages.map((p) => p.id) }))
      .catch(() => {});
  }
  const saveDebounced = (() => {
    const timers = new Map();
    return (page) => {
      clearTimeout(timers.get(page.id));
      timers.set(page.id, setTimeout(() => savePage(page), 700));
    };
  })();

  function deriveStatus(page) {
    if (page.chunks && page.chunks.some((c) => c.status === 'ready')) return 'audio';
    if ((page.text || '').trim()) return 'transcribed';
    return 'ready';
  }
  async function restorePages() {
    let all = [];
    try { all = (await idbGetAll()) || []; } catch (_) {}
    const orderRec = all.find((r) => r.id === ORDER_ID);
    const byId = new Map(all.filter((r) => r.id !== ORDER_ID).map((r) => [r.id, r]));
    // Honour saved order, then append any stragglers not in the order list.
    const records = [];
    if (orderRec && Array.isArray(orderRec.ids)) {
      for (const id of orderRec.ids) { const r = byId.get(id); if (r) { records.push(r); byId.delete(id); } }
    }
    for (const r of byId.values()) records.push(r);
    for (const rec of records) {
      if (!rec.jpegBlob) { idbDelete(rec.id); continue; }
      const page = {
        id: rec.id, name: rec.name || 'page', status: 'ready',
        text: rec.text || '', error: '', jpegBlob: rec.jpegBlob,
        thumbUrl: URL.createObjectURL(rec.jpegBlob), chunks: null,
      };
      if (rec.chunks && rec.chunks.length) {
        page.chunks = rec.chunks.map((c) => {
          const ready = c.status === 'ready' && c.blob;
          return {
            text: c.text, status: ready ? 'ready' : 'pending',
            blob: ready ? c.blob : null,
            url: ready ? URL.createObjectURL(c.blob) : '', error: '',
          };
        });
      }
      page.status = deriveStatus(page);
      pages.push(page);
    }
    if (pages.length) {
      el.pagesSection.hidden = false;
      renderAllPages();
      updateBatchUI();
      updatePlayerVisibility();
    }
  }

  /* ════════════════════════ settings / key ════════════════════════ */
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); } catch (_) {}
    return {
      ocrEngine: s.ocrEngine === 'google' ? 'google' : CONFIG.OCR_ENGINE,
      visionModel: s.visionModel || CONFIG.VISION_MODEL,
      ocrLang: s.ocrLang != null ? s.ocrLang : CONFIG.OCR_LANG,
      ttsModel: s.ttsModel || CONFIG.TTS_MODEL,
      voice: s.voice || CONFIG.VOICE,
      maxChars: clampInt(s.maxChars, 500, 4000, CONFIG.MAX_CHARS),
      ttsInstructions: s.ttsInstructions != null ? s.ttsInstructions : CONFIG.TTS_INSTRUCTIONS,
    };
  }
  function clampInt(v, lo, hi, dflt) {
    v = parseInt(v, 10);
    if (!isFinite(v)) return dflt;
    return Math.min(hi, Math.max(lo, v));
  }
  function saveSettings() {
    const custom = el.ttsModelCustom.value.trim();
    settings = {
      ocrEngine: el.ocrEngine.value === 'google' ? 'google' : 'openai',
      visionModel: el.visionModel.value.trim() || CONFIG.VISION_MODEL,
      ocrLang: el.ocrLang.value.trim(),
      ttsModel: custom || el.ttsModel.value,
      voice: el.voice.value,
      maxChars: clampInt(el.maxChars.value, 500, 4000, CONFIG.MAX_CHARS),
      ttsInstructions: el.ttsInstructions.value,
    };
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  }
  function hydrateSettingsUI() {
    el.ocrEngine.value = settings.ocrEngine;
    updateEngineUI();
    el.visionModel.value = settings.visionModel;
    el.ocrLang.value = settings.ocrLang;
    el.maxChars.value = settings.maxChars;
    el.ttsInstructions.value = settings.ttsInstructions;
    // voices dropdown
    el.voice.innerHTML = CONFIG.VOICES
      .map((v) => `<option value="${v}">${v}</option>`).join('');
    if (!CONFIG.VOICES.includes(settings.voice)) {
      el.voice.insertAdjacentHTML('beforeend',
        `<option value="${esc(settings.voice)}">${esc(settings.voice)}</option>`);
    }
    el.voice.value = settings.voice;
    // tts model: known in <select>, else stash in custom field
    const known = [...el.ttsModel.options].some((o) => o.value === settings.ttsModel);
    if (known) { el.ttsModel.value = settings.ttsModel; el.ttsModelCustom.value = ''; }
    else { el.ttsModelCustom.value = settings.ttsModel; }
  }
  function refreshKeyStatus() {
    const k = getKey();
    if (k) {
      el.keyStatus.textContent = '✓ Key saved in this browser (' +
        k.slice(0, 6) + '…' + k.slice(-4) + ').';
      el.keyStatus.className = 'status ok';
    } else {
      el.keyStatus.textContent = 'No key saved yet.';
      el.keyStatus.className = 'status';
    }
  }
  function getGoogleKey() { return (localStorage.getItem(LS_GOOGLE_KEY) || '').trim(); }
  function refreshGoogleKeyStatus() {
    const k = getGoogleKey();
    el.googleKeyStatus.textContent = k
      ? '✓ Google Vision key saved (' + k.slice(0, 6) + '…' + k.slice(-4) + ').'
      : 'No Google Vision key saved yet.';
    el.googleKeyStatus.style.color = k ? 'var(--good)' : '';
  }
  // Show the Google key field only for the Google engine; the OpenAI vision
  // model field only matters for the OpenAI engine.
  function updateEngineUI() {
    const google = el.ocrEngine.value === 'google';
    el.googleKeyRow.hidden = !google;
    el.visionModelRow.style.opacity = google ? '0.5' : '';
    refreshGoogleKeyStatus();
  }

  /* ════════════════════ sentence-boundary chunking ════════════════════
   * Prefer the built-in Intl.Segmenter (handles abbreviations, quotes and
   * many languages with zero dependencies); fall back to a regex. Sentences
   * are greedily packed up to maxChars; an over-long sentence is split on
   * clause boundaries, then words, never mid-word. */
  function splitSentences(text) {
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return [];
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      try {
        const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
        return Array.from(seg.segment(text), (s) => s.segment.trim()).filter(Boolean);
      } catch (_) { /* fall through */ }
    }
    return text.match(/[^.!?]+[.!?]+["'”’)\]]*\s*|[^.!?]+$/g) || [text];
  }
  function forceSlice(word, max, out) {
    while (word.length > max) { out.push(word.slice(0, max)); word = word.slice(max); }
    return word; // remainder
  }
  function hardSplit(sentence, max) {
    const out = [];
    const parts = sentence.split(/(?<=[,;:—])\s+/); // clause boundaries
    for (const part of parts) {
      if (part.length <= max) { out.push(part); continue; }
      let line = '';
      for (const word of part.split(/\s+/)) {
        const cand = line ? line + ' ' + word : word;
        if (cand.length > max) {
          if (line) out.push(line);
          line = word.length > max ? forceSlice(word, max, out) : word;
        } else { line = cand; }
      }
      if (line) out.push(line);
    }
    return out;
  }
  function chunkText(text, max) {
    const chunks = [];
    let cur = '';
    const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
    for (let s of splitSentences(text)) {
      if (s.length > max) {
        flush();
        for (const piece of hardSplit(s, max)) {
          const cand = cur ? cur + ' ' + piece : piece;
          if (cand.length > max) { flush(); cur = piece; } else { cur = cand; }
        }
        flush();
        continue;
      }
      const cand = cur ? cur + ' ' + s : s;
      if (cand.length > max) { flush(); cur = s; } else { cur = cand; }
    }
    flush();
    return chunks;
  }

  /* ════════════════════════ OpenAI calls ════════════════════════ */
  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }
  // Turn an OpenAI error response into a clear, human message.
  async function describeError(resp) {
    let detail = '';
    try {
      const j = await resp.json();
      detail = (j && j.error && j.error.message) || '';
    } catch (_) {}
    const s = resp.status;
    if (s === 401) return new ApiError('Invalid or expired API key. Check the key and save it again.', s);
    if (s === 403) return new ApiError('Key rejected (403). It may lack access to this model.' + (detail ? ' ' + detail : ''), s);
    if (s === 429) return new ApiError('Rate limit / quota hit (429). Wait a moment, then retry — or check your OpenAI billing.', s);
    if (s === 400) return new ApiError('Request rejected (400): ' + (detail || 'bad input or unsupported model/voice.'), s);
    if (s >= 500) return new ApiError('OpenAI server error (' + s + '). Try again shortly.', s);
    return new ApiError('Request failed (' + s + ')' + (detail ? ': ' + detail : '.'), s);
  }
  // fetch with auto-retry on 429 / 5xx / network errors (exponential backoff).
  async function apiFetch(url, body, asBlob) {
    const key = getKey();
    if (!key) throw new ApiError('No API key saved.', 0);
    let lastErr;
    for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (resp.ok) return asBlob ? await resp.blob() : await resp.json();
        const err = await describeError(resp);
        // Retry transient statuses; surface the rest immediately.
        if ((resp.status === 429 || resp.status >= 500) && attempt < CONFIG.MAX_RETRIES) {
          const wait = parseRetryAfter(resp) || (1000 * Math.pow(2, attempt));
          await sleep(wait);
          lastErr = err; continue;
        }
        throw err;
      } catch (e) {
        if (e instanceof ApiError && e.status) throw e; // already mapped, non-network
        // Network/CORS/abort → retry with backoff.
        lastErr = new ApiError('Network error reaching OpenAI. Check your connection.', 0);
        if (attempt < CONFIG.MAX_RETRIES) { await sleep(1000 * Math.pow(2, attempt)); continue; }
        throw lastErr;
      }
    }
    throw lastErr || new ApiError('Request failed.', 0);
  }
  function parseRetryAfter(resp) {
    const h = resp.headers.get('retry-after');
    if (!h) return 0;
    const n = parseFloat(h);
    return isFinite(n) ? n * 1000 : 0;
  }

  async function transcribeImage(dataUrl) {
    const lang = (settings.ocrLang || '').trim();
    const sys = lang
      ? OCR_SYSTEM + ' The page is written in ' + lang + '. Use correct ' +
        lang + ' spelling and orthography; never transliterate or substitute ' +
        'words from another language.'
      : OCR_SYSTEM;
    const userText = lang
      ? 'Transcribe this ' + lang + ' book page verbatim — exact wording, no paraphrasing.'
      : 'Transcribe this book page verbatim — exact wording, no paraphrasing.';
    const data = await apiFetch(CONFIG.CHAT_ENDPOINT, {
      model: settings.visionModel,
      temperature: 0,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
        ] },
      ],
    });
    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    if (!text) throw new ApiError('Model returned no text for this page.', 0);
    return text === '[no readable text]' ? '' : text;
  }

  async function synthesize(text) {
    const body = {
      model: settings.ttsModel,
      voice: settings.voice,
      input: text,
      response_format: 'mp3',
    };
    if (/gpt-4o.*tts/i.test(settings.ttsModel) && settings.ttsInstructions.trim()) {
      body.instructions = settings.ttsInstructions.trim();
    }
    return apiFetch(CONFIG.SPEECH_ENDPOINT, body, true); // → Blob
  }

  // Google Cloud Vision — a true OCR engine (no generative confabulation).
  // Called directly from the browser with the user's own API key.
  async function transcribeGoogle(base64) {
    const key = getGoogleKey();
    if (!key) throw new ApiError('No Google Cloud Vision API key saved (Advanced settings).', 0);
    const hint = mapLang(settings.ocrLang);
    const body = {
      requests: [{
        image: { content: base64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: hint ? { languageHints: [hint] } : undefined,
      }],
    };
    const url = CONFIG.GOOGLE_VISION_ENDPOINT + '?key=' + encodeURIComponent(key);
    for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        // Most commonly a CORS/network failure from the browser call.
        if (attempt < CONFIG.MAX_RETRIES) { await sleep(1000 * Math.pow(2, attempt)); continue; }
        throw new ApiError('Could not reach Google Vision (network or CORS). ' +
          'If this persists, the API key likely has an HTTP-referrer restriction ' +
          'that blocks browser calls.', 0);
      }
      if (resp.ok) {
        const data = await resp.json();
        const r = data && data.responses && data.responses[0];
        if (r && r.error) throw new ApiError('Google Vision: ' + (r.error.message || 'failed.'), 0);
        const text = (r && r.fullTextAnnotation && r.fullTextAnnotation.text || '').trim();
        return text; // empty string = no text found (handled upstream)
      }
      let detail = '';
      try { const j = await resp.json(); detail = j && j.error && j.error.message || ''; } catch (_) {}
      const s = resp.status;
      if ((s === 429 || s >= 500) && attempt < CONFIG.MAX_RETRIES) {
        await sleep(1000 * Math.pow(2, attempt)); continue;
      }
      if (s === 400) throw new ApiError('Google Vision rejected the request (400): ' + (detail || 'bad image or request.'), s);
      if (s === 403) throw new ApiError('Google Vision 403: key invalid, Cloud Vision API not enabled, billing off, or a key restriction is blocking this site. ' + detail, s);
      if (s === 429) throw new ApiError('Google Vision quota/rate limit (429). Wait and retry.', s);
      throw new ApiError('Google Vision error (' + s + ')' + (detail ? ': ' + detail : '.'), s);
    }
    throw new ApiError('Google Vision request failed.', 0);
  }

  /* ════════════════════════ image prep ════════════════════════
   * Decode with the browser, downscale the longest side, and re-encode
   * to JPEG. This normalizes formats (incl. HEIC where the browser can
   * decode it), respects EXIF orientation, and shrinks huge phone photos
   * to cut upload size, cost and latency. */
  async function loadBitmap(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch (_) { /* fall back to <img> */ }
    }
    return await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }
  async function prepareImage(file) {
    let bmp;
    try { bmp = await loadBitmap(file); }
    catch (_) {
      throw new Error('Could not read this image. If it is a HEIC photo, your ' +
        'browser cannot decode it — re-save as JPEG or PNG.');
    }
    const w = bmp.width, h = bmp.height;
    const scale = Math.min(1, CONFIG.MAX_IMAGE_DIM / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    canvas.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
    if (bmp.close) bmp.close();
    const blob = await new Promise((res) =>
      canvas.toBlob(res, 'image/jpeg', CONFIG.JPEG_QUALITY));
    if (!blob) throw new Error('Could not process this image.');
    return { blob, thumbUrl: URL.createObjectURL(blob) };
  }

  /* ════════════════════════ page lifecycle ════════════════════════ */
  function setStatus(page, status, error) {
    page.status = status;
    page.error = error || '';
    renderPage(page);
    updateBatchUI();
  }

  async function addFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/') ||
      /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    if (!files.length) { toast('No images found in that selection.'); return; }
    el.pagesSection.hidden = false;
    for (const file of files) {
      const page = {
        id: uid(), name: file.name, status: 'loading',
        thumbUrl: '', jpegBlob: null, text: '', error: '', chunks: null,
      };
      pages.push(page);
      renderPage(page);
      // Prepare (downscale/encode) immediately so the user sees a thumbnail.
      prepareImage(file).then(({ blob, thumbUrl }) => {
        page.jpegBlob = blob; page.thumbUrl = thumbUrl;
        setStatus(page, 'ready');
        savePage(page);
      }).catch((e) => setStatus(page, 'error', e.message));
    }
    saveOrder();
    updateBatchUI();
  }

  const ocrLimit = pLimit(CONFIG.OCR_CONCURRENCY);
  const ttsLimit = pLimit(CONFIG.TTS_CONCURRENCY);

  async function transcribePage(page) {
    if (!page.jpegBlob) { toast('Image still loading — try again in a moment.'); return; }
    if (page.status === 'transcribing') return;
    setStatus(page, 'transcribing');
    try {
      const text = await ocrLimit(async () => {
        if (settings.ocrEngine === 'google') {
          return transcribeGoogle(await blobToBase64(page.jpegBlob));
        }
        return transcribeImage(await blobToDataURL(page.jpegBlob));
      });
      page.text = text;
      revokePageAudio(page);
      page.chunks = null; // text changed → audio invalid
      setStatus(page, 'transcribed');
      renderPage(page);
      savePage(page);
    } catch (e) {
      setStatus(page, 'error', e.message || String(e));
    }
  }

  async function generatePageAudio(page) {
    const text = (page.text || '').trim();
    if (!text) { toast('Page ' + pageNum(page) + ' has no text to read.'); return; }
    if (page.status === 'generating') return;
    setStatus(page, 'generating');
    // Free any previous audio for this page.
    revokePageAudio(page);
    const parts = chunkText(text, settings.maxChars);
    page.chunks = parts.map((t) => ({ text: t, status: 'pending', url: '', blob: null }));
    renderPage(page);
    try {
      await Promise.all(page.chunks.map((chunk) => ttsLimit(async () => {
        try {
          const blob = await synthesize(chunk.text);
          chunk.blob = blob;
          chunk.url = URL.createObjectURL(blob);
          chunk.status = 'ready';
        } catch (e) {
          chunk.status = 'error';
          chunk.error = e.message || String(e);
          throw e;
        } finally {
          renderPage(page);
          updatePlayerVisibility();
        }
      })));
      setStatus(page, 'audio');
    } catch (e) {
      // Partial success is fine — surface that some chunks failed.
      const ok = page.chunks.filter((c) => c.status === 'ready').length;
      setStatus(page, ok ? 'audio' : 'error',
        ok ? '' : (e.message || 'Audio generation failed.'));
      if (ok && ok < page.chunks.length) {
        toast('Page ' + pageNum(page) + ': ' + ok + '/' + page.chunks.length +
          ' segments generated. Retry to fill the gaps.');
      }
    }
    savePage(page);
    updatePlayerVisibility();
  }

  function transcribeAll() {
    const todo = pages.filter((p) =>
      (p.status === 'ready' || p.status === 'error') && p.jpegBlob);
    if (!todo.length) { toast('Nothing to transcribe.'); return; }
    todo.forEach(transcribePage);
  }
  function generateAllAudio() {
    const todo = pages.filter((p) =>
      (p.text || '').trim() &&
      p.status !== 'generating' &&
      !(p.status === 'audio' && p.chunks && p.chunks.every((c) => c.status === 'ready')));
    if (!todo.length) { toast('No pages ready for audio yet. Transcribe first.'); return; }
    todo.forEach(generatePageAudio);
  }

  /* ════════════════════════ rendering ════════════════════════ */
  function pageNum(page) { return pages.indexOf(page) + 1; }

  const BADGE = {
    loading: ['Loading image…', 'b-transcribing', true],
    ready: ['Ready to transcribe', 'b-transcribed', false],
    transcribing: ['Transcribing…', 'b-transcribing', true],
    transcribed: ['Transcribed — review', 'b-transcribed', false],
    generating: ['Generating audio…', 'b-generating', true],
    audio: ['Audio ready', 'b-audio', false],
    error: ['Error', 'b-error', false],
  };

  function renderPage(page) {
    let li = document.getElementById('page-' + page.id);
    if (!li) {
      li = document.createElement('li');
      li.className = 'page';
      li.id = 'page-' + page.id;
      el.pages.appendChild(li);
    }
    const [label, cls, spin] = BADGE[page.status] || ['', '', false];
    const n = pageNum(page);
    const playing = playerCurrent && playerCurrent.page === page;
    li.classList.toggle('playing', !!playing);

    const canTranscribe = !!page.jpegBlob && page.status !== 'transcribing' && page.status !== 'loading';
    const canAudio = !!(page.text || '').trim() && page.status !== 'generating';
    const chunkInfo = page.chunks
      ? `<span class="chips">${page.chunks.filter((c) => c.status === 'ready').length}/${page.chunks.length} audio segments</span>`
      : '';

    li.innerHTML = `
      <img class="thumb" alt="page ${n}" ${page.thumbUrl ? `src="${page.thumbUrl}"` : ''} />
      <div class="page-body">
        <div class="page-head">
          <span class="page-num">Page ${n}</span>
          <span class="badge ${cls}">${spin ? '<span class="spinner"></span> ' : ''}${esc(label)}</span>
          <span class="page-name">${esc(page.name)}</span>
        </div>
        ${page.status === 'transcribed' || page.status === 'audio' || page.status === 'generating' || (page.text)
          ? `<textarea class="page-text" placeholder="Transcribed text will appear here — edit freely.">${esc(page.text)}</textarea>`
          : ''}
        <div class="page-actions">
          <button class="act-transcribe ghost" ${canTranscribe ? '' : 'disabled'}>${page.text ? 'Re-transcribe' : 'Transcribe'}</button>
          <button class="act-audio" ${canAudio ? '' : 'disabled'}>${page.chunks ? 'Regenerate audio' : 'Generate audio'}</button>
          ${page.chunks && page.chunks.some((c) => c.status === 'ready')
            ? `<button class="act-play ghost">▶ Play from here</button>` : ''}
          <button class="act-remove ghost danger">Remove</button>
          ${chunkInfo}
        </div>
        ${page.error ? `<div class="page-err">⚠ ${esc(page.error)}</div>` : ''}
      </div>`;

    // wire up
    const ta = li.querySelector('.page-text');
    if (ta) {
      ta.addEventListener('input', () => {
        page.text = ta.value;
        // editing invalidates existing audio
        if (page.chunks) {
          revokePageAudio(page); page.chunks = null;
          if (page.status === 'audio') page.status = 'transcribed';
          updatePlayerVisibility(); // drop stale segments from the queue
        }
        saveDebounced(page);
      });
    }
    li.querySelector('.act-transcribe').onclick = () => transcribePage(page);
    li.querySelector('.act-audio').onclick = () => generatePageAudio(page);
    const playBtn = li.querySelector('.act-play');
    if (playBtn) playBtn.onclick = () => playFromPage(page);
    li.querySelector('.act-remove').onclick = () => removePage(page);
  }

  function renderAllPages() { pages.forEach(renderPage); }

  // Lightweight: toggle the "playing" highlight without rebuilding textareas.
  function updatePlayingHighlight() {
    for (const page of pages) {
      const li = document.getElementById('page-' + page.id);
      if (li) li.classList.toggle('playing', !!(playerCurrent && playerCurrent.page === page));
    }
  }

  function removePage(page) {
    revokePageAudio(page);
    if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
    if (playerCurrent && playerCurrent.page === page) stopPlayback();
    pages = pages.filter((p) => p !== page);
    idbDelete(page.id);
    saveOrder(); // remaining page order shifted
    const li = document.getElementById('page-' + page.id);
    if (li) li.remove();
    renderAllPages(); // page numbers shift
    updateBatchUI();
    updatePlayerVisibility();
    if (!pages.length) el.pagesSection.hidden = true;
  }
  function revokePageAudio(page) {
    if (!page.chunks) return;
    for (const c of page.chunks) if (c.url) { URL.revokeObjectURL(c.url); c.url = ''; }
  }

  function updateBatchUI() {
    el.batchActions.hidden = pages.length === 0;
    const counts = { total: pages.length, transcribed: 0, audio: 0, err: 0 };
    for (const p of pages) {
      if (p.text && p.text.trim()) counts.transcribed++;
      if (p.status === 'audio') counts.audio++;
      if (p.status === 'error') counts.err++;
    }
    let chars = 0;
    for (const p of pages) chars += (p.text || '').length;
    const parts = [`${counts.total} page${counts.total === 1 ? '' : 's'}`];
    if (counts.transcribed) parts.push(`${counts.transcribed} transcribed`);
    if (counts.audio) parts.push(`${counts.audio} with audio`);
    if (counts.err) parts.push(`${counts.err} error${counts.err === 1 ? '' : 's'}`);
    if (chars) parts.push(`~${chars.toLocaleString()} characters`);
    el.batchSummary.textContent = parts.join(' · ');
  }

  /* ════════════════════════ playback queue ════════════════════════
   * The queue is derived from page order; only "ready" chunks appear.
   * It is rebuilt on demand so newly-finished pages join seamlessly
   * while earlier ones are already playing. */
  function buildQueue() {
    const q = [];
    for (const page of pages) {
      if (!page.chunks) continue;
      page.chunks.forEach((chunk, ci) => {
        if (chunk.status === 'ready' && chunk.url) q.push({ page, chunk, ci });
      });
    }
    return q;
  }
  function currentIndex(q) {
    if (!playerCurrent) return -1;
    return q.findIndex((it) => it.chunk === playerCurrent.chunk);
  }
  function playAt(i) {
    const q = buildQueue();
    if (!q.length) return;
    i = Math.max(0, Math.min(i, q.length - 1));
    const item = q[i];
    playerCurrent = { page: item.page, chunk: item.chunk };
    userWantsPlaying = true;
    el.audio.src = item.chunk.url;
    el.audio.playbackRate = parseFloat(el.pSpeed.value) || 1;
    el.audio.play().catch((e) => {
      // iOS blocks playback outside a gesture; the big button is a gesture,
      // so this mainly guards programmatic edge cases.
      toast('Tap ▶ to start playback.');
    });
    updatePlayingHighlight();
    updatePlayerUI();
  }
  function playFromPage(page) {
    const q = buildQueue();
    const i = q.findIndex((it) => it.page === page);
    if (i >= 0) playAt(i);
    else toast('No audio for this page yet.');
  }
  function togglePlay() {
    if (!playerCurrent) {
      const q = buildQueue();
      if (q.length) playAt(0); else toast('Generate some audio first.');
      return;
    }
    if (el.audio.paused) {
      userWantsPlaying = true;
      el.audio.play().catch(() => {});
    } else {
      userWantsPlaying = false;
      el.audio.pause();
    }
    updatePlayerUI();
  }
  function stepSegment(delta) {
    const q = buildQueue();
    const i = currentIndex(q);
    if (i < 0) { if (q.length) playAt(0); return; }
    playAt(i + delta);
  }
  function stopPlayback() {
    userWantsPlaying = false;
    el.audio.pause();
    el.audio.removeAttribute('src');
    el.audio.load();
    playerCurrent = null;
    updatePlayingHighlight();
    updatePlayerUI();
  }
  function onEnded() {
    const q = buildQueue();
    const i = currentIndex(q);
    if (i >= 0 && i < q.length - 1) { playAt(i + 1); return; }
    // Reached the end of what's currently available.
    userWantsPlaying = false;
    updatePlayerUI();
  }
  function updatePlayerVisibility() {
    const has = buildQueue().length > 0;
    el.playerBar.hidden = !has;
    if (!has && playerCurrent) stopPlayback();
    syncPlayerSpacer();
    updatePlayerUI();
  }
  // Reserve exactly the player's height at the page bottom so the fixed bar
  // never covers the last page's controls (height varies with safe-area inset
  // and wrapping, so measure rather than guess).
  function syncPlayerSpacer() {
    requestAnimationFrame(() => {
      const h = el.playerBar.hidden ? 0 : el.playerBar.offsetHeight;
      el.main.style.paddingBottom = (h + 24) + 'px';
    });
  }
  function updatePlayerUI() {
    const q = buildQueue();
    const i = currentIndex(q);
    el.pBigPlay.textContent = (!el.audio.paused && playerCurrent) ? '⏸' : '▶';
    if (playerCurrent && i >= 0) {
      const total = q.length;
      el.pNow.textContent = `Page ${pageNum(playerCurrent.page)} · segment ${i + 1} of ${total}`;
    } else {
      el.pNow.textContent = q.length ? 'Ready — tap play' : 'Nothing playing';
    }
    el.pPrev.disabled = el.pNext.disabled = q.length === 0;
  }

  /* ════════════════════════ events ════════════════════════ */
  function wire() {
    // key
    el.saveKey.onclick = () => {
      const v = el.apiKey.value.trim();
      if (!v) { toast('Paste a key first.'); return; }
      if (!/^sk-/.test(v)) toast('Heads up: keys usually start with "sk-".');
      localStorage.setItem(LS_KEY, v);
      el.apiKey.value = '';
      refreshKeyStatus();
    };
    el.clearKey.onclick = () => {
      localStorage.removeItem(LS_KEY);
      el.apiKey.value = '';
      refreshKeyStatus();
    };
    el.toggleKey.onclick = () => {
      el.apiKey.type = el.apiKey.type === 'password' ? 'text' : 'password';
    };
    el.apiKey.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.saveKey.click(); });

    // settings (persist on change)
    [el.visionModel, el.ocrLang, el.ttsModel, el.ttsModelCustom, el.voice, el.maxChars, el.ttsInstructions]
      .forEach((node) => node.addEventListener('change', saveSettings));
    el.ocrEngine.addEventListener('change', () => { saveSettings(); updateEngineUI(); });

    // Google Cloud Vision key
    el.saveGoogleKey.onclick = () => {
      const v = el.googleKey.value.trim();
      if (!v) { toast('Paste a Google Vision key first.'); return; }
      localStorage.setItem(LS_GOOGLE_KEY, v);
      el.googleKey.value = '';
      refreshGoogleKeyStatus();
    };
    el.clearGoogleKey.onclick = () => {
      localStorage.removeItem(LS_GOOGLE_KEY);
      el.googleKey.value = '';
      refreshGoogleKeyStatus();
    };
    el.toggleGoogleKey.onclick = () => {
      el.googleKey.type = el.googleKey.type === 'password' ? 'text' : 'password';
    };

    // upload
    el.dropzone.onclick = () => el.fileInput.click();
    el.dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
    });
    el.fileInput.onchange = () => { if (el.fileInput.files.length) addFiles(el.fileInput.files); el.fileInput.value = ''; };
    ['dragenter', 'dragover'].forEach((ev) => el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); el.dropzone.classList.add('drag');
    }));
    ['dragleave', 'drop'].forEach((ev) => el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); el.dropzone.classList.remove('drag');
    }));
    el.dropzone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    // batch
    el.transcribeAll.onclick = transcribeAll;
    el.generateAll.onclick = generateAllAudio;
    el.clearAll.onclick = () => {
      if (pages.length && !confirm('Remove all pages? This also clears the copy saved in this browser.')) return;
      idbClear();
      [...pages].forEach(removePage);
    };

    // player
    el.pBigPlay.onclick = togglePlay;
    el.pPrev.onclick = () => stepSegment(-1);
    el.pNext.onclick = () => stepSegment(1);
    el.pSpeed.onchange = () => { el.audio.playbackRate = parseFloat(el.pSpeed.value) || 1; };
    el.audio.addEventListener('ended', onEnded);
    el.audio.addEventListener('play', updatePlayerUI);
    el.audio.addEventListener('pause', updatePlayerUI);
    el.audio.addEventListener('timeupdate', () => {
      const d = el.audio.duration;
      if (isFinite(d) && d > 0) {
        el.pSeek.value = String(Math.round((el.audio.currentTime / d) * 1000));
        el.pCur.textContent = fmtTime(el.audio.currentTime);
        el.pDur.textContent = fmtTime(d);
      }
    });
    el.pSeek.addEventListener('input', () => {
      const d = el.audio.duration;
      if (isFinite(d) && d > 0) el.audio.currentTime = (parseInt(el.pSeek.value, 10) / 1000) * d;
    });

    // Keep the bottom spacer in sync when the player wraps / device rotates.
    window.addEventListener('resize', syncPlayerSpacer);
    window.addEventListener('orientationchange', syncPlayerSpacer);
  }

  /* ════════════════════════ init ════════════════════════ */
  function init() {
    hydrateSettingsUI();
    refreshKeyStatus();
    wire();
    syncPlayerSpacer();
    restorePages(); // bring back any saved batch
  }
  document.addEventListener('DOMContentLoaded', init);
})();
