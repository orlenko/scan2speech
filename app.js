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
    // gpt-5.5 tested cleanest on dense non-English OCR (faithful AND well-ordered).
    // Fall back to gpt-4o / gpt-4.1 if a key lacks access; never use -mini (misreads).
    VISION_MODEL: 'gpt-5.5',
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
  const LS_SETTINGS = 's2s_settings';
  const SETTINGS_VERSION = 2;  // bump to re-migrate stale saved settings

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
    visionModel: $('visionModel'), ocrLang: $('ocrLang'), ttsModel: $('ttsModel'),
    ttsModelCustom: $('ttsModelCustom'), voice: $('voice'),
    maxChars: $('maxChars'), ttsInstructions: $('ttsInstructions'),
    dropzone: $('dropzone'), fileInput: $('fileInput'),
    batchActions: $('batchActions'), transcribeAll: $('transcribeAll'),
    generateAll: $('generateAll'), clearAll: $('clearAll'),
    batchSummary: $('batchSummary'), progressFill: $('progressFill'),
    downloadAll: $('downloadAll'),
    main: document.querySelector('main'),
    pagesSection: $('pagesSection'), pages: $('pages'),
    playerBar: $('playerBar'), audio: $('audio'),
    pBigPlay: $('pBigPlay'), pNow: $('pNow'), pSeek: $('pSeek'),
    pCur: $('pCur'), pDur: $('pDur'), pPrev: $('pPrev'), pNext: $('pNext'),
    pSpeed: $('pSpeed'), toast: $('toast'),
    cameraBtn: $('cameraBtn'), autoFix: $('autoFix'),
    cameraOverlay: $('cameraOverlay'), camVideo: $('camVideo'),
    camShutter: $('camShutter'), camClose: $('camClose'), camCount: $('camCount'),
    camError: $('camError'),
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
      srcBlob: page.srcBlob || null,
      edit: page.edit || { rotate: 0, autofix: false },
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
        srcBlob: rec.srcBlob || rec.jpegBlob, // older records lack a base
        edit: rec.edit || { rotate: 0, autofix: false },
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
    // One-time migration: stale settings adopt the new model default (so users
    // don't have to touch Advanced settings) and drop removed fields.
    const migrate = s.v !== SETTINGS_VERSION;
    if (migrate) { try { localStorage.removeItem('s2s_google_key'); } catch (_) {} }
    const out = {
      v: SETTINGS_VERSION,
      visionModel: migrate ? CONFIG.VISION_MODEL : (s.visionModel || CONFIG.VISION_MODEL),
      ocrLang: s.ocrLang != null ? s.ocrLang : CONFIG.OCR_LANG,
      ttsModel: s.ttsModel || CONFIG.TTS_MODEL,
      voice: s.voice || CONFIG.VOICE,
      maxChars: clampInt(s.maxChars, 500, 4000, CONFIG.MAX_CHARS),
      ttsInstructions: s.ttsInstructions != null ? s.ttsInstructions : CONFIG.TTS_INSTRUCTIONS,
      autoFix: s.autoFix != null ? !!s.autoFix : true,
    };
    if (migrate) { try { localStorage.setItem(LS_SETTINGS, JSON.stringify(out)); } catch (_) {} }
    return out;
  }
  function clampInt(v, lo, hi, dflt) {
    v = parseInt(v, 10);
    if (!isFinite(v)) return dflt;
    return Math.min(hi, Math.max(lo, v));
  }
  function saveSettings() {
    const custom = el.ttsModelCustom.value.trim();
    settings = {
      v: SETTINGS_VERSION,
      visionModel: el.visionModel.value.trim() || CONFIG.VISION_MODEL,
      ocrLang: el.ocrLang.value.trim(),
      ttsModel: custom || el.ttsModel.value,
      voice: el.voice.value,
      maxChars: clampInt(el.maxChars.value, 500, 4000, CONFIG.MAX_CHARS),
      ttsInstructions: el.ttsInstructions.value,
      autoFix: !!el.autoFix.checked,
    };
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  }
  function hydrateSettingsUI() {
    el.visionModel.value = settings.visionModel;
    el.ocrLang.value = settings.ocrLang;
    el.maxChars.value = settings.maxChars;
    el.ttsInstructions.value = settings.ttsInstructions;
    el.autoFix.checked = settings.autoFix;
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

  // Chat completion that downgrades params on HTTP 400 so older models
  // (temperature 0 + max_tokens) and newer ones (gpt-5.x, which reject those
  // and want max_completion_tokens / default temperature) both work.
  async function chatComplete(messages) {
    const variants = [
      { temperature: 0, max_tokens: 4096 },
      { temperature: 0, max_completion_tokens: 4096 },
      { max_completion_tokens: 4096 },
      {},
    ];
    let lastErr;
    for (const extra of variants) {
      try {
        const data = await apiFetch(CONFIG.CHAT_ENDPOINT,
          Object.assign({ model: settings.visionModel, messages }, extra));
        return data?.choices?.[0]?.message?.content?.trim() || '';
      } catch (e) {
        lastErr = e;
        if (e instanceof ApiError && e.status === 400) continue; // try simpler params
        throw e;
      }
    }
    throw lastErr;
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
    const text = await chatComplete([
      { role: 'system', content: sys },
      { role: 'user', content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      ] },
    ]);
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
  const SRC_DIM = 2200;   // editable base resolution (kept so edits are non-destructive)

  // Decode a File/Blob/Canvas and draw it downscaled (longest side ≤ maxDim).
  async function toCanvas(src, maxDim) {
    const bmp = (src instanceof HTMLCanvasElement) ? src : await loadBitmap(src);
    const w = bmp.width, h = bmp.height;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
    if (bmp.close) bmp.close();
    return c;
  }
  const canvasToBlob = (c, q) => new Promise((res) => c.toBlob(res, 'image/jpeg', q || CONFIG.JPEG_QUALITY));

  // Rotate by a multiple of 90° into a new canvas.
  function rotateCanvas(src, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (!deg) return src;
    const swap = (deg === 90 || deg === 270);
    const c = document.createElement('canvas');
    c.width = swap ? src.height : src.width;
    c.height = swap ? src.width : src.height;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }
  // Rotate by an arbitrary (small) angle, expanding the canvas with a white bg.
  function rotateFine(src, deg) {
    const rad = deg * Math.PI / 180;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const w = src.width, h = src.height;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * cos + h * sin); c.height = Math.ceil(w * sin + h * cos);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2); ctx.rotate(rad);
    ctx.drawImage(src, -w / 2, -h / 2);
    return c;
  }

  /* ── dependency-free auto-fix: orient (0/90), deskew, crop to text ── */
  function analyzeGray(src, maxW) {
    const s = Math.min(1, maxW / src.width);
    const w = Math.max(1, Math.round(src.width * s)), h = Math.max(1, Math.round(src.height * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    let sum = 0;
    for (let i = 0; i < w * h; i++) {
      const l = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
      lum[i] = l; sum += l;
    }
    const thr = (sum / (w * h)) * 0.72; // dark = well below mean (ink on paper)
    const dark = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) dark[i] = lum[i] < thr ? 1 : 0;
    return { dark, w, h };
  }
  function projEnergy(dark, w, h, vertical) {
    let s = 0;
    if (!vertical) { for (let y = 0; y < h; y++) { let c = 0; for (let x = 0; x < w; x++) c += dark[y * w + x]; s += c * c; } }
    else { for (let x = 0; x < w; x++) { let c = 0; for (let y = 0; y < h; y++) c += dark[y * w + x]; s += c * c; } }
    return s;
  }
  function skewFromDark(dark, w, h) {
    const pts = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (dark[y * w + x]) pts.push([x - w / 2, y]);
    if (pts.length < 60) return 0;
    const off = Math.ceil((w / 2) * Math.tan(8 * Math.PI / 180)) + 1, nb = h + 2 * off;
    let best = 0, bestScore = -1;
    for (let deg = -8; deg <= 8.0001; deg += 0.25) {
      const t = Math.tan(deg * Math.PI / 180), bins = new Float64Array(nb);
      for (let k = 0; k < pts.length; k++) { const idx = (pts[k][1] - Math.round(pts[k][0] * t)) + off; if (idx >= 0 && idx < nb) bins[idx]++; }
      let s = 0; for (let i = 0; i < nb; i++) s += bins[i] * bins[i];
      if (s > bestScore) { bestScore = s; best = deg; }
    }
    return best;
  }
  function textBBox(dark, w, h) {
    const rows = new Float64Array(h), cols = new Float64Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (dark[y * w + x]) { rows[y]++; cols[x]++; }
    const rt = 0.02 * w, ct = 0.02 * h;
    let y0 = 0; while (y0 < h && rows[y0] < rt) y0++;
    let y1 = h - 1; while (y1 > y0 && rows[y1] < rt) y1--;
    let x0 = 0; while (x0 < w && cols[x0] < ct) x0++;
    let x1 = w - 1; while (x1 > x0 && cols[x1] < ct) x1--;
    if (x1 <= x0 || y1 <= y0) return null;
    const mx = Math.round(w * 0.03), my = Math.round(h * 0.03);
    return { x0: Math.max(0, x0 - mx), y0: Math.max(0, y0 - my), x1: Math.min(w, x1 + mx), y1: Math.min(h, y1 + my) };
  }
  // Best-effort. Conservative thresholds; returns the input on any trouble.
  function autoFixToCanvas(src) {
    try {
      let base = src;
      let g = analyzeGray(base, 800);
      // coarse 0 vs 90: text lines should be horizontal (row energy ≫ col energy)
      if (projEnergy(g.dark, g.w, g.h, true) > projEnergy(g.dark, g.w, g.h, false) * 1.3) {
        base = rotateCanvas(base, 90); g = analyzeGray(base, 800);
      }
      // fine deskew
      const deg = skewFromDark(g.dark, g.w, g.h);
      if (Math.abs(deg) > 0.4 && Math.abs(deg) < 8) { base = rotateFine(base, -deg); g = analyzeGray(base, 800); }
      // crop to text block (only if it trims a real margin but keeps most of the page)
      const box = textBBox(g.dark, g.w, g.h);
      if (box) {
        const fx = base.width / g.w, fy = base.height / g.h;
        const sx = box.x0 * fx, sy = box.y0 * fy, sw = (box.x1 - box.x0) * fx, sh = (box.y1 - box.y0) * fy;
        const area = sw * sh, full = base.width * base.height;
        if (area < full * 0.97 && area > full * 0.35) {
          const c = document.createElement('canvas'); c.width = Math.round(sw); c.height = Math.round(sh);
          c.getContext('2d').drawImage(base, sx, sy, sw, sh, 0, 0, c.width, c.height);
          base = c;
        }
      }
      return base;
    } catch (_) { return src; }
  }

  // Build the editable base blob from any source (decode + downscale to SRC_DIM).
  async function buildBase(src) {
    let canvas;
    try { canvas = await toCanvas(src, SRC_DIM); }
    catch (_) {
      throw new Error('Could not read this image. If it is a HEIC photo, your ' +
        'browser cannot decode it — re-save as JPEG or PNG.');
    }
    return canvasToBlob(canvas, 0.92);
  }
  // Derive the image actually sent + shown, applying the page's edits.
  async function deriveSend(srcBlob, edit) {
    let c = await toCanvas(srcBlob, SRC_DIM);
    if (edit && edit.rotate) c = rotateCanvas(c, edit.rotate);
    if (edit && edit.autofix) c = autoFixToCanvas(c);
    if (Math.max(c.width, c.height) > CONFIG.MAX_IMAGE_DIM) c = await toCanvas(c, CONFIG.MAX_IMAGE_DIM);
    const jpegBlob = await canvasToBlob(c, CONFIG.JPEG_QUALITY);
    return { jpegBlob, thumbUrl: URL.createObjectURL(jpegBlob) };
  }


  /* ════════════════════════ page lifecycle ════════════════════════ */
  function setStatus(page, status, error) {
    page.status = status;
    page.error = error || '';
    renderPage(page);
    updateBatchUI();
  }

  // Add pages from any sources: [{ data: File|Blob, name }]. Used by both the
  // file picker and the in-app camera.
  function addSources(sources, opts) {
    opts = opts || {};
    if (!sources.length) return;
    const hadNone = pages.length === 0;
    const haveKey = !!getKey();
    const autofix = opts.autofix != null ? opts.autofix : !!settings.autoFix;
    el.pagesSection.hidden = false;
    for (const s of sources) {
      const page = {
        id: uid(), name: s.name || 'photo.jpg', status: 'loading',
        thumbUrl: '', srcBlob: null, jpegBlob: null, text: '', error: '', chunks: null,
        edit: { rotate: 0, autofix: autofix },
      };
      pages.push(page);
      renderPage(page);
      // Decode → editable base → send image (thumbnail), then auto-transcribe.
      page._prep = (async () => {
        page.srcBlob = await buildBase(s.data);
        const { jpegBlob, thumbUrl } = await deriveSend(page.srcBlob, page.edit);
        page.jpegBlob = jpegBlob; page.thumbUrl = thumbUrl;
        setStatus(page, 'ready');
        savePage(page);
        if (haveKey) startTranscribe(page);
      })().catch((e) => setStatus(page, 'error', e.message || 'Could not read image.'));
    }
    saveOrder();
    updateBatchUI();
    if (hadNone && !opts.quiet) requestAnimationFrame(() =>
      el.pagesSection.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    if (!opts.quiet) toast(sources.length + ' page' + (sources.length === 1 ? '' : 's') + ' added' +
      (haveKey ? ' — transcribing…' : '. Add your API key to transcribe.'));
  }
  function addFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/') ||
      /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    if (!files.length) { toast('No images found in that selection.'); return; }
    addSources(files.map((f) => ({ data: f, name: f.name })));
  }

  // Re-derive the send image from the editable base after a rotate/auto-fix;
  // the image changed, so the old transcription/audio are dropped and we re-OCR.
  async function reprocessPage(page) {
    if (!page.srcBlob) return;
    setStatus(page, 'loading');
    try {
      if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
      const { jpegBlob, thumbUrl } = await deriveSend(page.srcBlob, page.edit);
      page.jpegBlob = jpegBlob; page.thumbUrl = thumbUrl;
      revokePageAudio(page); page.chunks = null; page.text = ''; page._txp = null;
      setStatus(page, 'ready');
      savePage(page);
      if (getKey()) startTranscribe(page);
    } catch (e) { setStatus(page, 'error', e.message || 'Could not process image.'); }
  }
  function rotatePage(page, delta) {
    page.edit = page.edit || { rotate: 0, autofix: false };
    page.edit.rotate = (((page.edit.rotate || 0) + delta) % 360 + 360) % 360;
    reprocessPage(page);
  }
  function toggleAutofix(page) {
    page.edit = page.edit || { rotate: 0, autofix: false };
    page.edit.autofix = !page.edit.autofix;
    reprocessPage(page);
  }

  /* ════════════════════════ in-app camera ════════════════════════ */
  let camStream = null, camShots = 0;
  async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('This browser has no camera access — use “choose photos” instead.'); return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      });
    } catch (e) {
      // Denied/unavailable: stay on the upload screen, don't show a blank overlay.
      toast('Camera unavailable (' + (e.name || 'permission denied') +
        '). Use “…or choose existing photos” instead.');
      return;
    }
    camStream = stream;
    el.camError.hidden = true;
    el.camVideo.srcObject = stream;
    el.camVideo.play().catch(() => {});
    camShots = 0; el.camCount.textContent = '0';
    el.cameraOverlay.hidden = false; // only after the stream is live
  }
  function closeCamera() {
    if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
    el.camVideo.srcObject = null;
    el.cameraOverlay.hidden = true;
    if (camShots) {
      toast(camShots + ' photo' + (camShots === 1 ? '' : 's') + ' added' +
        (getKey() ? ' — transcribing…' : '. Add your API key to transcribe.'));
      if (!el.pagesSection.hidden) el.pagesSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  async function capturePhoto() {
    const v = el.camVideo;
    if (!v.videoWidth) { toast('Camera still warming up…'); return; }
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const blob = await canvasToBlob(c, 0.95);
    camShots++;
    el.camCount.textContent = String(camShots);
    el.camShutter.classList.add('flash');
    setTimeout(() => el.camShutter.classList.remove('flash'), 160);
    addSources([{ data: blob, name: 'photo-' + camShots + '.jpg' }], { quiet: true });
  }


  const ocrLimit = pLimit(CONFIG.OCR_CONCURRENCY);
  const ttsLimit = pLimit(CONFIG.TTS_CONCURRENCY);

  async function transcribePage(page) {
    if (!page.jpegBlob) { toast('Image still loading — try again in a moment.'); return; }
    if (page.status === 'transcribing') return;
    setStatus(page, 'transcribing');
    try {
      const text = await ocrLimit(async () =>
        transcribeImage(await blobToDataURL(page.jpegBlob)));
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

  // One in-flight transcription per page; callers can await the shared promise
  // (so e.g. "Convert all" can wait on a transcription auto-started at upload).
  function startTranscribe(page) {
    if (page._txp) return page._txp;
    page._txp = transcribePage(page).finally(() => { page._txp = null; });
    return page._txp;
  }

  function transcribeAll() {
    const todo = pages.filter((p) => p.jpegBlob);
    if (!todo.length) { toast('Add some photos first.'); return; }
    todo.forEach(startTranscribe);
  }

  // One-tap pipeline: for every page, wait for its image, transcribe if needed
  // (or wait for an in-flight transcription), then make audio — quietly and in
  // order. Per-page concurrency is throttled inside the OCR/TTS limiters.
  async function makeAudiobook() {
    if (!pages.length) { toast('Add some photos first.'); return; }
    if (!getKey()) { toast('Add your OpenAI API key first.'); return; }
    toast('Converting ' + pages.length + ' page' + (pages.length === 1 ? '' : 's') + ' to audio…');
    await Promise.all(pages.map(audiobookPage));
    const ok = pages.filter((p) => p.status === 'audio').length;
    if (ok) toast(ok + ' page' + (ok === 1 ? '' : 's') + ' ready — tap ▶ to listen.');
  }
  async function audiobookPage(page) {
    try {
      if (page._prep) { try { await page._prep; } catch (_) {} } // wait for the image
      if (!page.jpegBlob) return;                                // image couldn't load
      if (!(page.text || '').trim() || page.status === 'transcribing') {
        await startTranscribe(page);
      }
      if (!(page.text || '').trim()) return;                     // transcription failed → skip
      const hasAudio = page.chunks && page.chunks.length &&
        page.chunks.every((c) => c.status === 'ready');
      if (!hasAudio) await generatePageAudio(page);
    } catch (_) { /* per-page errors already surfaced on the card */ }
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
    const canEdit = !!page.srcBlob && page.status !== 'loading';
    const autofixed = !!(page.edit && page.edit.autofix);
    const chunkInfo = page.chunks
      ? `<span class="chips">${page.chunks.filter((c) => c.status === 'ready').length}/${page.chunks.length} audio segments</span>`
      : '';

    li.innerHTML = `
      ${page.thumbUrl
        ? `<a class="thumb-link" href="${page.thumbUrl}" target="_blank" rel="noopener" title="Open full image in a new tab"><img class="thumb" alt="page ${n}" src="${page.thumbUrl}" /><span class="thumb-zoom">⤢</span></a>`
        : `<img class="thumb" alt="page ${n}" />`}
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
          <button class="act-rotl ghost icon" title="Rotate left" ${canEdit ? '' : 'disabled'}>⟲</button>
          <button class="act-rotr ghost icon" title="Rotate right" ${canEdit ? '' : 'disabled'}>⟳</button>
          <button class="act-autofix ghost" title="Auto-orient, straighten &amp; crop to text" ${canEdit ? '' : 'disabled'}>${autofixed ? 'Auto-fix ✓' : 'Auto-fix'}</button>
          <span class="act-sep"></span>
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
    const rl = li.querySelector('.act-rotl'); if (rl) rl.onclick = () => rotatePage(page, -90);
    const rr = li.querySelector('.act-rotr'); if (rr) rr.onclick = () => rotatePage(page, 90);
    const af = li.querySelector('.act-autofix'); if (af) af.onclick = () => toggleAutofix(page);
    li.querySelector('.act-transcribe').onclick = () => startTranscribe(page);
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
    const c = { total: pages.length, transcribed: 0, audio: 0, err: 0, transcribing: 0, generating: 0 };
    for (const p of pages) {
      if (p.text && p.text.trim()) c.transcribed++;
      if (p.status === 'audio') c.audio++;
      if (p.status === 'error') c.err++;
      if (p.status === 'transcribing') c.transcribing++;
      if (p.status === 'generating') c.generating++;
    }
    // Two-stage progress: each page is half transcription, half audio.
    const pct = c.total ? Math.round((c.transcribed * 0.5 + c.audio * 0.5) / c.total * 100) : 0;
    if (el.progressFill) el.progressFill.style.width = pct + '%';

    const parts = [`${c.total} page${c.total === 1 ? '' : 's'}`];
    if (c.transcribing) parts.push(`${c.transcribing} transcribing…`);
    if (c.generating) parts.push(`${c.generating} making audio…`);
    if (c.transcribed) parts.push(`${c.transcribed} transcribed`);
    if (c.audio) parts.push(`${c.audio} with audio`);
    if (c.err) parts.push(`${c.err} error${c.err === 1 ? '' : 's'}`);
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
    [el.visionModel, el.ocrLang, el.ttsModel, el.ttsModelCustom, el.voice, el.maxChars, el.ttsInstructions, el.autoFix]
      .forEach((node) => node.addEventListener('change', saveSettings));

    // camera
    el.cameraBtn.onclick = openCamera;
    el.camShutter.onclick = capturePhoto;
    el.camClose.onclick = closeCamera;

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
    el.generateAll.onclick = makeAudiobook;
    el.downloadAll.onclick = downloadAll;
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

  /* ════════════════════════ download / export ════════════════════════
   * Bundle transcripts + audio into a single .zip the user can keep offline.
   * Built with a minimal STORE-method (no compression) ZIP writer so the page
   * stays dependency-free — audio is already compressed, so STORE is fine. */
  let _crcTable;
  function crc32(buf) {
    if (!_crcTable) {
      _crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        _crcTable[n] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function makeZip(entries) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    const body = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = e.bytes;
      const crc = crc32(data), size = data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      body.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true);
    eo.setUint16(8, entries.length, true); eo.setUint16(10, entries.length, true);
    eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true);
    return new Blob([...body, ...central, new Uint8Array(eo.buffer)], { type: 'application/zip' });
  }
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
  async function downloadAll() {
    const usable = pages.filter((p) => (p.text || '').trim() ||
      (p.chunks && p.chunks.some((c) => c.status === 'ready')));
    if (!usable.length) { toast('Nothing to download yet — transcribe or convert first.'); return; }
    el.downloadAll.disabled = true;
    toast('Packaging download…');
    try {
      const enc = new TextEncoder();
      const entries = [];
      const combined = [];
      let n = 0;
      for (const p of pages) {
        n++;
        const num = String(n).padStart(3, '0');
        const text = (p.text || '').trim();
        if (text) {
          entries.push({ name: `page-${num}.txt`, bytes: enc.encode(text) });
          combined.push(`===== Page ${n} =====\n\n${text}\n`);
        }
        if (p.chunks && p.chunks.some((c) => c.status === 'ready')) {
          const parts = p.chunks.filter((c) => c.status === 'ready' && c.blob).map((c) => c.blob);
          const bytes = new Uint8Array(await new Blob(parts, { type: 'audio/mpeg' }).arrayBuffer());
          entries.push({ name: `page-${num}.mp3`, bytes });
        }
      }
      if (combined.length) entries.push({ name: 'transcript.txt', bytes: enc.encode(combined.join('\n')) });
      const stamp = new Date().toISOString().slice(0, 10);
      triggerDownload(makeZip(entries), `scan2speech-${stamp}.zip`);
      toast('Download ready.');
    } catch (e) {
      toast('Could not build the download: ' + (e.message || e));
    } finally {
      el.downloadAll.disabled = false;
    }
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
