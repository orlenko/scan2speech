# CLAUDE.md — Scan2Speech

Guidance for AI assistants (and humans) working in this repo.

## What this is

A **single static web page** that turns photos of physical book pages into
listenable audio using the **OpenAI API**, with the user's **own API key**.
No accounts, no backend, no hosted secrets. Publishable as-is to GitHub Pages.

The dream it serves: *"I want the next hundred pages of this book but no time to
read them — I'll snap a hundred photos, drop them in, and listen while I drive."*

## Hard rules (do not violate)

- **Static only.** Plain `index.html` + `styles.css` + `app.js`. No build step,
  no framework, no bundler, no server, no proxy. It must run from a `file://`
  open and from GitHub Pages unchanged.
- **Bring-your-own-key.** The key lives only in `localStorage` and is sent
  directly to `api.openai.com`. Never add a proxy or any hosted secret. This is
  intentional and acceptable for a personal tool.
- **No npm dependencies.** Use built-in browser APIs (`fetch`, Canvas,
  `Intl.Segmenter`, `<audio>`). Do not pull in OCR libs (Tesseract), the OpenAI
  SDK, or audio libs. The vision model does the OCR.
- **Never store audio in `localStorage`** (5 MB cap). Audio blobs live in memory
  as object URLs and are revoked when replaced/removed. Only the API key and
  small settings are persisted.
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
| OpenAI calls | `apiFetch` (auto-retry 429/5xx/network), `transcribeImage`, `synthesize`, `ApiError` mapping. |
| image prep | `prepareImage`: decode → downscale to `MAX_IMAGE_DIM` → re-encode JPEG (normalizes formats incl. HEIC where decodable, respects EXIF, shrinks uploads). |
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
- Refresh keeps the saved key and must not crash on missing audio state (audio
  is in-memory only, so a refresh simply starts a fresh working set).

## Deploy

GitHub Pages from the repo root (Settings → Pages → branch + `/root`). No
workflow needed; the three files are the whole site.

## When changing things

- Run `node --check app.js` after edits.
- Manual smoke test: paste a key, add a couple of photos, Transcribe all, edit a
  page, Generate all audio, play through, confirm segments advance gaplessly and
  the per-page error path works (e.g. with a deliberately bad key).
- Keep the file dependency-free and the page openable without a server.
