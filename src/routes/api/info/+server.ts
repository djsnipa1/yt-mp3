import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { formatSeconds, parseYouTubeUrl } from '$lib/youtube';
import { getResolverConfig } from '$lib/server/resolver';

export const GET: RequestHandler = async ({ url, fetch, platform }) => {
	const rawUrl = url.searchParams.get('url') ?? '';
	const parsed = parseYouTubeUrl(rawUrl);

	if (!parsed) {
		return json(
			{
				error: 'Please enter a valid YouTube link (youtube.com/watch?v=..., youtu.be/..., or /shorts/...).'
			},
			{ status: 400 }
		);
	}

	const resolver = getResolverConfig(platform);
	const oembedEndpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(
		`https://www.youtube.com/watch?v=${parsed.videoId}`
	)}&format=json`;

	let title = `YouTube Video (${parsed.videoId})`;
	let author = 'YouTube';
	let thumbnailUrl = `https://i.ytimg.com/vi/${parsed.videoId}/hqdefault.jpg`;
	let metadataVerified = false;

	try {
		const res = await fetch(oembedEndpoint, {
			headers: {
				Accept: 'application/json',
				'User-Agent': 'TimeCut-Worker/1.0'
			}
		});

		if (res.ok) {
			const data = (await res.json()) as {
				title?: string;
				author_name?: string;
				thumbnail_url?: string;
			};
			if (data.title) title = data.title;
			if (data.author_name) author = data.author_name;
			if (data.thumbnail_url) thumbnailUrl = data.thumbnail_url;
			metadataVerified = true;
		} else if (res.status === 404 || res.status === 401 || res.status === 403) {
			return json(
				{
					error: 'This YouTube video appears unavailable, private, or embedding is restricted.'
				},
				{ status: 404 }
			);
		}
	} catch {
		// Fall back gracefully to direct thumbnail & ID if oEmbed network call fails
	}

	return json(
		{
			videoId: parsed.videoId,
			canonicalUrl: parsed.canonicalUrl,
			title,
			author,
			thumbnailUrl,
			startSeconds: parsed.startSeconds,
			startFormatted: formatSeconds(parsed.startSeconds),
			hasTimestampParam: parsed.hasTimestampParam,
			rawTimestampParam: parsed.rawTimestampParam,
			metadataVerified,
			resolverConfigured: Boolean(resolver.url),
			resolverType: resolver.type
		},
		{
			headers: {
				'Cache-Control': 'public, max-age=300'
			}
		}
	);
};
