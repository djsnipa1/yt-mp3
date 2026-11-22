<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { PageData } from './$types';
	import {
		formatBytes,
		formatSeconds,
		parseYouTubeUrl,
		type ParsedYouTubeUrl
	} from '$lib/youtube';
	import {
		convertAudioToMp3,
		guessExtensionFromContentType,
		type Mp3Bitrate
	} from '$lib/ffmpeg';
	import TimestampControl from '$lib/components/TimestampControl.svelte';
	import SetupSheet from '$lib/components/SetupSheet.svelte';

	let { data }: { data: PageData } = $props();

	interface VideoInfo {
		videoId: string;
		canonicalUrl: string;
		title: string;
		author: string;
		thumbnailUrl: string;
		startSeconds: number;
		startFormatted: string;
		hasTimestampParam: boolean;
		rawTimestampParam: string | null;
		metadataVerified: boolean;
	}

	interface CompletedClip {
		id: string;
		title: string;
		author: string;
		filename: string;
		objectUrl: string;
		size: number;
		bitrate: Mp3Bitrate;
		startSeconds: number;
		elapsedMs: number;
		sourceLabel: string;
		createdAt: number;
	}

	type SourceTab = 'youtube' | 'local';
	type PipelineStage = 'idle' | 'fetching' | 'loading-ffmpeg' | 'encoding' | 'done' | 'error';

	let activeTab = $state<SourceTab>('youtube');
	let setupOpen = $state(false);

	// YouTube URL & metadata state
	let urlInput = $state('');
	let parsedUrl = $state<ParsedYouTubeUrl | null>(null);
	let videoInfo = $state<VideoInfo | null>(null);
	let infoLoading = $state(false);
	let infoError = $state<string | null>(null);
	let resolverConfigured = $state(false);
	let resolverType = $state('cobalt');

	// Local file state
	let localFile = $state<File | null>(null);
	let fileInputEl = $state<HTMLInputElement | null>(null);

	// Shared trim & encode controls (start time -> end of video)
	let startSeconds = $state(0);
	let urlStartSeconds = $state(0);
	let bitrate = $state<Mp3Bitrate>('192k');

	// Pipeline progress state
	let stage = $state<PipelineStage>('idle');
	let progressPercent = $state(0);
	let statusDetail = $state('');
	let errorMessage = $state<string | null>(null);
	let needsResolverNotice = $state(false);

	// Output & session history
	let currentResult = $state<CompletedClip | null>(null);
	let history = $state<CompletedClip[]>([]);

	let infoAbortController: AbortController | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let lastFetchedVideoId: string | null = null;

	const isBusy = $derived(
		stage === 'fetching' || stage === 'loading-ffmpeg' || stage === 'encoding'
	);

	const bitrates: Array<{ value: Mp3Bitrate; label: string; hint: string }> = [
		{ value: '128k', label: '128k', hint: 'Compact' },
		{ value: '192k', label: '192k', hint: 'Balanced' },
		{ value: '320k', label: '320k', hint: 'Studio' }
	];

	const exampleLinks = [
		{
			label: 'With ?t=43s',
			url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s'
		},
		{
			label: 'With ?t=1m25s',
			url: 'https://youtu.be/jNQXAC9IVRw?t=1m25s'
		},
		{
			label: 'No timestamp',
			url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
		}
	];

	onMount(() => {
		resolverConfigured = data.resolverConfigured;
		resolverType = data.resolverType;
		if (data.initialUrl) {
			urlInput = data.initialUrl;
			handleUrlChange(data.initialUrl, true);
		}
	});

	onDestroy(() => {
		if (debounceTimer) clearTimeout(debounceTimer);
		infoAbortController?.abort();
		for (const item of history) {
			URL.revokeObjectURL(item.objectUrl);
		}
	});

	function handleUrlChange(nextVal: string, immediate = false) {
		urlInput = nextVal;
		infoError = null;
		errorMessage = null;
		needsResolverNotice = false;

		if (debounceTimer) clearTimeout(debounceTimer);

		const trimmed = nextVal.trim();
		if (!trimmed) {
			parsedUrl = null;
			videoInfo = null;
			lastFetchedVideoId = null;
			startSeconds = 0;
			urlStartSeconds = 0;
			infoLoading = false;
			return;
		}

		const parsed = parseYouTubeUrl(trimmed);
		parsedUrl = parsed;

		if (!parsed) {
			videoInfo = null;
			lastFetchedVideoId = null;
			infoLoading = false;
			if (trimmed.length > 12) {
				infoError = 'Not a recognized YouTube URL yet. Try youtube.com/watch?v=... or youtu.be/...';
			}
			return;
		}

		// Immediately apply the timestamp from the URL (or 0 if none)
		urlStartSeconds = parsed.startSeconds;
		startSeconds = parsed.startSeconds;

		// If the same video is already loaded and only the ?t= param changed, update in place
		if (videoInfo && lastFetchedVideoId === parsed.videoId) {
			videoInfo = {
				...videoInfo,
				canonicalUrl: parsed.canonicalUrl,
				startSeconds: parsed.startSeconds,
				startFormatted: formatSeconds(parsed.startSeconds),
				hasTimestampParam: parsed.hasTimestampParam,
				rawTimestampParam: parsed.rawTimestampParam
			};
			return;
		}

		const delay = immediate ? 0 : 280;
		debounceTimer = setTimeout(() => {
			fetchVideoInfo(parsed);
		}, delay);
	}

	async function fetchVideoInfo(parsed: ParsedYouTubeUrl) {
		infoAbortController?.abort();
		infoAbortController = new AbortController();

		infoLoading = true;
		infoError = null;

		try {
			const res = await fetch(`/api/info?url=${encodeURIComponent(parsed.canonicalUrl)}`, {
				signal: infoAbortController.signal
			});
			const payload = (await res.json()) as VideoInfo & {
				error?: string;
				resolverConfigured?: boolean;
				resolverType?: string;
			};

			if (!res.ok) {
				videoInfo = null;
				lastFetchedVideoId = null;
				infoError = payload.error || 'Could not load video details.';
				return;
			}

			videoInfo = payload;
			lastFetchedVideoId = payload.videoId;
			if (typeof payload.resolverConfigured === 'boolean') {
				resolverConfigured = payload.resolverConfigured;
			}
			if (payload.resolverType) {
				resolverType = payload.resolverType;
			}
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			infoError = 'Network error while fetching video metadata.';
		} finally {
			infoLoading = false;
		}
	}

	async function pasteFromClipboard() {
		try {
			const text = await navigator.clipboard.readText();
			if (text?.trim()) {
				handleUrlChange(text.trim(), true);
			}
		} catch {
			infoError = 'Clipboard access was blocked by the browser — paste directly into the box.';
		}
	}

	function clearUrl() {
		handleUrlChange('', true);
		currentResult = null;
		stage = 'idle';
	}

	async function fetchBytesWithProgress(
		endpoint: string,
		label: string
	): Promise<{ bytes: Uint8Array; contentType: string; resolvedFilename: string }> {
		stage = 'fetching';
		progressPercent = 0;
		statusDetail = label;

		const res = await fetch(endpoint);
		if (!res.ok) {
			const contentType = res.headers.get('content-type') || '';
			if (contentType.includes('application/json')) {
				const errBody = (await res.json().catch(() => ({}))) as {
					error?: string;
					code?: string;
				};
				if (errBody.code === 'RESOLVER_NOT_CONFIGURED') {
					needsResolverNotice = true;
				}
				throw new Error(errBody.error || `Worker returned ${res.status}`);
			}
			throw new Error(`Failed to fetch audio stream (${res.status}).`);
		}

		const contentType = res.headers.get('content-type') || 'audio/webm';
		const resolvedFilename = res.headers.get('x-resolved-filename') || '';
		const totalHeader = res.headers.get('content-length');
		const totalBytes = totalHeader ? Number(totalHeader) : 0;

		if (!res.body) {
			const buf = await res.arrayBuffer();
			progressPercent = 100;
			return { bytes: new Uint8Array(buf), contentType, resolvedFilename };
		}

		const reader = res.body.getReader();
		const chunks: Uint8Array[] = [];
		let received = 0;

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				chunks.push(value);
				received += value.byteLength;
				if (totalBytes > 0) {
					progressPercent = Math.min(99, Math.round((received / totalBytes) * 100));
					statusDetail = `Streaming audio (${formatBytes(received)} / ${formatBytes(totalBytes)})`;
				} else {
					statusDetail = `Streaming audio (${formatBytes(received)})`;
				}
			}
		}

		const merged = new Uint8Array(received);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		progressPercent = 100;
		return { bytes: merged, contentType, resolvedFilename };
	}

	async function runConversionPipeline(params: {
		inputBytes: Uint8Array;
		inputExt: string;
		trimStart: number;
		title: string;
		artist: string;
		sourceLabel: string;
	}) {
		const result = await convertAudioToMp3({
			inputData: params.inputBytes,
			inputExt: params.inputExt,
			startSeconds: params.trimStart,
			bitrate,
			title: params.title,
			artist: params.artist,
			onStage: (s) => {
				stage = s;
				if (s === 'loading-ffmpeg') {
					statusDetail = 'Loading FFmpeg.wasm encoder (cached after first run)…';
				} else {
					statusDetail =
						params.trimStart > 0
							? `Trimming from ${formatSeconds(params.trimStart)} → end & encoding ${bitrate} MP3…`
							: `Encoding full track to ${bitrate} MP3…`;
				}
			},
			onProgress: (pct) => {
				progressPercent = pct;
			}
		});

		const clip: CompletedClip = {
			id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
			title: params.title,
			author: params.artist,
			filename: result.filename,
			objectUrl: result.objectUrl,
			size: result.size,
			bitrate,
			startSeconds: params.trimStart,
			elapsedMs: result.elapsedMs,
			sourceLabel: params.sourceLabel,
			createdAt: Date.now()
		};

		currentResult = clip;
		history = [clip, ...history].slice(0, 6);
		stage = 'done';
		statusDetail = 'MP3 ready to play or download';
	}

	async function convertYouTube() {
		if (!parsedUrl) return;
		errorMessage = null;
		needsResolverNotice = false;
		currentResult = null;

		if (!resolverConfigured) {
			needsResolverNotice = true;
			stage = 'idle';
			return;
		}

		try {
			const { bytes, contentType, resolvedFilename } = await fetchBytesWithProgress(
				`/api/stream?id=${encodeURIComponent(parsedUrl.videoId)}`,
				'Requesting audio stream from Cloudflare Worker…'
			);

			const ext = guessExtensionFromContentType(contentType, resolvedFilename);
			await runConversionPipeline({
				inputBytes: bytes,
				inputExt: ext,
				trimStart: startSeconds,
				title: videoInfo?.title || `YouTube ${parsedUrl.videoId}`,
				artist: videoInfo?.author || 'YouTube',
				sourceLabel: 'YouTube'
			});
		} catch (err) {
			stage = 'error';
			errorMessage = err instanceof Error ? err.message : 'Conversion failed.';
		}
	}

	async function runDemoConversion() {
		errorMessage = null;
		needsResolverNotice = false;
		currentResult = null;

		// Demo track is 20s long: keep start time within 0–16s so the user always gets an audible clip
		const effectiveStart = startSeconds >= 17 ? 8 : startSeconds;

		try {
			const { bytes, contentType } = await fetchBytesWithProgress(
				'/api/demo-audio',
				'Fetching 20s demo synth track from Worker…'
			);
			const ext = guessExtensionFromContentType(contentType, 'demo.wav');

			await runConversionPipeline({
				inputBytes: bytes,
				inputExt: ext,
				trimStart: effectiveStart,
				title: videoInfo?.title ? `${videoInfo.title} (Demo Audio)` : 'TimeCut 20s Synth Demo',
				artist: 'TimeCut Worker Demo',
				sourceLabel:
					effectiveStart !== startSeconds
						? `Demo (clamped to ${formatSeconds(effectiveStart)})`
						: 'Worker Demo'
			});
		} catch (err) {
			stage = 'error';
			errorMessage = err instanceof Error ? err.message : 'Demo conversion failed.';
		}
	}

	function handleLocalFileSelect(event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		const file = target.files?.[0] ?? null;
		localFile = file;
		errorMessage = null;
		currentResult = null;
		if (stage === 'error' || stage === 'done') stage = 'idle';
	}

	async function convertLocalFile() {
		if (!localFile) return;
		errorMessage = null;
		currentResult = null;

		try {
			stage = 'fetching';
			progressPercent = 50;
			statusDetail = `Reading ${localFile.name}…`;

			const buf = await localFile.arrayBuffer();
			progressPercent = 100;

			const ext = guessExtensionFromContentType(localFile.type, localFile.name);
			const cleanTitle = localFile.name.replace(/\.[^.]+$/, '');

			await runConversionPipeline({
				inputBytes: new Uint8Array(buf),
				inputExt: ext,
				trimStart: startSeconds,
				title: cleanTitle,
				artist: 'Local File',
				sourceLabel: 'Local'
			});
		} catch (err) {
			stage = 'error';
			errorMessage = err instanceof Error ? err.message : 'Failed to convert local file.';
		}
	}

	function triggerDownload(clip: CompletedClip) {
		const a = document.createElement('a');
		a.href = clip.objectUrl;
		a.download = clip.filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	const primaryCtaLabel = $derived(
		startSeconds > 0
			? `Convert from ${formatSeconds(startSeconds)} → MP3`
			: 'Convert full audio → MP3'
	);
</script>

<div class="min-h-dvh pb-[max(2.5rem,env(safe-area-inset-bottom))]">
	<!-- Top mobile-first header -->
	<header class="sticky top-0 z-30 border-b border-surface-800/90 bg-surface-950/85 backdrop-blur-md">
		<div class="mx-auto flex h-14 max-w-lg items-center justify-between px-4">
			<div class="flex items-center gap-2.5">
				<div
					class="flex h-8 w-8 items-center justify-center rounded-xl border border-surface-700 bg-surface-900 shadow-inner"
				>
					<span class="h-2.5 w-2.5 rounded-full bg-signal-500 shadow-[0_0_10px_rgba(255,77,46,0.75)]"></span>
				</div>
				<div>
					<div class="flex items-center gap-2">
						<span class="text-sm font-semibold tracking-tight text-ink-50">TimeCut</span>
						<span
							class="rounded-md border border-surface-700 bg-surface-900 px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink-300"
						>
							MP3
						</span>
					</div>
				</div>
			</div>

			<button
				type="button"
				onclick={() => (setupOpen = true)}
				class="flex min-h-9 items-center gap-2 rounded-xl border border-surface-700 bg-surface-900 px-3 py-1.5 text-xs font-medium text-ink-200 transition hover:bg-surface-850 hover:text-ink-50"
			>
				<span
					class="h-2 w-2 rounded-full {resolverConfigured ? 'bg-emerald-400' : 'bg-amber-400'}"
				></span>
				<span>{resolverConfigured ? 'Worker Ready' : 'Setup Resolver'}</span>
			</button>
		</div>
	</header>

	<main class="mx-auto max-w-lg px-4 pt-5">
		<!-- Compact hero title -->
		<section class="mb-5">
			<h1 class="text-2xl font-semibold tracking-tight text-ink-50 sm:text-[1.65rem]">
				YouTube timestamp to MP3
			</h1>
			<p class="mt-1 text-sm leading-relaxed text-ink-400">
				Drop a link with or without <code class="rounded bg-surface-850 px-1.5 py-0.5 font-mono text-xs text-ink-200">?t=</code>.
				Trims from your start time to the end right in your browser.
			</p>
		</section>

		<!-- Source Mode Switcher -->
		<div
			class="mb-4 grid grid-cols-2 gap-1.5 rounded-2xl border border-surface-800 bg-surface-900 p-1"
			role="tablist"
			aria-label="Audio source"
		>
			<button
				type="button"
				role="tab"
				aria-selected={activeTab === 'youtube'}
				disabled={isBusy}
				onclick={() => {
					activeTab = 'youtube';
					errorMessage = null;
				}}
				class="flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium transition {activeTab ===
				'youtube'
					? 'bg-surface-800 text-ink-50 shadow-sm'
					: 'text-ink-400 hover:text-ink-100'}"
			>
				<svg class="h-4 w-4 text-signal-400" viewBox="0 0 24 24" fill="currentColor">
					<path
						d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31.4 31.4 0 0 0 0 12a31.4 31.4 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31.4 31.4 0 0 0 24 12a31.4 31.4 0 0 0-.5-5.8ZM9.6 15.6V8.4l6.3 3.6-6.3 3.6Z"
					/>
				</svg>
				<span>YouTube Link</span>
			</button>

			<button
				type="button"
				role="tab"
				aria-selected={activeTab === 'local'}
				disabled={isBusy}
				onclick={() => {
					activeTab = 'local';
					errorMessage = null;
					needsResolverNotice = false;
				}}
				class="flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium transition {activeTab ===
				'local'
					? 'bg-surface-800 text-ink-50 shadow-sm'
					: 'text-ink-400 hover:text-ink-100'}"
			>
				<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
					/>
				</svg>
				<span>Local File</span>
			</button>
		</div>

		<!-- MAIN WORKSPACE CARD -->
		<div class="space-y-4 rounded-3xl border border-surface-800 bg-surface-900/95 p-4 shadow-xl sm:p-5">
			{#if activeTab === 'youtube'}
				<!-- YouTube URL Input -->
				<div>
					<label for="yt-url-input" class="mb-2 block text-xs font-medium tracking-wide text-ink-300 uppercase">
						YouTube URL
					</label>

					<div class="flex items-stretch gap-2">
						<div class="relative flex-1">
							<input
								id="yt-url-input"
								type="url"
								inputmode="url"
								enterkeyhint="go"
								autocomplete="off"
								spellcheck="false"
								disabled={isBusy}
								value={urlInput}
								oninput={(e) => handleUrlChange((e.currentTarget as HTMLInputElement).value)}
								placeholder="https://youtu.be/...?t=1m35s"
								class="h-12 w-full rounded-xl border border-surface-700 bg-surface-950 pr-10 pl-3.5 text-sm text-ink-50 transition outline-none placeholder:text-ink-500 focus:border-signal-400 focus:ring-2 focus:ring-signal-500/20 disabled:opacity-50"
							/>

							{#if urlInput}
								<button
									type="button"
									disabled={isBusy}
									onclick={clearUrl}
									aria-label="Clear URL"
									class="absolute top-1/2 right-1.5 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-ink-400 transition hover:bg-surface-850 hover:text-ink-100"
								>
									<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
										<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							{/if}
						</div>

						<button
							type="button"
							disabled={isBusy}
							onclick={pasteFromClipboard}
							class="flex min-h-12 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-surface-700 bg-surface-850 px-3.5 text-xs font-medium text-ink-100 transition active:scale-[0.98] hover:bg-surface-800 disabled:opacity-40"
						>
							<svg class="h-4 w-4 text-ink-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
								/>
							</svg>
							<span>Paste</span>
						</button>
					</div>

					{#if infoError}
						<p class="mt-2 text-xs text-signal-400">{infoError}</p>
					{/if}

					<!-- Quick sample URLs when input is empty -->
					{#if !urlInput}
						<div class="mt-3 flex flex-wrap items-center gap-1.5">
							<span class="mr-0.5 text-[11px] text-ink-500">Try:</span>
							{#each exampleLinks as sample}
								<button
									type="button"
									onclick={() => handleUrlChange(sample.url, true)}
									class="min-h-8 rounded-lg border border-surface-800 bg-surface-950/80 px-2.5 py-1 font-mono text-[11px] text-ink-300 transition hover:border-surface-700 hover:bg-surface-850 hover:text-ink-50"
								>
									{sample.label}
								</button>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Video Metadata Preview Card -->
				{#if infoLoading}
					<div class="flex items-center gap-3 rounded-2xl border border-surface-800 bg-surface-950/60 p-3">
						<div class="h-16 w-24 shrink-0 animate-pulse rounded-xl bg-surface-850"></div>
						<div class="flex-1 space-y-2">
							<div class="h-3.5 w-3/4 animate-pulse rounded bg-surface-850"></div>
							<div class="h-3 w-1/2 animate-pulse rounded bg-surface-850"></div>
						</div>
					</div>
				{:else if parsedUrl}
					<div class="overflow-hidden rounded-2xl border border-surface-700/80 bg-surface-950/80">
						<div class="flex gap-3 p-3">
							<div class="relative h-18 w-30 shrink-0 overflow-hidden rounded-xl bg-surface-850">
								<img
									src={videoInfo?.thumbnailUrl || `https://i.ytimg.com/vi/${parsedUrl.videoId}/hqdefault.jpg`}
									alt={videoInfo?.title || 'YouTube thumbnail'}
									class="h-full w-full object-cover"
									loading="lazy"
								/>
								<div
									class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-1.5 pt-3 pb-1"
								>
									<span class="font-mono text-[10px] font-semibold text-ink-50 tabular-nums">
										{formatSeconds(startSeconds)} → END
									</span>
								</div>
							</div>

							<div class="min-w-0 flex-1">
								<p class="line-clamp-2 text-sm leading-snug font-medium text-ink-50">
									{videoInfo?.title || `YouTube Video (${parsedUrl.videoId})`}
								</p>
								<p class="mt-0.5 truncate text-xs text-ink-400">
									{videoInfo?.author || 'YouTube'}
								</p>
								<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
									{#if parsedUrl.hasTimestampParam}
										<span
											class="inline-flex items-center gap-1 rounded-md bg-signal-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-signal-400"
										>
											URL ?t={parsedUrl.rawTimestampParam}
										</span>
									{:else}
										<span
											class="inline-flex items-center rounded-md bg-surface-850 px-1.5 py-0.5 font-mono text-[10px] text-ink-400"
										>
											No ?t= param (starts 00:00)
										</span>
									{/if}
								</div>
							</div>
						</div>
					</div>
				{/if}
			{:else}
				<!-- Local File Picker -->
				<div>
					<label
						for="local-file-input"
						class="mb-2 block text-xs font-medium tracking-wide text-ink-300 uppercase"
					>
						Audio or Video File
					</label>

					<input
						bind:this={fileInputEl}
						id="local-file-input"
						type="file"
						accept="audio/*,video/*"
						disabled={isBusy}
						onchange={handleLocalFileSelect}
						class="sr-only"
					/>

					<button
						type="button"
						disabled={isBusy}
						onclick={() => fileInputEl?.click()}
						class="flex w-full flex-col items-center justify-center rounded-2xl border border-dashed border-surface-700 bg-surface-950/70 px-4 py-7 text-center transition hover:border-signal-400/70 hover:bg-surface-950 disabled:opacity-50"
					>
						<div
							class="flex h-11 w-11 items-center justify-center rounded-2xl border border-surface-700 bg-surface-850 text-signal-400"
						>
							<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
								/>
							</svg>
						</div>

						{#if localFile}
							<p class="mt-3 max-w-full truncate text-sm font-medium text-ink-50">{localFile.name}</p>
							<p class="mt-0.5 font-mono text-xs text-ink-400">
								{formatBytes(localFile.size)} · Tap to replace
							</p>
						{:else}
							<p class="mt-3 text-sm font-medium text-ink-100">Tap to choose an audio or video file</p>
							<p class="mt-0.5 text-xs text-ink-400">
								MP4, WebM, M4A, WAV, OGG, MP3 — processed 100% locally
							</p>
						{/if}
					</button>
				</div>
			{/if}

			<!-- Start Time Control + Quality Selector (shown when a YouTube link or local file is active) -->
			{#if (activeTab === 'youtube' && parsedUrl) || (activeTab === 'local' && localFile)}
				<TimestampControl
					{startSeconds}
					urlStartSeconds={activeTab === 'youtube' ? urlStartSeconds : 0}
					hasUrlTimestamp={activeTab === 'youtube' && Boolean(parsedUrl?.hasTimestampParam)}
					disabled={isBusy}
					onChange={(sec) => {
						startSeconds = sec;
					}}
				/>

				<!-- MP3 Quality selector -->
				<div>
					<div class="mb-2 flex items-center justify-between">
						<span class="text-xs font-medium tracking-wide text-ink-300 uppercase">MP3 Bitrate</span>
						<span class="font-mono text-[11px] text-ink-400">LAME CBR · 44.1 kHz</span>
					</div>
					<div class="grid grid-cols-3 gap-2">
						{#each bitrates as option}
							<button
								type="button"
								disabled={isBusy}
								onclick={() => (bitrate = option.value)}
								class="flex min-h-12 flex-col items-center justify-center rounded-xl border px-2 py-1.5 transition active:scale-[0.98] disabled:opacity-50 {bitrate ===
								option.value
									? 'border-signal-500/70 bg-signal-500/12 text-ink-50'
									: 'border-surface-700/80 bg-surface-950/70 text-ink-300 hover:bg-surface-850 hover:text-ink-100'}"
							>
								<span class="font-mono text-sm font-semibold tabular-nums">{option.label}</span>
								<span class="text-[10px] text-ink-400">{option.hint}</span>
							</button>
						{/each}
					</div>
				</div>

				<!-- Primary Convert CTA -->
				<button
					type="button"
					disabled={isBusy}
					onclick={activeTab === 'youtube' ? convertYouTube : convertLocalFile}
					class="flex min-h-13 w-full items-center justify-center gap-2.5 rounded-2xl bg-signal-500 px-5 py-3.5 text-sm font-semibold text-white shadow-[0_8px_24px_-6px_rgba(255,77,46,0.55)] transition active:scale-[0.985] hover:bg-signal-400 disabled:pointer-events-none disabled:opacity-50"
				>
					{#if isBusy}
						<span class="inline-flex h-4 items-end gap-0.5" aria-hidden="true">
							<span class="h-full w-0.5 origin-bottom rounded-full bg-white animate-eq-1"></span>
							<span class="h-full w-0.5 origin-bottom rounded-full bg-white animate-eq-2"></span>
							<span class="h-full w-0.5 origin-bottom rounded-full bg-white animate-eq-3"></span>
							<span class="h-full w-0.5 origin-bottom rounded-full bg-white animate-eq-4"></span>
						</span>
						<span>Processing…</span>
					{:else}
						<svg class="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
							/>
						</svg>
						<span>{primaryCtaLabel}</span>
					{/if}
				</button>
			{/if}

			<!-- Unconfigured Resolver Helper (honest, actionable, zero dead ends) -->
			{#if activeTab === 'youtube' && !resolverConfigured && (needsResolverNotice || parsedUrl) && !isBusy}
				<div class="rounded-2xl border border-amber-400/25 bg-amber-400/8 p-3.5 text-xs leading-relaxed">
					<div class="flex items-start gap-2.5">
						<span class="mt-1 h-2 w-2 shrink-0 rounded-full bg-amber-400"></span>
						<div class="flex-1 space-y-2.5">
							<p class="text-ink-200">
								<strong class="text-ink-50">YouTube audio resolver not connected yet.</strong>
								Set <code class="rounded bg-surface-900 px-1 py-0.5 font-mono text-[11px] text-ink-100">MEDIA_RESOLVER_URL</code>
								on your Cloudflare Worker to stream live YouTube audio — or test the full Worker → FFmpeg.wasm MP3 trim pipeline right now with a 20s demo track.
							</p>
							<div class="flex flex-wrap gap-2">
								<button
									type="button"
									onclick={runDemoConversion}
									class="min-h-10 rounded-xl bg-surface-800 px-3 py-2 text-xs font-medium text-ink-50 transition hover:bg-surface-700"
								>
									Test with 20s Demo Track
								</button>
								<button
									type="button"
									onclick={() => (setupOpen = true)}
									class="min-h-10 rounded-xl border border-surface-700 bg-surface-950/70 px-3 py-2 text-xs font-medium text-ink-200 transition hover:bg-surface-850 hover:text-ink-50"
								>
									Configure Worker Secret
								</button>
							</div>
						</div>
					</div>
				</div>
			{/if}

			<!-- Live Pipeline Progress Panel -->
			{#if isBusy}
				<div class="rounded-2xl border border-surface-700 bg-surface-950 p-4">
					<div class="flex items-center justify-between gap-2">
						<div class="flex items-center gap-2.5">
							<span class="inline-flex h-4 items-end gap-0.5" aria-hidden="true">
								<span class="h-full w-1 origin-bottom rounded-full bg-signal-500 animate-eq-1"></span>
								<span class="h-full w-1 origin-bottom rounded-full bg-signal-400 animate-eq-2"></span>
								<span class="h-full w-1 origin-bottom rounded-full bg-signal-500 animate-eq-3"></span>
								<span class="h-full w-1 origin-bottom rounded-full bg-signal-400 animate-eq-4"></span>
							</span>
							<span class="text-xs font-medium text-ink-100">
								{#if stage === 'fetching'}
									Step 1/3 · Fetching audio
								{:else if stage === 'loading-ffmpeg'}
									Step 2/3 · Loading FFmpeg.wasm
								{:else}
									Step 3/3 · Encoding MP3
								{/if}
							</span>
						</div>
						<span class="font-mono text-xs font-semibold text-signal-400 tabular-nums">
							{progressPercent}%
						</span>
					</div>

					<div class="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-800">
						<div
							class="h-full rounded-full bg-gradient-to-r from-signal-600 to-signal-400 transition-all duration-200"
							style="width: {Math.max(4, progressPercent)}%"
						></div>
					</div>

					<p class="mt-2.5 text-xs text-ink-400">{statusDetail}</p>
				</div>
			{/if}

			<!-- Error Message -->
			{#if stage === 'error' && errorMessage}
				<div class="rounded-2xl border border-signal-500/40 bg-signal-500/10 p-3.5 text-xs text-ink-100">
					<p class="font-semibold text-signal-400">Conversion failed</p>
					<p class="mt-1 leading-relaxed text-ink-200">{errorMessage}</p>
				</div>
			{/if}
		</div>

		<!-- COMPLETED MP3 RESULT CARD -->
		{#if currentResult}
			<section
				class="mt-4 rounded-3xl border border-emerald-400/30 bg-surface-900 p-4 shadow-xl sm:p-5"
				aria-live="polite"
			>
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0">
						<div class="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/12 px-2.5 py-0.5 text-[11px] font-medium text-emerald-400">
							<span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
							<span>MP3 Ready</span>
						</div>
						<h2 class="mt-2 truncate text-sm font-semibold text-ink-50">
							{currentResult.filename}
						</h2>
						<p class="mt-0.5 font-mono text-[11px] text-ink-400 tabular-nums">
							{formatBytes(currentResult.size)} · {currentResult.bitrate} ·
							{currentResult.startSeconds > 0
								? `from ${formatSeconds(currentResult.startSeconds)} → end`
								: 'full track'} · {(currentResult.elapsedMs / 1000).toFixed(1)}s
						</p>
					</div>
				</div>

				<div class="mt-3.5">
					<audio controls src={currentResult.objectUrl} class="studio-audio"></audio>
				</div>

				<div class="mt-3.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
					<button
						type="button"
						onclick={() => currentResult && triggerDownload(currentResult)}
						class="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-ink-50 px-4 py-3 text-sm font-semibold text-surface-950 transition active:scale-[0.985] hover:bg-white"
					>
						<svg class="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
							/>
						</svg>
						<span>Download MP3</span>
					</button>

					<button
						type="button"
						onclick={() => {
							currentResult = null;
							stage = 'idle';
						}}
						class="flex min-h-12 items-center justify-center rounded-2xl border border-surface-700 bg-surface-850 px-4 py-3 text-sm font-medium text-ink-200 transition hover:bg-surface-800 hover:text-ink-50"
					>
						Convert Another
					</button>
				</div>
			</section>
		{/if}

		<!-- Quick Pipeline Test Banner when idle and no URL pasted yet -->
		{#if activeTab === 'youtube' && !urlInput && !currentResult}
			<section class="mt-4 rounded-2xl border border-surface-800 bg-surface-900/60 p-4">
				<div class="flex items-center justify-between gap-3">
					<div>
						<p class="text-xs font-medium text-ink-200">Want to test FFmpeg.wasm right away?</p>
						<p class="mt-0.5 text-xs text-ink-400">
							Encode a 20s Worker-generated synth track to MP3 in your browser.
						</p>
					</div>
					<button
						type="button"
						disabled={isBusy}
						onclick={runDemoConversion}
						class="min-h-10 shrink-0 rounded-xl border border-surface-700 bg-surface-850 px-3 py-2 text-xs font-medium text-ink-100 transition hover:bg-surface-800 disabled:opacity-40"
					>
						Run Demo
					</button>
				</div>
			</section>
		{/if}

		<!-- Session History -->
		{#if history.length > 1}
			<section class="mt-6">
				<h3 class="mb-2.5 px-1 font-mono text-[11px] font-medium tracking-wider text-ink-400 uppercase">
					Session Downloads ({history.length})
				</h3>
				<div class="space-y-2">
					{#each history as item (item.id)}
						<div
							class="flex items-center justify-between gap-3 rounded-2xl border border-surface-800 bg-surface-900/80 px-3.5 py-2.5"
						>
							<div class="min-w-0">
								<p class="truncate text-xs font-medium text-ink-100">{item.filename}</p>
								<p class="mt-0.5 font-mono text-[11px] text-ink-400 tabular-nums">
									{formatBytes(item.size)} · {item.bitrate} · from {formatSeconds(item.startSeconds)}
								</p>
							</div>
							<div class="flex shrink-0 items-center gap-1.5">
								<button
									type="button"
									onclick={() => (currentResult = item)}
									class="min-h-9 rounded-lg border border-surface-700 bg-surface-850 px-2.5 text-xs text-ink-200 transition hover:bg-surface-800 hover:text-ink-50"
								>
									Play
								</button>
								<button
									type="button"
									onclick={() => triggerDownload(item)}
									class="min-h-9 rounded-lg bg-surface-800 px-2.5 text-xs font-medium text-ink-50 transition hover:bg-surface-700"
								>
									Save
								</button>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Footer info -->
		<footer class="mt-8 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-ink-500">
			<span>SvelteKit · Tailwind v4 · Cloudflare Workers</span>
			<span>Client-side FFmpeg.wasm</span>
		</footer>
	</main>
</div>

<SetupSheet
	open={setupOpen}
	{resolverConfigured}
	{resolverType}
	onClose={() => (setupOpen = false)}
/>
