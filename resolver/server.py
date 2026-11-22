#!/usr/bin/env python3
"""
Tiny single-user yt-dlp audio streaming resolver for TimeCut.
- Zero external Python web frameworks (stdlib http.server + yt-dlp CLI)
- Streams audio bytes straight to stdout -> Cloudflare Worker (no disk buffering)
- Protected by optional API_KEY (Authorization: Bearer <API_KEY>)
- Supports cookies from:
    1) YTDLP_COOKIES_PATH env var
    2) /etc/secrets/cookies.txt (Render Secret Files — easiest, no base64 needed)
    3) YTDLP_COOKIES env var (raw Netscape cookies.txt text)
    4) YTDLP_COOKIES_B64 env var (base64-encoded cookies.txt)
- Automatically retries alternate YouTube player clients if a cloud IP hits a bot check
"""

import base64
import hmac
import json
import os
import re
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("PORT", "8080"))
API_KEY = os.environ.get("API_KEY", "").strip()
VIDEO_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{11}$")


def resolve_cookies_path() -> str | None:
    # 1. Explicit file path
    explicit = os.environ.get("YTDLP_COOKIES_PATH", "").strip()
    if explicit and os.path.isfile(explicit):
        return explicit

    # 2. Render Secret File default path
    render_secret = "/etc/secrets/cookies.txt"
    if os.path.isfile(render_secret):
        return render_secret

    # 3. Raw Netscape cookies text in env var
    raw_text = os.environ.get("YTDLP_COOKIES", "").strip()
    if raw_text:
        tmp = tempfile.NamedTemporaryFile(prefix="yt_cookies_", suffix=".txt", delete=False)
        tmp.write(raw_text.encode("utf-8"))
        tmp.close()
        return tmp.name

    # 4. Base64-encoded cookies.txt in env var
    cookies_b64 = os.environ.get("YTDLP_COOKIES_B64", "").strip()
    if cookies_b64:
        try:
            raw_bytes = base64.b64decode(cookies_b64)
            tmp = tempfile.NamedTemporaryFile(prefix="yt_cookies_", suffix=".txt", delete=False)
            tmp.write(raw_bytes)
            tmp.close()
            return tmp.name
        except Exception as exc:
            print(f"[resolver] Warning: failed to decode YTDLP_COOKIES_B64: {exc}", flush=True)

    return None


COOKIES_PATH = resolve_cookies_path()


def extract_video_id(query: dict[str, list[str]]) -> str | None:
    vid = (query.get("id", [""])[0] or "").strip()
    if VIDEO_ID_RE.match(vid):
        return vid

    raw_url = (query.get("url", [""])[0] or "").strip()
    if raw_url:
        parsed = urlparse(raw_url)
        qs = parse_qs(parsed.query)
        cand = (qs.get("v", [""])[0] or "").strip()
        if VIDEO_ID_RE.match(cand):
            return cand
        parts = [p for p in parsed.path.split("/") if p]
        if parsed.hostname in ("youtu.be", "www.youtu.be") and parts and VIDEO_ID_RE.match(parts[0]):
            return parts[0]
        if len(parts) >= 2 and parts[0] in ("shorts", "embed", "live") and VIDEO_ID_RE.match(parts[1]):
            return parts[1]

    return None


def spawn_ytdlp(youtube_url: str, player_client: str | None = None) -> tuple[subprocess.Popen, bytes, str]:
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "-f",
        "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
        "-o",
        "-",
    ]
    if COOKIES_PATH:
        cmd.extend(["--cookies", COOKIES_PATH])
    if player_client:
        cmd.extend(["--extractor-args", f"youtube:player_client={player_client}"])

    cmd.append(youtube_url)

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert proc.stdout is not None and proc.stderr is not None

    first_chunk = proc.stdout.read(65536)
    if first_chunk:
        return proc, first_chunk, ""

    err_msg = proc.stderr.read().decode("utf-8", errors="replace").strip()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
    return proc, b"", err_msg


class ResolverHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _check_auth(self) -> bool:
        if not API_KEY:
            return True
        auth = self.headers.get("Authorization", "").strip()
        expected = f"Bearer {API_KEY}"
        return hmac.compare_digest(auth, expected)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path in ("/", "/health"):
            return self._send_json(
                200,
                {
                    "ok": True,
                    "service": "timecut-resolver",
                    "authRequired": bool(API_KEY),
                    "cookiesConfigured": bool(COOKIES_PATH),
                },
            )

        if parsed.path != "/audio":
            return self._send_json(404, {"error": "Not found. Use GET /audio?id=<videoId>"})

        if not self._check_auth():
            return self._send_json(401, {"error": "Unauthorized"})

        query = parse_qs(parsed.query)
        video_id = extract_video_id(query)
        if not video_id:
            return self._send_json(400, {"error": "Invalid or missing YouTube video ID"})

        youtube_url = f"https://www.youtube.com/watch?v={video_id}"

        # Try default client first; if a cloud IP triggers YouTube's bot check, fall back to
        # alternate player clients that sometimes bypass unauthenticated datacenter blocks.
        attempts: list[str | None] = [None]
        if not COOKIES_PATH:
            attempts.extend(["android_vr", "tv_embedded", "ios"])

        proc = None
        first_chunk = b""
        last_err = ""

        for client in attempts:
            proc, first_chunk, last_err = spawn_ytdlp(youtube_url, player_client=client)
            if first_chunk:
                break
            # Only retry alternate clients on bot/sign-in/player failures
            lower = last_err.lower()
            if not ("not a bot" in lower or "sign in" in lower or "requested format" in lower):
                break

        if not first_chunk or proc is None or proc.stdout is None:
            return self._send_json(
                502,
                {
                    "error": last_err[:360] or "yt-dlp failed to extract an audio stream for this video."
                },
            )

        # Sniff container type from header bytes so FFmpeg.wasm gets the right extension
        if first_chunk[:4] == b"\x1a\x45\xdf\xa3":
            content_type = "audio/webm"
        elif len(first_chunk) >= 8 and first_chunk[4:8] == b"ftyp":
            content_type = "audio/mp4"
        elif first_chunk[:4] == b"OggS":
            content_type = "audio/ogg"
        else:
            content_type = "application/octet-stream"

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        def write_chunk(data: bytes):
            self.wfile.write(f"{len(data):x}\r\n".encode("ascii"))
            self.wfile.write(data)
            self.wfile.write(b"\r\n")
            self.wfile.flush()

        try:
            write_chunk(first_chunk)
            while True:
                chunk = proc.stdout.read(65536)
                if not chunk:
                    break
                write_chunk(chunk)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            proc.kill()
        finally:
            try:
                proc.stdout.close()
                if proc.stderr:
                    proc.stderr.close()
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

    def log_message(self, format, *args):
        print(f"[resolver] {self.address_string()} - {format % args}", flush=True)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), ResolverHandler)
    print(
        f"[resolver] Listening on 0.0.0.0:{PORT} (auth={'on' if API_KEY else 'off'}, cookies={'on' if COOKIES_PATH else 'off'})",
        flush=True,
    )
    server.serve_forever()
