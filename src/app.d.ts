// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Platform {
			env: {
				ASSETS?: {
					fetch: typeof fetch;
				};
				MEDIA_RESOLVER_URL?: string;
				MEDIA_RESOLVER_TYPE?: 'cobalt' | 'piped' | 'custom' | string;
				MEDIA_RESOLVER_API_KEY?: string;
			};
			context?: {
				waitUntil(promise: Promise<unknown>): void;
				passThroughOnException(): void;
			};
			caches?: CacheStorage;
		}
	}
}

export {};
