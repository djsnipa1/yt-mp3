import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isValidVideoId } from '$lib/youtube';
import { fetchUpstreamAudio, getResolverConfig } from '$lib/server/resolver';

export const GET: RequestHandler = async ({ url, fetch, platform }) => {
	const videoId = (url.searchParams.get('id') ?? '').trim();

	if (!isValidVideoId(videoId)) {
		return json({ error: 'Invalid or missing YouTube video ID.' }, { status: 400 });
	}

	const config = getResolverConfig(platform);
	if (!config.url) {
		return json(
			{
				code: 'RESOLVER_NOT_CONFIGURED',
				error:
					'No YouTube audio resolver is configured on this Cloudflare Worker yet. Set MEDIA_RESOLVER_URL in Wrangler secrets (see resolver/README.md for free hosting options).'
			},
			{ status: 503 }
		);
	}

	try {
		const { response: upstream, contentType, filename } = await fetchUpstreamAudio(
			videoId,
			config,
			fetch
		);

		const responseHeaders = new Headers();
		responseHeaders.set('Content-Type', contentType || 'audio/mp4');

		const contentLength = upstream.headers.get('content-length');
		if (contentLength) {
			responseHeaders.set('Content-Length', contentLength);
		}
		if (filename) {
			responseHeaders.set('X-Resolved-Filename', filename);
		}

		responseHeaders.set('Cache-Control', 'no-store');

		// Stream directly through Cloudflare Worker without buffering into isolate RAM
		return new Response(upstream.body, {
			status: 200,
			headers: responseHeaders
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Failed to resolve audio stream.';
		return json({ error: message }, { status: 502 });
	}
};
