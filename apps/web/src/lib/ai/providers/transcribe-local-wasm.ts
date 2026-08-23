"use client";

/**
 * Local (in-browser) Whisper transcription via transformers.js / WASM.
 *
 * Proof of concept for the AI Modules registry — runs entirely on the
 * user's device with no server round-trip. Registered as a "local-wasm"
 * provider for the "transcribe" feature (min tier: standard).
 *
 * Known PoC limitations:
 * - Runs on the main thread; long audio can briefly block the UI
 *   (Web Worker offload is a follow-up)
 * - whisper-tiny: fast and small (~40MB), moderate accuracy
 */

import type { TranscriptionResult } from "@/types/ai";
import { registerProvider } from "@/lib/ai/registry";
import { decodeAudioToFloat32 } from "@/lib/media/audio";
import { toast } from "sonner";

const WHISPER_MODEL_ID = "Xenova/whisper-tiny";
const TARGET_SAMPLE_RATE = 16_000;

type WhisperPipelineArgs = {
	file: File;
	language?: string;
	onProgress?: (progress: number) => void;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WhisperPipeline = any;

let pipelinePromise: Promise<WhisperPipeline> | null = null;
let downloadToastShown = false;

async function loadPipeline(): Promise<WhisperPipeline> {
	if (!pipelinePromise) {
		pipelinePromise = (async () => {
			if (!downloadToastShown) {
				toast.info("Downloading local Whisper model (~40MB), one-time…");
				downloadToastShown = true;
			}
			const { pipeline, env } = await import(
				"@huggingface/transformers"
			);
			env.allowLocalModels = false;
			const transcriber = await pipeline(
				"automatic-speech-recognition",
				WHISPER_MODEL_ID,
			);
			toast.success("Local Whisper ready");
			return transcriber;
		})();
		pipelinePromise.catch(() => {
			// Allow retry on next call if loading failed
			pipelinePromise = null;
		});
	}
	return pipelinePromise;
}

async function resampleTo16k({
	samples,
	sampleRate,
}: {
	samples: Float32Array;
	sampleRate: number;
}): Promise<Float32Array> {
	if (sampleRate === TARGET_SAMPLE_RATE) return samples;

	const duration = samples.length / sampleRate;
	const offline = new OfflineAudioContext(
		1,
		Math.ceil(duration * TARGET_SAMPLE_RATE),
		TARGET_SAMPLE_RATE,
	);
	const buffer = offline.createBuffer(1, samples.length, sampleRate);
	buffer.getChannelData(0).set(samples);

	const source = offline.createBufferSource();
	source.buffer = buffer;
	source.connect(offline.destination);
	source.start();

	const rendered = await offline.startRendering();
	return rendered.getChannelData(0);
}

export async function transcribeLocalWasm({
	file,
	language,
	onProgress,
}: WhisperPipelineArgs): Promise<TranscriptionResult> {
	onProgress?.(0.02);

	const { samples, sampleRate } = await decodeAudioToFloat32({
		audioBlob: file,
	});
	const audio = await resampleTo16k({ samples, sampleRate });
	const duration = audio.length / TARGET_SAMPLE_RATE;

	onProgress?.(0.08);

	const transcriber = await loadPipeline();
	onProgress?.(0.25);

	const options: Record<string, unknown> = {
		return_timestamps: true,
		chunk_length_s: 30,
		stride_length_s: 5,
	};
	if (language && language !== "auto") {
		options.language = language;
	}

	const output = await transcriber(audio, options);
	onProgress?.(1);

	const chunks = Array.isArray(output) ? output : [output];
	const segments = chunks
		.map((chunk, index) => ({
			id: index,
			text: String(chunk?.text ?? "").trim(),
			start: Number(chunk?.timestamp?.[0] ?? 0),
			end: Number(chunk?.timestamp?.[1] ?? 0),
			words: [] as TranscriptionResult["segments"][number]["words"],
		}))
		.filter((segment) => segment.text.length > 0);

	return {
		segments,
		language: language && language !== "auto" ? language : "en",
		duration,
	};
}

export function registerTranscribeLocalWasm(): void {
	registerProvider({
		feature: "transcribe",
		type: "local-wasm",
		minTier: "standard",
		impl: transcribeLocalWasm,
	});
}

// Side-effect registration on import
registerTranscribeLocalWasm();
