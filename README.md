# 📖→🔊 Scan2Speech

Turn photos of physical book pages into an audiobook you can listen to — entirely
in your browser, with your own OpenAI API key. **No accounts, no server, no
hosted secrets.**

> Snap photos of book pages → get them read aloud, with no infrastructure beyond
> a static host.

It's the tool for *"I want the next hundred pages of this book but I don't have
time to read them — I'll take a hundred photos, drop them in, and listen while I
drive."*

## How it works

1. **Paste your OpenAI API key.** It's saved only in this browser's
   `localStorage` and sent directly to `api.openai.com` — nowhere else.
2. **Add page photos** (tap or drag — JPEG/PNG/WebP; HEIC works where the
   browser can decode it). Page order is preserved.
3. **Transcribe.** Each photo is read by an OpenAI vision model — it handles
   curved pages and imperfect phone shots far better than classic OCR.
4. **Review & edit.** Every page's text is editable before you make audio. Fix
   anything OCR got wrong.
5. **Generate audio.** Text is split on sentence boundaries (to stay under the
   speech endpoint's limit) and synthesized with the voice you pick.
6. **Listen.** A queued player plays every page in order, back-to-back, with
   play/pause, skip, scrub, and speed control. On mobile, tap ▶ once to start.

Pages transcribe in parallel, so you can start reviewing and listening to the
early ones while later ones are still processing. If one page errors (bad key,
rate limit, unreadable image), only that page is affected — retry it on its own.

## Run it

It's three static files (`index.html`, `styles.css`, `app.js`) — no build.

- **Locally:** open `index.html`, or serve the folder (`python3 -m http.server`)
  and visit it.
- **GitHub Pages:** push, then **Settings → Pages → Deploy from branch**, pick
  your branch and the **root** folder. The published URL works with no server.

## What you'll need

- An OpenAI API key with access to a vision-capable chat model and the speech
  (TTS) endpoint. Get one at
  [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
- Usage is billed by OpenAI to your key (vision per image + TTS per character).

## Settings (Advanced)

Model ids drift over time, so they're editable in the UI and not buried in code:

- **OCR engine** — *OpenAI vision* (default, generative — fast but can occasionally
  invent text on dense/blurry pages) or *Google Cloud Vision* (a true OCR engine:
  no hallucination, excellent on non-English/Cyrillic). Google Vision needs its
  own API key (Cloud Vision API enabled, no blocking referrer restriction); it's
  sent straight from your browser like the OpenAI key. TTS always uses OpenAI.
- **Page language** — optional hint (name or ISO code, e.g. `Ukrainian` / `uk`)
  that sharpens accuracy on either engine.
- **Vision model** (OpenAI engine) — any vision-capable chat model (default
  `gpt-4o`; far more faithful than `gpt-4o-mini`).
- **TTS model** — `gpt-4o-mini-tts` (default), `tts-1`, `tts-1-hd`, or a custom id.
- **Voice**, **max characters per chunk**, and **voice instructions**
  (steerable tone, `gpt-4o-mini-tts` only).

## Notes & limits

- **Nothing leaves your browser except calls to OpenAI.** No analytics, no proxy.
- **Your batch is saved on this device** (images, text, and audio) in IndexedDB,
  so a refresh or accidental close won't lose a big run. The key and settings
  live in `localStorage`. Use **Remove all** to wipe the saved batch, or **Clear**
  to remove the key.
- This is a personal bring-your-own-key tool: anyone with access to the device's
  browser can read the stored key and saved pages.

See [CLAUDE.md](./CLAUDE.md) for the design and contributor rules.
