#!/usr/bin/env python3
"""
Tiny single-user yt-dlp audio streaming resolver for TimeCut.
- Runs the bundled bgutil PO-token HTTP server on 127.0.0.1:4416 (for cloud IPs like Render)
- Copies cookies into a writable /tmp file (Render mounts /etc/secrets/ read-only)
- Validates whether exported cookies contain YouTube auth tokens (reported on /health)
- Streams audio bytes straight to stdout -> Cloudflare Worker (no disk buffering)
- Protected by optional API_KEY (Authorization: Bearer <API_KEY>)
"""

import atexit
import base64
import hmac
import json
import os
import re
import socket
import subprocess
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("PORT", "8080"))
API_KEY = os.environ.get("API_KEY", "").strip()
VIDEO_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{11}$")
AUTH_COOKIE_NAMES = {"LOGIN_INFO", "SAPISID", "__Secure-3PAPISID", "SID", "HSID"}

BGUTIL_MAIN = "/opt/bgutil/build/main.js"
BGUTIL_PORT = 4416


def start_bgutil_server() -> subprocess.Popen | None:
    """Start the local bgutil PO-token HTTP server on 127.0.0.1:4416 if bundled."""
    if not os.path.isfile(BGUTIL_MAIN):
        return None

    proc = subprocess.Popen(
        ["node", BGUTIL_MAIN, "--host", "127.0.0.1", "--port", str(BGUTIL_PORT)],
        cwd="/opt/bgutil",
    )

    def cleanup():
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()

    atexit.register(cleanup)

    # Wait briefly for port 4416 to start accepting connections
    for _ in range(25):
        if proc.poll() is not None:
            print(f"[resolver] Warning: bgutil exited early with code {proc.returncode}", flush=True)
            return None
        try:
            with socket.create_connection(("127.0.0.1", BGUTIL_PORT), timeout=0.2):
                print(f"[resolver] bgutil PO-token server ready on 127.0.0.1:{BGUTIL_PORT}", flush=True)
                return proc
        except OSError:
            time.sleep(0.2)

    print("[resolver] bgutil server started (still warming up)", flush=True)
    return proc


def load_writable_cookies() -> tuple[str | None, int, bool]:
    """
    Loads cookies from YTDLP_COOKIES_PATH, /etc/secrets/cookies.txt, YTDLP_COOKIES,
    or YTDLP_COOKIES_B64, normalizes line endings, writes to a writable /tmp file,
    and returns (writable_path, cookie_row_count, has_youtube_auth_cookies).
    """
    raw_text: str | None = None

    explicit = os.environ.get("YTDLP_COOKIES_PATH", "").strip()
    if explicit and os.path.isfile(explicit):
        with open(explicit, "r", encoding="utf-8", errors="replace") as f:
            raw_text = f.read()
    elif os.path.isfile("/etc/secrets/cookies.txt"):
        with open("/etc/secrets/cookies.txt", "r", encoding="utf-8", errors="replace") as f:
            raw_text = f.read()
    elif os.environ.get("YTDLP_COOKIES", "").strip():
        raw_text = os.environ.get("YTDLP_COOKIES", "")
    elif os.environ.get("YTDLP_COOKIES_B64", "").strip():
        try:
            raw_text = base64.b64decode(os.environ["YTDLP_COOKIES_B64"].strip()).decode(
                "utf-8", errors="replace"
            )
        except Exception as exc:
            print(f"[resolver] Warning: failed to decode YTDLP_COOKIES_B64: {exc}", flush=True)

    if not raw_text or not raw_text.strip():
        return None, 0, False

    # Normalize Windows CRLF -> LF and ensure Netscape header exists
    normalized = raw_text.replace("\r\n", "\n").replace("\r", "\n").strip() + "\n"
    if not normalized.startswith("# Netscape HTTP Cookie File") and not normalized.startswith("# HTTP Cookie File"):
        normalized = "# Netscape HTTP Cookie File\n" + normalized

    cookie_rows = 0
    has_yt_auth = False
    for line in normalized.splitlines():
        if not line or line.startswith("#"):
            continue
        cols = line.split("\t")
        if len(cols) >= 7:
            cookie_rows += 1
            domain = cols[0].lower()
            name = cols[5]
            if "youtube.com" in domain and name in AUTH_COOKIE_NAMES:
                has_yt_auth = True

    tmp = tempfile.NamedTemporaryFile(prefix="yt_cookies_", suffix=".txt", delete=False)
    tmp.write(normalized.encode("utf-8"))
    tmp.close()
    return tmp.name, cookie_rows, has_yt_auth


