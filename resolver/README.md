# TimeCut Free Audio Resolver (`yt-dlp`)

A tiny, single-user audio resolver designed to pair with your free Cloudflare Workers app at **$0/month**.

## Option A — 100% Free on Your Own Computer + Cloudflare Tunnel (Most Reliable)

Because this runs from your own home IP, YouTube almost never triggers cloud-IP bot checks.

1. Install `yt-dlp` and `cloudflared`:
   ```bash
   # macOS
   brew install yt-dlp cloudflared

   # Linux / Windows: install yt-dlp (pip install -U yt-dlp) and cloudflared
   ```
2. Start the resolver locally with a secret key:
   ```bash
   API_KEY="pick-any-secret-password" python3 resolver/server.py
   ```
3. Expose it securely with a free Cloudflare Tunnel (in a second terminal):
   ```bash
   cloudflared tunnel --url http://localhost:8080
   ```
   *(For a permanent URL that doesn't change when you restart, create a free named tunnel in the Cloudflare Zero Trust dashboard.)*
4. Connect it to your Cloudflare Worker:
   ```bash
   npx wrangler secret put MEDIA_RESOLVER_URL
   # Paste: https://<your-tunnel-url>/audio

   npx wrangler secret put MEDIA_RESOLVER_API_KEY
   # Paste: pick-any-secret-password
   ```

## Option B — 100% Free in the Cloud (Render Free Web Service)

No home computer needs to stay on. Render's free tier spins down when idle and wakes up automatically (~30s) when you convert a link.

1. Push this repo to GitHub.
2. In [Render](https://render.com), choose **New → Web Service**, select your repo, set **Root Directory** to `resolver`, and choose the **Free** plan.
3. Add an environment variable `API_KEY` (any strong random string).
4. Once deployed, copy your Render URL (e.g. `https://timecut-resolver.onrender.com`) and run:
   ```bash
   npx wrangler secret put MEDIA_RESOLVER_URL
   # Paste: https://timecut-resolver.onrender.com/audio

   npx wrangler secret put MEDIA_RESOLVER_API_KEY
   # Paste: <same API_KEY>
   ```
5. *(Optional)* If YouTube ever asks the cloud IP to confirm you're not a bot, export a Netscape `cookies.txt` file, base64-encode it (`base64 -w0 cookies.txt`), and save it as `YTDLP_COOKIES_B64` in Render's environment variables.
