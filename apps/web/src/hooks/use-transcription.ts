import { useState, useCallback } from "react";
import { aiClient, AIClientError } from "@/lib/ai-client";
import {
	resolveProvider,
	resolvedProviderType,
} from "@/lib/ai/registry";
import { registerBuiltinProviders } from "@/lib/ai/providers";
import { useTranscriptStore } from "@/stores/transcript-store";

// Register built-in cloud + local-wasm providers once
registerBuiltinProviders();

function formatTranscriptionError(error: unknown): string {
	if (error instanceof AIClientError) {
		switch (error.errorType) {
			case "connection_refused":
				return "Cannot connect to AI backend. Start the backend server first (see AI Setup Guide).";
			case "timeout":
				return "Transcription request timed out. The model may still be loading — try again in a moment.";
			case "backend_error":
				return error.statusCode === 400
					? "Invalid file format. Supported: mp4, mkv, avi, mov, webm, wav, mp3, m4a, ogg, flac, aac."
					: `Backend error: ${error.message}`;
			default:
				return error.message;
		}
	}
	return error instanceof Error ? error.message : "Transcription failed";
}

export function useTranscription() {
	const [error, setError] = useState<string | null>(null);
	const [activeProvider, setActiveProvider] = useState<string | null>(null);

	const {
		isTranscribing,
		progress,
		setTranscribing,
		setProgress,
		setSegments,
		setLanguage,
	} = useTranscriptStore();

	const transcribeVideo = useCallback(
		async (file: File, language?: string) => {
			setError(null);
			setTranscribing(true);
			setProgress(0);

			try {
				setProgress(5);

				const args = { file, language };
				let result;
				let providerType = resolvedProviderType({
					feature: "transcribe",
				});

				// Primary attempt via registry resolution
				const localImpl = resolveProvider({ feature: "transcribe" });
				if (!localImpl) {
					throw new AIClientError(
						"No transcription provider available",
						"unknown",
					);
				}
				setActiveProvider(providerType);

				try {
					result = await localImpl(args);
				} catch (localErr) {
					// Fallback chain: if a local/wasm provider failed, retry on cloud
					if (providerType !== "cloud") {
						console.warn(
							"[ai-modules] local transcription failed, falling back to cloud:",
							localErr,
						);
						providerType = "cloud";
						setActiveProvider("cloud");
						result = await aiClient.transcribe(file, language);
					} else {
						throw localErr;
					}
				}

				setProgress(95);
				setSegments(result.segments);
				setLanguage(result.language);
				setProgress(100);

				return result;
			} catch (err) {
				const message = formatTranscriptionError(err);
				setError(message);
				throw err;
			} finally {
				setTranscribing(false);
			}
		},
		[setTranscribing, setProgress, setSegments, setLanguage],
	);

	const clearError = useCallback(() => {
		setError(null);
	}, []);

	return {
		transcribeVideo,
		isTranscribing,
		progress,
		error,
		activeProvider,
		clearError,
	};
}
