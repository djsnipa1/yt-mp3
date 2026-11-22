import type { PageServerLoad } from './$types';
import { getResolverConfig } from '$lib/server/resolver';

export const load: PageServerLoad = async ({ platform, url }) => {
	const config = getResolverConfig(platform);
	const initialUrl = url.searchParams.get('url') ?? '';

	return {
		resolverConfigured: Boolean(config.url),
		resolverType: config.type,
		initialUrl
	};
};
