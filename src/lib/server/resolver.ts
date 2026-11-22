import { env as privateEnv } from '$env/dynamic/private';
import { isValidVideoId } from '$lib/youtube';

export type ResolverMode = 'cobalt' | 'piped' | 'custom';

export interface ResolverConfig {
	url: string | null;
	type: ResolverMode;
	apiKey: string | null;
}

export interface UpstreamAudioResponse {
	response: Response;
	contentType: string;
	filename?: string;
}

export function getResolverConfig(platform?: App.Platform): ResolverConfig {
	const env = platform?.env;
	const rawUrl = env?.MEDIA_RESOLVER_URL ?? privateEnv.MEDIA_RESOLVER_URL ?? '';
	const rawType = (env?.MEDIA_RESOLVER_TYPE ?? privateEnv.MEDIA_RESOLVER_TYPE ?? 'custom')
		.trim()
		.toLowerCase();
	const rawApiKey = env?.MEDIA_RESOLVER_API_KEY ?? privateEnv.MEDIA_RESOLVER_API_KEY ?? '';

	const type: ResolverMode =
		rawType === 'piped' || rawType === 'custom' || rawType === 'cobalt' ? rawType : 'custom';

	const url = rawUrl.trim().replace(/\/+$/, '') || null;
	const apiKey = rawApiKey.trim() || null;

	return { url, type, apiKey };
}

/**
 * Fetches an upstream audio stream Response for a validated YouTube videoId.
 * - "custom": Single GET to MEDIA_RESOLVER_URL?url=...&id=... — streams audio directly if returned,
 *             or follows JSON `{ streamUrl }` (never double-invokes yt-dlp).
 * - "cobalt": POSTs to Cobalt API and fetches the returned stream URL.
 * - "piped":  GETs /streams/:videoId and fetches the highest-bitrate audio stream.
 */
export async function fetchUpstreamAudio(
	videoId: string,
	config: ResolverConfig,
	fetchFn: typeof fetch = fetch
): Promise<UpstreamAudioResponse> {
	if (!isValidVideoId(videoId)) {
		throw new Error('Invalid YouTube video ID.');
	}
	if (!config.url) {
		throw new Error('MEDIA_RESOLVER_URL is not configured on this Cloudflare Worker.');
	}

	const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

	if (config.type === 'custom') {
		const endpoint = new URL(config.url);
		endpoint.searchParams.set('url', youtubeUrl);
		endpoint.searchParams.set('id', videoId);

		const headers: Record<string, string> = {
			Accept: 'audio/*, application/json',
			'User-Agent': 'TimeCut-Worker/1.0'
		};
		if (config.apiKey) {
			headers.Authorization = `Bearer ${config.apiKey}`;
		}

		const res = await fetchFn(endpoint.toString(), {
			method: 'GET',
			headers,
			redirect: 'follow'
		});

		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			throw new Error(
				`Resolver returned ${res.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`
			);
		}

		const ct = (res.headers.get('content-type') || '').toLowerCase();
		if (ct.includes('application/json')) {
			const data = (await res.json()) as {
				streamUrl?: string;
				url?: string;
				contentType?: string;
				filename?: string;
				error?: string;
			};
			const target = data.streamUrl || data.url;
			if (!target) {
				throw new Error(
					data.error || 'Custom resolver JSON response did not include streamUrl or url.'
				);
			}

			const audioRes = await fetchFn(target, {
				method: 'GET',
				headers: { 'User-Agent': 'TimeCut-Worker/1.0' },
				redirect: 'follow'
			});

			if (!audioRes.ok || !audioRes.body) {
				throw new Error(`Upstream audio fetch failed with status ${audioRes.status}.`);
			}

			return {
				response: audioRes,
				contentType:
					audioRes.headers.get('content-type') || data.contentType || 'audio/webm',
				filename: data.filename
			};
		}

		if (!res.body) {
			throw new Error('Resolver returned an empty response body.');
		}

		return {
			response: res,
			contentType: ct.split(';')[0] || 'audio/mp4'
		};
	}

	if (config.type === 'cobalt') {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'Content-Type': 'application/json'
		};
		if (config.apiKey) {
			headers.Authorization = config.apiKey.startsWith('Api-Key ')
				? config.apiKey
				: `Api-Key ${config.apiKey}`;
		}

		const res = await fetchFn(config.url, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				url: youtubeUrl,
				downloadMode: 'audio',
				audioFormat: 'best'
			})
		});

		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			throw new Error(
				`Cobalt resolver returned ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`
			);
		}

		const data = (await res.json()) as {
			status?: string;
			url?: string;
			filename?: string;
			error?: { code?: string };
		};

		if (data.status === 'error' || !data.url) {
			throw new Error(
				`Cobalt could not resolve audio${data.error?.code ? ` (${data.error.code})` : ''}.`
			);
		}

		const upstreamHeaders: Record<string, string> = { 'User-Agent': 'TimeCut-Worker/1.0' };
		if (config.apiKey && data.url.startsWith(config.url)) {
			upstreamHeaders.Authorization = headers.Authorization;
		}

		const audioRes = await fetchFn(data.url, {
			method: 'GET',
			headers: upstreamHeaders,
			redirect: 'follow'
		});

		if (!audioRes.ok || !audioRes.body) {
			throw new Error(`Cobalt stream fetch failed with status ${audioRes.status}.`);
		}

		return {
			response: audioRes,
			contentType: audioRes.headers.get('content-type') || 'audio/mpeg',
			filename: data.filename
		};
	}

	// Piped mode
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (config.apiKey) {
		headers.Authorization = `Bearer ${config.apiKey}`;
	}

	const res = await fetchFn(`${config.url}/streams/${videoId}`, { headers });
	if (!res.ok) {
		throw new Error(`Piped resolver returned ${res.status}.`);
	}

	const data = (await res.json()) as {
		audioStreams?: Array<{
			url: string;
			mimeType?: string;
			bitrate?: number;
		}>;
	};

	const streams = data.audioStreams ?? [];
	if (streams.length === 0) {
		throw new Error('Piped returned no audio streams for this video.');
	}

	const best = [...streams].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
	const audioRes = await fetchFn(best.url, {
		method: 'GET',
		headers: { 'User-Agent': 'TimeCut-Worker/1.0' },
		redirect: 'follow'
	});

	if (!audioRes.ok || !audioRes.body) {
		throw new Error(`Piped audio stream fetch failed with status ${audioRes.status}.`);
	}

	return {
		response: audioRes,
		contentType:
			audioRes.headers.get('content-type') || best.mimeType?.split(';')[0] || 'audio/mp4'
	};
}
