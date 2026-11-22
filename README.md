# TimeCut — YouTube Timestamp to MP3 (Cloudflare Workers + SvelteKit + Tailwind CSS v4)

A mobile-first web app that accepts any YouTube link — with or without a timestamp (`?t=95`, `&t=1m35s`, `&start=42`, `#t=1m30s`) — and converts the video from that start timestamp to the end into an MP3 file.

## Architecture

- **Frontend**: SvelteKit (Svelte 5) + Tailwind CSS v4, mobile-first layout with 44px+ touch targets.
- **Edge Backend (Cloudflare Workers via `@sveltejs/adapter-cloudflare`)**:
  - `GET /api/info?url=...` — Validates YouTube URLs, extracts `videoId` and `?t=` / `start` timestamps, and fetches video metadata via YouTube oEmbed.
  - `GET /api/stream?id=...` — Strictly validates the 11-char video ID (no open-proxy SSRF), resolves the audio stream via your configured `MEDIA_RESOLVER_URL`, and pipes `Response.body` straight through the Worker without buffering into isolate memory.
  - `GET /api/demo-audio` — Synthesizes a 20-second WAV track on the Worker so you can verify the full Edge → FFmpeg.wasm MP3 pipeline immediately.
  - `GET /api/health` — Reports runtime & resolver configuration status.
- **Browser Processing (`@ffmpeg/ffmpeg`)**:
  - Uses single-threaded `@ffmpeg/core` (works on iOS Safari, Android Chrome, and desktop without requiring `SharedArrayBuffer` / COOP-COEP headers, and avoids Cloudflare Workers' 25 MiB static asset limit).
  - Trims from `startSeconds` to the end (`-ss <start> -i ...`) and encodes to MP3 (`128k` / `192k` / `320k`) with ID3 tags locally in the browser.

## Getting Started

```bash
npm install
npm run dev
```

To also test locally with Cloudflare's Workers runtime (`wrangler dev`):

```bash
npm run cf:preview
```

## Deploying to Cloudflare Workers

1. Log in to Wrangler (first time only):
   ```bash
   npx wrangler login
   ```

2. Configure your YouTube audio stream resolver secret:
   ```bash
   # Supported MEDIA_RESOLVER_TYPE values in wrangler.jsonc: "cobalt" | "piped" | "custom"
   npx wrangler secret put MEDIA_RESOLVER_URL
   npx wrangler secret put MEDIA_RESOLVER_API_KEY # optional
   ```

3. Build and deploy:
   ```bash
   npm run cf:deploy
   ```

### Supported Resolver Backends

| `MEDIA_RESOLVER_TYPE` | Expected `MEDIA_RESOLVER_URL` | Notes |
| --- | --- | --- |
| `cobalt` (default) | Base URL of a self-hosted [Cobalt](https://github.com/imputnet/cobalt) instance | Worker sends `POST` with `{ url, downloadMode: "audio", audioFormat: "best" }` and optional `Api-Key`. |
| `piped` | Base URL of a self-hosted Piped API | Worker calls `GET /streams/:videoId` and streams the highest-bitrate audio track. |
| `custom` | Any HTTPS endpoint accepting `?url=<youtubeUrl>&id=<videoId>` | Return either `{ "streamUrl": "https://..." }` JSON or raw audio bytes directly. |

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in your values.

## Query Parameter Shortcut

You can deep-link or wire up an iOS Shortcut / Android Share action by passing `?url=`:

```text
https://your-worker.workers.dev/?url=https://youtu.be/dQw4w9WgXcQ?t=43s
```
