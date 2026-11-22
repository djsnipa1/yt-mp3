import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getResolverConfig } from '$lib/server/resolver';

export const GET: RequestHandler = async ({ platform }) => {
	const config = getResolverConfig(platform);

	return json(
		{
			ok: true,
			runtime: 'cloudflare-workers',
			resolverConfigured: Boolean(config.url),
			resolverType: config.type
		},
		{
			headers: {
				'Cache-Control': 'no-store'
			}
		}
	);
};
