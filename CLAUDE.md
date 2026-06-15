# CLAUDE.md — Scan2Speech

Guidance for AI assistants (and humans) working in this repo.

## What this is

A **single static web page** that turns photos of physical book pages into
listenable audio using the **OpenAI API**, with the user's **own API key**.
No accounts, no backend, no hosted secrets. Publishable as-is to GitHub Pages.

The dream it serves: *"I want the next hundred pages of this book but no time to
read them — I'll snap a hundred photos, drop them in, and listen while I drive."*

## Theming (paper-book look + day/night)

- Warm paper-book aesthetic. All theming keys off `<html data-theme="light|dark">`;
  day is `:root`, night is `:root[data-theme="dark"]`. There is intentionally **no**
  `prefers-color-scheme` CSS rule.
- Two tiny inline scripts in `index.html` (the only JS outside `app.js`): a
  **pre-paint resolver** in `<head>` (sets `data-theme` from `localStorage['s2s-theme']`
  else the system preference, avoiding a flash) and a **toggle** (`#themeToggle` 🌙/☀️)
  before `app.js`. `app.js` is untouched by theming.
- Fonts load from the Google Fonts CDN via `@import` in `styles.css` (Spectral serif
  for reading/titles, Hanken Grotesk for UI), with full system fallbacks. The page
  still runs offline/`file://` — fonts just fall back. To go CDN-free, swap the
  `@import` for self-hosted `@font-face` + `.woff2`.
- `[hidden] { display: none !important; }` is load-bearing: component rules like
  `.cam`/`.player` set `display`, which would otherwise override the `hidden` attribute.

## Hard rules (do not violate)

- **Static only.** Plain `index.html` + `styles.css` + `app.js`. No build step,
  no framework, no bundler, no server, no proxy. It must run from a `file://`
  open and from GitHub Pages unchanged.
- **OpenAI-only, bring-your-own-key.** The OpenAI key lives only in
  `localStorage` (`s2s_openai_key`) and is sent directly to `api.openai.com`.
  Never add a proxy, any hosted secret, or a second provider. (An earlier
  Google Vision OCR option was removed; gpt-5.5 alone tested faithful enough.)
- **OCR = OpenAI vision.** A single verbatim, no-fabricate vision call per page
  (`transcribeImage`), model set in `CONFIG.VISION_MODEL` (default `gpt-5.5`,
  user-overridable). `chatComplete` downgrades request params on HTTP 400 so
  newer models (which reject `temperature`/`max_tokens`) work unchanged.
- **No npm dependencies.** Use built-in browser APIs (`fetch`, Canvas,
  `Intl.Segmenter`, `<audio>`). Do not pull in OCR libs (Tesseract), the OpenAI
  SDK, or audio libs. The vision model does the OCR.
- **Never store audio in `localStorage`** (5 MB cap). Audio, images and text are
  persisted in **IndexedDB** (store `s2s/pages`, blobs stored directly, object
  URLs rebuilt on load) so a large batch survives a refresh. `localStorage` holds
  only the API key (`s2s_openai_key`) and settings (`s2s_settings`).
- **TTS input is capped** (~4096 chars on `tts-1`/`-hd`, ~2000 tokens on
  `gpt-4o-mini-tts`). Text is chunked on **sentence boundaries** before TTS and
  the segments are queued for continuous playback. Never split mid-word.
- **Model ids drift.** Do not hardcode model names from memory in scattered
  places. They live in the `CONFIG` object at the top of `app.js` and are
  user-overridable via Advanced settings. If updating, verify against the live
  OpenAI docs first.
- **Mobile gesture.** iOS Safari blocks autoplay; first playback must come from
  a user tap. The big ▶ button is that gesture — keep it that way.

## Architecture (all in `app.js`, one IIFE)

| Section | Responsibility |
|---|---|
| `CONFIG` | The one place for endpoints, model ids, limits, voices, concurrency. |
| settings / key | Load/save `localStorage` (`s2s_openai_key`, `s2s_settings`). |
| chunking | `splitSentences` (Intl.Segmenter → regex fallback) + `chunkText`. |
| OCR call | `transcribeImage` (OpenAI vision, verbatim/no-fabricate prompt + language hint) via `chatComplete` (param-downgrade on 400). `apiFetch` auto-retries 429/5xx/network. |
| TTS calls | `synthesize` (OpenAI `/audio/speech`), `ApiError` mapping. |
| camera | In-app capture via `getUserMedia` (`openCamera`/`capturePhoto`/`closeCamera`); each shot → `addSources` (shared by the file picker). |
| image prep | `buildBase` (decode → downscale to `SRC_DIM` editable base) + `deriveSend` (apply per-page `edit{rotate,autofix}` → downscale to `MAX_IMAGE_DIM` 1568px send image). Edits are non-destructive (kept as `srcBlob` + `edit`); `reprocessPage` re-derives and re-OCRs. |
| auto-fix | `autoFixToCanvas`: dependency-free best-effort orient (0/90 via projection energy), deskew (`skewFromDark`), crop-to-text (`textBBox`). Conservative; returns input on any trouble; manual rotate is the reliable fallback. |
| persistence | IndexedDB layer (`openDB`/`idbRun`/`savePage`/`saveOrder`/`restorePages`). Per-page records keyed by uuid store `srcBlob`+`edit`+`jpegBlob`+text+audio; order in a tiny `__order__` record so reordering never rewrites blobs. Degrades to in-memory if IDB/quota fails. |
| page lifecycle | `addFiles`, `transcribePage`, `generatePageAudio`, batch actions. Concurrency via `pLimit`. |
| rendering | `renderPage` rebuilds one `<li>`; editing a textarea invalidates that page's audio. |
| playback | Queue **derived from page order** (`buildQueue`), only `ready` chunks; rebuilt on demand so late pages join while early ones play. |

### Page state machine
`loading → ready → transcribing → transcribed → generating → audio`, with
`error` reachable from any step (non-fatal, per-page retry). Editing transcribed
text drops back to `transcribed` and discards stale audio.

## Failure handling expectations

- One page failing must never abort the batch. Each page has its own retry.
- Map and surface: 401 (bad key), 429 (rate/quota), 400 (size/format/model),
  5xx, and network errors — all as clear, non-fatal messages.
- Refresh keeps the saved key and restores the batch from IndexedDB (images,
  text, and any generated audio). If IndexedDB is unavailable it must still run,
  just without persistence — never crash on missing state.

## Deploy

GitHub Pages from the repo root (Settings → Pages → branch + `/root`). No
workflow needed; the three files are the whole site.

## When changing things

- Run `node --check app.js` after edits.
- Manual smoke test: paste a key, add a couple of photos, Transcribe all, edit a
  page, Generate all audio, play through, confirm segments advance gaplessly and
  the per-page error path works (e.g. with a deliberately bad key).
- Keep the file dependency-free and the page openable without a server.
