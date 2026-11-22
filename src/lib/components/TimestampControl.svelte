<script lang="ts">
	import { formatSeconds, parseTimestampToSeconds } from '$lib/youtube';

	interface Props {
		startSeconds: number;
		urlStartSeconds: number;
		hasUrlTimestamp: boolean;
		disabled?: boolean;
		onChange: (seconds: number) => void;
	}

	let {
		startSeconds,
		urlStartSeconds,
		hasUrlTimestamp,
		disabled = false,
		onChange
	}: Props = $props();

	let inputText = $state(formatSeconds(0));
	let inputError = $state<string | null>(null);
	let isFocused = $state(false);

	// Keep displayed formatted string synced whenever startSeconds changes externally (e.g. new URL or nudge)
	$effect(() => {
		if (!isFocused) {
			inputText = formatSeconds(startSeconds);
			inputError = null;
		}
	});

	function commitInput() {
		const trimmed = inputText.trim();
		if (!trimmed) {
			inputError = null;
			onChange(0);
			inputText = formatSeconds(0);
			return;
		}
		const parsed = parseTimestampToSeconds(trimmed);
		if (parsed === null) {
			inputError = 'Use MM:SS, HH:MM:SS, 1m30s, or seconds';
			return;
		}
		inputError = null;
		onChange(parsed);
		inputText = formatSeconds(parsed);
	}

	function nudge(delta: number) {
		const next = Math.max(0, startSeconds + delta);
		inputError = null;
		onChange(next);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			commitInput();
			(e.currentTarget as HTMLInputElement).blur();
		}
	}

	const isModifiedFromUrl = $derived(startSeconds !== urlStartSeconds);
</script>

<div class="rounded-2xl border border-surface-700/90 bg-surface-950/75 p-4">
	<div class="flex items-center justify-between gap-2">
		<div>
			<label
				for="start-time-input"
				class="block text-xs font-medium tracking-wide text-ink-300 uppercase"
			>
				Start Time
			</label>
			<p class="mt-0.5 text-xs text-ink-400">
				{#if startSeconds === 0}
					Converts full track from beginning to end
				{:else}
					Starts at <span class="font-mono text-ink-100">{formatSeconds(startSeconds)}</span> through end of video
				{/if}
			</p>
		</div>

		{#if isModifiedFromUrl}
			<button
				type="button"
				{disabled}
				onclick={() => onChange(urlStartSeconds)}
				class="shrink-0 rounded-lg border border-surface-700 bg-surface-850 px-2.5 py-1.5 font-mono text-[11px] font-medium text-signal-400 transition hover:bg-surface-800 disabled:opacity-40"
			>
				{hasUrlTimestamp ? `Reset (${formatSeconds(urlStartSeconds)})` : 'Reset 00:00'}
			</button>
		{:else if startSeconds > 0}
			<button
				type="button"
				{disabled}
				onclick={() => onChange(0)}
				class="shrink-0 rounded-lg border border-surface-700 bg-surface-850 px-2.5 py-1.5 font-mono text-[11px] font-medium text-ink-300 transition hover:bg-surface-800 hover:text-ink-50 disabled:opacity-40"
			>
				From 00:00
			</button>
		{/if}
	</div>

	<!-- Big tactile monospace timestamp field -->
	<div class="mt-3 flex items-center gap-2.5">
		<div class="relative flex-1">
			<input
				id="start-time-input"
				type="text"
				inputmode="text"
				autocomplete="off"
				spellcheck="false"
				{disabled}
				bind:value={inputText}
				onfocus={() => (isFocused = true)}
				onblur={() => {
					isFocused = false;
					commitInput();
				}}
				onkeydown={handleKeydown}
				placeholder="00:00"
				class="h-13 w-full rounded-xl border bg-surface-900 px-4 font-mono text-2xl font-semibold tracking-wider text-ink-50 tabular-nums transition outline-none placeholder:text-ink-500 disabled:opacity-50 {inputError
					? 'border-signal-500 ring-2 ring-signal-500/25'
					: 'border-surface-700 focus:border-signal-400 focus:ring-2 focus:ring-signal-500/20'}"
			/>
			<span
				class="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 rounded-md bg-surface-850 px-2 py-0.5 font-mono text-[11px] text-ink-400"
			>
				→ END
			</span>
		</div>
	</div>

	{#if inputError}
		<p class="mt-1.5 text-xs text-signal-400">{inputError}</p>
	{/if}

	<!-- Thumb-friendly 44px nudge buttons -->
	<div class="mt-3 grid grid-cols-4 gap-2">
		{#each [-15, -5, 5, 15] as delta}
			<button
				type="button"
				disabled={disabled || (delta < 0 && startSeconds === 0)}
				onclick={() => nudge(delta)}
				class="flex min-h-11 items-center justify-center rounded-xl border border-surface-700/80 bg-surface-850 font-mono text-xs font-medium text-ink-200 tabular-nums transition active:scale-[0.97] hover:border-surface-700 hover:bg-surface-800 hover:text-ink-50 disabled:pointer-events-none disabled:opacity-35"
			>
				{delta > 0 ? `+${delta}s` : `${delta}s`}
			</button>
		{/each}
	</div>
</div>
