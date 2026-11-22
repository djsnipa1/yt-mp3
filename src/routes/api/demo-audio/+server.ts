import type { RequestHandler } from './$types';

/**
 * Generates a clean 20-second musical synth chord progression as a standard 16-bit PCM WAV
 * right on the Cloudflare Worker (zero external deps, ~880 KB).
 * Each 4-second bar changes chord & melody so trimming at different timestamps (e.g. 00:08)
 * is immediately audible in the resulting FFmpeg.wasm MP3 output.
 */
function generateDemoWav(durationSeconds = 20, sampleRate = 22050): ArrayBuffer {
	const numSamples = durationSeconds * sampleRate;
	const dataSize = numSamples * 2; // 16-bit mono
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	const writeString = (offset: number, str: string) => {
		for (let i = 0; i < str.length; i++) {
			view.setUint8(offset + i, str.charCodeAt(i));
		}
	};

	// RIFF WAV header
	writeString(0, 'RIFF');
	view.setUint32(4, 36 + dataSize, true);
	writeString(8, 'WAVE');
	writeString(12, 'fmt ');
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true); // PCM format
	view.setUint16(22, 1, true); // Mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // Byte rate
	view.setUint16(32, 2, true); // Block align
	view.setUint16(34, 16, true); // Bits per sample
	writeString(36, 'data');
	view.setUint32(40, dataSize, true);

	// 5 distinct warm electric-piano chords (4s each across 20s)
	const chords: number[][] = [
		[220.0, 261.63, 329.63, 392.0], // 00:00–00:04 Am7
		[174.61, 220.0, 261.63, 329.63], // 00:04–00:08 Fmaj7
		[261.63, 329.63, 392.0, 493.88], // 00:08–00:12 Cmaj7
		[196.0, 246.94, 293.66, 392.0], // 00:12–00:16 G6
		[293.66, 349.23, 440.0, 523.25] // 00:16–00:20 Dm7
	];

	const arpOrder = [0, 1, 2, 3, 2, 1, 3, 2];

	for (let i = 0; i < numSamples; i++) {
		const t = i / sampleRate;
		const barIndex = Math.min(chords.length - 1, Math.floor(t / 4));
		const barTime = t - barIndex * 4;
		const chord = chords[barIndex];

		// Soft pad envelope per 4-second bar
		const padEnv = Math.min(1, barTime / 0.12) * Math.exp(-barTime * 0.45);
		let sample = 0;

		for (let n = 0; n < chord.length; n++) {
			const freq = chord[n];
			sample += Math.sin(2 * Math.PI * freq * t) * 0.14 * padEnv;
			sample += Math.sin(2 * Math.PI * freq * 2 * t) * 0.03 * padEnv;
		}

		// Gentle rhythmic chime pluck every 0.5s
		const stepIdx = Math.floor(barTime / 0.5);
		const stepTime = barTime - stepIdx * 0.5;
		const noteFreq = chord[arpOrder[stepIdx % arpOrder.length]] * 2;
		const pluckEnv = Math.min(1, stepTime / 0.008) * Math.exp(-stepTime * 8.5);
		sample += Math.sin(2 * Math.PI * noteFreq * t) * 0.22 * pluckEnv;

		// Soft master fade-out at the very end
		const masterFade = t > durationSeconds - 0.5 ? Math.max(0, (durationSeconds - t) / 0.5) : 1;
		const clamped = Math.max(-0.95, Math.min(0.95, sample * masterFade));
		view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
	}

	return buffer;
}

export const GET: RequestHandler = async () => {
	const wavBuffer = generateDemoWav(20, 22050);

	return new Response(wavBuffer, {
		status: 200,
		headers: {
			'Content-Type': 'audio/wav',
			'Content-Length': String(wavBuffer.byteLength),
			'X-Demo-Duration': '20',
			'Cache-Control': 'public, max-age=3600'
		}
	});
};
