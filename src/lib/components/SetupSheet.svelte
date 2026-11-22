<script lang="ts">
	interface Props {
		open: boolean;
		resolverConfigured: boolean;
		resolverType: string;
		onClose: () => void;
	}

	let { open, resolverConfigured, resolverType, onClose }: Props = $props();

	let selectedTab = $state<'custom' | 'cobalt' | 'piped'>('custom');
	let copiedKey = $state<string | null>(null);

	$effect(() => {
		if (resolverType === 'cobalt' || resolverType === 'piped' || resolverType === 'custom') {
			selectedTab = resolverType;
		}
	});

	async function copyText(key: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copiedKey = key;
			setTimeout(() => {
				if (copiedKey === key) copiedKey = null;
			}, 1800);
		} catch {
			// Ignore clipboard failures in restricted contexts
		}
	}

	const commands = {
		custom: `# 1. Host resolver/ for $0/mo (Render Free Tier OR local + cloudflared tunnel)
#    See resolver/README.md for 2-minute setup steps.

# 2. Point your Cloudflare Worker to it:
npx wrangler secret put MEDIA_RESOLVER_URL
# Paste: https://your-resolver-url/audio

npx wrangler secret put MEDIA_RESOLVER_API_KEY
# Paste the API_KEY you chose for your resolver`,
		cobalt: `# In wrangler.jsonc, set "MEDIA_RESOLVER_TYPE": "cobalt"
npx wrangler secret put MEDIA_RESOLVER_URL
# Paste your Cobalt API URL (e.g. https://cobalt.example.com)

npx wrangler secret put MEDIA_RESOLVER_API_KEY
# Optional: paste your Cobalt Api-Key`,
		piped: `# In wrangler.jsonc, set "MEDIA_RESOLVER_TYPE": "piped"
npx wrangler secret put MEDIA_RESOLVER_URL
# Paste your Piped API base URL (e.g. https://pipedapi.example.com)`
	};

	function handleKeydown(e: KeyboardEvent) {
		if (open && e.key === 'Escape') {
			onClose();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="setup-sheet-title"
	>
		<!-- Backdrop click area -->
		<button
			type="button"
			class="fixed inset-0 cursor-default"
			aria-label="Close setup sheet"
			onclick={onClose}
		></button>

		<div
			class="relative z-10 max-h-[88dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-surface-700 bg-surface-900 p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl sm:p-6"
		>
			<!-- Mobile drag indicator -->
			<div class="mx-auto mb-4 h-1 w-10 rounded-full bg-surface-700 sm:hidden"></div>

			<div class="flex items-start justify-between gap-3">
				<div>
					<p class="font-mono text-[11px] font-medium tracking-wider text-signal-400 uppercase">
						Cloudflare Workers Backend
					</p>
					<h2 id="setup-sheet-title" class="mt-0.5 text-lg font-semibold text-ink-50">
						Audio Resolver Setup
					</h2>
				</div>
				<button
					type="button"
					onclick={onClose}
					class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-surface-700 bg-surface-850 text-ink-300 transition hover:border-surface-700 hover:bg-surface-800 hover:text-ink-50"
					aria-label="Close"
				>
					<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			<!-- Status banner -->
			<div
				class="mt-4 flex items-center justify-between gap-3 rounded-2xl border px-3.5 py-3 {resolverConfigured
					? 'border-emerald-400/25 bg-emerald-400/10'
					: 'border-amber-400/25 bg-amber-400/10'}"
			>
				<div class="flex items-center gap-2.5">
					<span
						class="h-2.5 w-2.5 shrink-0 rounded-full {resolverConfigured
							? 'bg-emerald-400'
							: 'bg-amber-400'}"
					></span>
					<div class="text-xs">
						<p class="font-medium text-ink-50">
							{resolverConfigured ? 'Resolver connected' : 'MEDIA_RESOLVER_URL not set yet'}
						</p>
						<p class="text-ink-300">
							Active mode: <span class="font-mono text-ink-100">{resolverType}</span>
						</p>
					</div>
				</div>
			</div>

			<!-- Architecture explanation -->
			<div class="mt-4 space-y-2 rounded-2xl border border-surface-700/80 bg-surface-950/70 p-3.5 text-xs leading-relaxed text-ink-300">
				<p class="font-medium text-ink-100">How this Worker + WASM stack works</p>
				<p>
					<strong class="text-ink-100">1. Cloudflare Worker (Edge):</strong> Parses your YouTube URL &amp;
					<code class="rounded bg-surface-800 px-1 py-0.5 font-mono text-[11px] text-ink-100">?t=</code>
					timestamp, fetches video metadata, and streams raw audio from your configured resolver without buffering into Worker RAM.
				</p>
				<p>
					<strong class="text-ink-100">2. Browser (FFmpeg.wasm):</strong> Trims the audio from your start
					timestamp to the end and encodes it to MP3 locally on your device — zero server CPU cost.
				</p>
			</div>

			<!-- Resolver mode tabs -->
			<div class="mt-5">
				<p class="mb-2 text-xs font-medium text-ink-300">Choose your resolver backend</p>
				<div class="grid grid-cols-3 gap-1.5 rounded-xl border border-surface-700 bg-surface-950 p-1">
					{#each ['custom', 'cobalt', 'piped'] as mode}
						<button
							type="button"
							onclick={() => (selectedTab = mode as 'custom' | 'cobalt' | 'piped')}
							class="min-h-10 rounded-lg px-2 py-1.5 font-mono text-xs font-medium capitalize transition {selectedTab ===
							mode
								? 'bg-surface-800 text-ink-50 shadow-sm'
								: 'text-ink-400 hover:text-ink-100'}"
						>
							{mode === 'custom' ? 'yt-dlp (Free)' : mode}
						</button>
					{/each}
				</div>

				<div class="relative mt-3 rounded-2xl border border-surface-700 bg-surface-950 p-3.5">
					<div class="mb-2 flex items-center justify-between">
						<span class="font-mono text-[11px] text-ink-400">Wrangler CLI</span>
						<button
							type="button"
							onclick={() => copyText(selectedTab, commands[selectedTab])}
							class="rounded-lg border border-surface-700 bg-surface-850 px-2.5 py-1 font-mono text-[11px] text-ink-200 transition hover:bg-surface-800 hover:text-ink-50"
						>
							{copiedKey === selectedTab ? 'Copied!' : 'Copy'}
						</button>
					</div>
					<pre class="overflow-x-auto font-mono text-[11px] leading-relaxed text-ink-100">{commands[selectedTab]}</pre>
				</div>

				<p class="mt-3 text-xs leading-relaxed text-ink-400">
					For local dev, copy <code class="font-mono text-ink-200">.dev.vars.example</code> to
					<code class="font-mono text-ink-200">.dev.vars</code> and restart
					<code class="font-mono text-ink-200">npm run dev</code>. See
					<code class="font-mono text-ink-200">README.md</code> for a ready-to-deploy companion
					<code class="font-mono text-ink-200">yt-dlp</code> resolver snippet.
				</p>
			</div>
		</div>
	</div>
{/if}
