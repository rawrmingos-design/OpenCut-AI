"use client";

/**
 * Built-in AI provider registrations.
 *
 * Cloud providers wrap the existing AIClient. Local-wasm providers are
 * registered via their own module side effects (imported below).
 * Called once before the first AI feature resolution (see
 * use-transcription.ts).
 */

import type { TranscriptionResult } from "@/types/ai";
import { registerProvider } from "@/lib/ai/registry";
import { aiClient } from "@/lib/ai-client";
import "@/lib/ai/providers/transcribe-local-wasm";

export const AI_FEATURES_BUILT_IN = true;

export function registerBuiltinProviders(): void {
	registerProvider({
		feature: "transcribe",
		type: "cloud",
		impl: async ({
			file,
			language,
		}: {
			file: File;
			language?: string;
		}): Promise<TranscriptionResult> =>
			aiClient.transcribe(file, language),
	});

	registerProvider({
		feature: "auto-caption",
		type: "cloud",
		impl: async ({
			file,
			language,
		}: {
			file: File;
			language?: string;
		}): Promise<TranscriptionResult> =>
			aiClient.transcribe(file, language),
	});

	registerProvider({
		feature: "suggest-cut",
		type: "cloud",
		impl: async ({ file }: { file: File }) =>
			Promise.all([
				aiClient.analyzeFillers(file),
				aiClient.analyzeSilences(file),
			]),
	});

	registerProvider({
		feature: "virality",
		type: "cloud",
		impl: async ({
			file,
			transcriptText,
		}: {
			file: File;
			transcriptText?: string;
		}) => aiClient.engagementScoreVideo(file, transcriptText),
	});
}
