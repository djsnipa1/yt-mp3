import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { sanitizeFilename } from '$lib/youtube';

export type Mp3Bitrate = '128k' | '192k' | '320k';

export interface ConvertOptions {
	inputData: Uint8Array;
	inputExt: string;
	startSeconds: number;
	bitrate: Mp3Bitrate;
	title: string;
	artist?: string;
	onStage?: (stage: 'loading-ffmpeg' | 'encoding') => void;
	onProgress?: (percent: number) => void;
	onLog?: (message: string) => void;
}

export interface ConvertResult {
	blob: Blob;
	objectUrl: string;
	size: number;
	filename: string;
	elapsedMs: number;
}

// Single-threaded @ffmpeg/core works without SharedArrayBuffer / COOP-COEP headers
// and avoids Cloudflare Workers' 25 MiB static asset file size limit.
const FFMPEG_CORE_BASE_URLS = [
	'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm',
	'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm'
];

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
	if (ffmpegInstance?.loaded) {
		return ffmpegInstance;
	}

	if (ffmpegLoadPromise) {
		return ffmpegLoadPromise;
	}

	ffmpegLoadPromise = (async () => {
		const ffmpeg = new FFmpeg();
		let lastError: unknown = null;

		for (const baseUrl of FFMPEG_CORE_BASE_URLS) {
			try {
				const coreURL = await toBlobURL(`${baseUrl}/ffmpeg-core.js`, 'text/javascript');
				const wasmURL = await toBlobURL(`${baseUrl}/ffmpeg-core.wasm`, 'application/wasm');

				await ffmpeg.load({ coreURL, wasmURL });
				ffmpegInstance = ffmpeg;
				return ffmpeg;
			} catch (err) {
				lastError = err;
			}
		}

		ffmpegLoadPromise = null;
		throw new Error(
			`Could not load FFmpeg.wasm core in browser. Check network connectivity. (${
				lastError instanceof Error ? lastError.message : 'Unknown error'
			})`
		);
	})();

	return ffmpegLoadPromise;
}

export function guessExtensionFromContentType(contentType: string, fallbackName = ''): string {
	const ct = contentType.toLowerCase();
	if (ct.includes('wav')) return 'wav';
	if (ct.includes('webm')) return 'webm';
	if (ct.includes('ogg') || ct.includes('opus')) return 'ogg';
	if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3';
	if (ct.includes('mp4') || ct.includes('m4a') || ct.includes('aac')) return 'm4a';
	if (ct.includes('flac')) return 'flac';

	const match = /\.([a-z0-9]{2,5})$/i.exec(fallbackName.trim());
	if (match) return match[1].toLowerCase();
	return 'webm';
}

export async function convertAudioToMp3(options: ConvertOptions): Promise<ConvertResult> {
	const startedAt = performance.now();
	options.onStage?.('loading-ffmpeg');
	options.onProgress?.(0);

	const ffmpeg = await getFFmpeg();

	options.onStage?.('encoding');

	const safeExt = options.inputExt.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'webm';
	const runId = Math.random().toString(36).slice(2, 8);
	const inputPath = `in_${runId}.${safeExt}`;
	const outputPath = `out_${runId}.mp3`;

	const handleProgress = ({ progress }: { progress: number }) => {
		// FFmpeg.wasm can occasionally report negative or >1 progress values on short clips
		const clamped = Math.max(0, Math.min(100, Math.round(progress * 100)));
		options.onProgress?.(clamped);
	};

	const handleLog = ({ message }: { message: string }) => {
		options.onLog?.(message);
	};

	ffmpeg.on('progress', handleProgress);
	ffmpeg.on('log', handleLog);

	try {
		await ffmpeg.writeFile(inputPath, options.inputData);

		const args: string[] = [];

		// Fast input seek when starting past 0s (trims from startSeconds to end of audio)
		if (options.startSeconds > 0) {
			args.push('-ss', String(Math.floor(options.startSeconds)));
		}

		args.push(
			'-i',
			inputPath,
			'-vn',
			'-acodec',
			'libmp3lame',
			'-b:a',
			options.bitrate,
			'-ar',
			'44100',
			'-map_metadata',
			'-1',
			'-metadata',
			`title=${options.title.slice(0, 120)}`
		);

		if (options.artist) {
			args.push('-metadata', `artist=${options.artist.slice(0, 120)}`);
		}

		args.push('-y', outputPath);

		const exitCode = await ffmpeg.exec(args);
		if (exitCode !== 0) {
			throw new Error(`FFmpeg exited with code ${exitCode}. The input stream may be unsupported or corrupted.`);
		}

		const data = await ffmpeg.readFile(outputPath);
		const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);

		if (bytes.byteLength < 128) {
			throw new Error(
				options.startSeconds > 0
					? 'The resulting MP3 was empty — your start timestamp may be past the end of the audio.'
					: 'The resulting MP3 file was empty.'
			);
		}

		// Copy into a standard ArrayBuffer-backed Uint8Array for strict BlobPart compatibility
		const mp3Bytes = new Uint8Array(bytes.byteLength);
		mp3Bytes.set(bytes);

		const blob = new Blob([mp3Bytes], { type: 'audio/mpeg' });
		const objectUrl = URL.createObjectURL(blob);
		const filename = sanitizeFilename(options.title, options.startSeconds);

		options.onProgress?.(100);

		return {
			blob,
			objectUrl,
			size: blob.size,
			filename,
			elapsedMs: Math.round(performance.now() - startedAt)
		};
	} finally {
		ffmpeg.off('progress', handleProgress);
		ffmpeg.off('log', handleLog);
		await ffmpeg.deleteFile(inputPath).catch(() => {});
		await ffmpeg.deleteFile(outputPath).catch(() => {});
	}
}
