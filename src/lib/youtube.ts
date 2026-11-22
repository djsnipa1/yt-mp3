export interface ParsedYouTubeUrl {
	videoId: string;
	canonicalUrl: string;
	startSeconds: number;
	hasTimestampParam: boolean;
	rawTimestampParam: string | null;
}

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
	'youtube.com',
	'www.youtube.com',
	'm.youtube.com',
	'music.youtube.com',
	'youtu.be',
	'www.youtu.be',
	'youtube-nocookie.com',
	'www.youtube-nocookie.com'
]);

/**
 * Parses YouTube timestamp values such as:
 * - "95" or "95s"
 * - "1m35s" or "1h2m3s"
 * - "1:35" or "01:02:15"
 * Returns integer seconds >= 0, or null if invalid.
 */
export function parseTimestampToSeconds(raw: string | null | undefined): number | null {
	if (!raw) return null;
	const value = raw.trim().toLowerCase();
	if (!value) return null;

	// Pure numeric seconds: "95" or "95s"
	const plainSeconds = /^(\d+(?:\.\d+)?)s?$/.exec(value);
	if (plainSeconds) {
		return Math.max(0, Math.floor(Number(plainSeconds[1])));
	}

	// H/M/S notation: "1h2m3s", "2m10s", "1h5s", "3m"
	const hmsMatch = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value);
	if (hmsMatch && (hmsMatch[1] || hmsMatch[2] || hmsMatch[3])) {
		const hours = Number(hmsMatch[1] || 0);
		const minutes = Number(hmsMatch[2] || 0);
		const seconds = Number(hmsMatch[3] || 0);
		return hours * 3600 + minutes * 60 + seconds;
	}

	// Colon notation: "MM:SS" or "HH:MM:SS"
	if (value.includes(':')) {
		const parts = value.split(':').map((p) => p.trim());
		if (parts.length < 2 || parts.length > 3) return null;
		if (parts.some((p) => !/^\d+$/.test(p))) return null;
		const nums = parts.map(Number);
		if (nums.length === 2) {
			const [mins, secs] = nums;
			return mins * 60 + secs;
		}
		const [hours, mins, secs] = nums;
		return hours * 3600 + mins * 60 + secs;
	}

	return null;
}

/**
 * Formats seconds into MM:SS or HH:MM:SS.
 */
export function formatSeconds(totalSeconds: number): string {
	const safe = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
	const hours = Math.floor(safe / 3600);
	const minutes = Math.floor((safe % 3600) / 60);
	const seconds = safe % 60;

	const mm = String(minutes).padStart(2, '0');
	const ss = String(seconds).padStart(2, '0');

	if (hours > 0) {
		return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
	}
	return `${mm}:${ss}`;
}

/**
 * Validates and extracts videoId + start timestamp from any YouTube URL (or bare 11-char ID).
 */
export function parseYouTubeUrl(input: string): ParsedYouTubeUrl | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	// Allow raw 11-character YouTube video ID
	if (VIDEO_ID_REGEX.test(trimmed)) {
		return {
			videoId: trimmed,
			canonicalUrl: `https://www.youtube.com/watch?v=${trimmed}`,
			startSeconds: 0,
			hasTimestampParam: false,
			rawTimestampParam: null
		};
	}

	let candidate = trimmed;
	if (!/^https?:\/\//i.test(candidate)) {
		candidate = `https://${candidate}`;
	}

	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}

	const host = url.hostname.toLowerCase();
	if (!YOUTUBE_HOSTS.has(host)) {
		return null;
	}

	let videoId: string | null = null;
	const segments = url.pathname.split('/').filter(Boolean);

	if (host === 'youtu.be' || host === 'www.youtu.be') {
		videoId = segments[0] ?? null;
	} else if (url.pathname === '/watch') {
		videoId = url.searchParams.get('v');
	} else if (
		segments.length >= 2 &&
		(segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live' || segments[0] === 'v')
	) {
		videoId = segments[1];
	} else {
		videoId = url.searchParams.get('v');
	}

	if (!videoId || !VIDEO_ID_REGEX.test(videoId)) {
		return null;
	}

	// Extract timestamp from ?t=, &start=, &time_continue=, or #t=
	let rawTimestampParam =
		url.searchParams.get('t') ??
		url.searchParams.get('start') ??
		url.searchParams.get('time_continue');

	if (!rawTimestampParam && url.hash) {
		const hashClean = url.hash.replace(/^#/, '');
		const hashParams = new URLSearchParams(hashClean);
		rawTimestampParam = hashParams.get('t') ?? hashParams.get('start');
		if (!rawTimestampParam && hashClean.startsWith('t=')) {
			rawTimestampParam = hashClean.slice(2);
		}
	}

	const parsedTime = parseTimestampToSeconds(rawTimestampParam);
	const hasTimestampParam = parsedTime !== null;
	const startSeconds = parsedTime ?? 0;

	const canonicalUrl =
		startSeconds > 0
			? `https://www.youtube.com/watch?v=${videoId}&t=${startSeconds}s`
			: `https://www.youtube.com/watch?v=${videoId}`;

	return {
		videoId,
		canonicalUrl,
		startSeconds,
		hasTimestampParam,
		rawTimestampParam: rawTimestampParam ?? null
	};
}

export function isValidVideoId(id: string): boolean {
	return VIDEO_ID_REGEX.test(id);
}

export function sanitizeFilename(title: string, startSeconds: number): string {
	const cleaned = title
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 72);

	const base = cleaned || 'youtube-audio';
	const suffix = startSeconds > 0 ? ` (from ${formatSeconds(startSeconds).replace(/:/g, '-')})` : '';
	return `${base}${suffix}.mp3`;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const val = bytes / Math.pow(1024, i);
	return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