BGUTIL_PROC = start_bgutil_server()
COOKIES_PATH, COOKIES_COUNT, HAS_YOUTUBE_AUTH = load_writable_cookies()


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


def is_bgutil_alive() -> bool:
    if BGUTIL_PROC is None or BGUTIL_PROC.poll() is not None:
        return False
    try:
        with socket.create_connection(("127.0.0.1", BGUTIL_PORT), timeout=0.2):
            return True
    except OSError:
        return False


def spawn_ytdlp(youtube_url: str, player_client: str | None = None) -> tuple[subprocess.Popen, bytes, str]:
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "--js-runtimes",
        "node",
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
                    "cookiesCount": COOKIES_COUNT,
                    "hasYoutubeAuthCookies": HAS_YOUTUBE_AUTH,
                    "potServerReady": is_bgutil_alive(),
                },
            )

        if parsed.path == "/debug":
            if not self._check_auth():
                return self._send_json(401, {"error": "Unauthorized"})
            query = parse_qs(parsed.query)
            video_id = extract_video_id(query) or "dQw4w9WgXcQ"
            youtube_url = f"https://www.youtube.com/watch?v={video_id}"
            cmd = [
                "yt-dlp",
                "-v",
                "--simulate",
                "--no-playlist",
                "--js-runtimes",
                "node",
                "-f",
                "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
            ]
            if COOKIES_PATH:
                cmd.extend(["--cookies", COOKIES_PATH])
            cmd.append(youtube_url)
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
            combined = (res.stdout + "\n" + res.stderr).splitlines()
            # Keep the most informative yt-dlp lines without leaking raw cookie values
            filtered = [
                line
                for line in combined
                if any(
                    tok in line
                    for tok in (
                        "yt-dlp version",
                        "JS runtimes",
                        "PO Token",
                        "[pot",
                        "[youtube]",
                        "WARNING:",
                        "ERROR:",
                        "player_client",
                    )
                )
            ]
            return self._send_json(
                200,
                {
                    "exitCode": res.returncode,
                    "videoId": video_id,
                    "potServerReady": is_bgutil_alive(),
                    "cookiesCount": COOKIES_COUNT,
                    "hasYoutubeAuthCookies": HAS_YOUTUBE_AUTH,
                    "logs": filtered[-60:],
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

        # Try default client (which uses bgutil PO-token provider + cookies),
        # then fall back through mobile/TV clients if YouTube blocks the first one.
        if COOKIES_PATH:
            attempts: list[str | None] = [None, "mweb,tv", "web_safari"]
        else:
            attempts = [None, "mweb,tv", "android_vr", "tv_embedded"]

        proc = None
        first_chunk = b""
        last_err = ""

        for client in attempts:
            proc, first_chunk, last_err = spawn_ytdlp(youtube_url, player_client=client)
            if first_chunk:
                break
            lower = last_err.lower()
            if not (
                "not a bot" in lower
                or "sign in" in lower
                or "requested format" in lower
                or "po token" in lower
            ):
                break

        if not first_chunk or proc is None or proc.stdout is None:
            print(f"[resolver] Extraction failed for {video_id}: {last_err}", flush=True)
            return self._send_json(
                502,
                {
                    "error": last_err[:500] or "yt-dlp failed to extract an audio stream for this video."
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
        f"[resolver] Listening on 0.0.0.0:{PORT} "
        f"(auth={'on' if API_KEY else 'off'}, cookies={COOKIES_COUNT}, yt_auth={HAS_YOUTUBE_AUTH}, pot={is_bgutil_alive()})",
        flush=True,
    )
    server.serve_forever()
