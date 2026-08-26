import { useCallback, useState } from "react";

import { useEditor } from "@/hooks/use-editor";
import { aiClient } from "@/lib/ai-client";
import {
	type ReframeOptions,
	type ReframePreset,
	type ReframeResult,
	type ReframeTarget,
	buildReframeTimelineUpdate,
	computeReframeKeyframes,
	getDefaultReframeOptions,
} from "@/lib/reframe/reframe-types";
import type { FaceDetectionResult } from "@/types/ai";

export type ReframeStatus = "idle" | "detecting" | "computing" | "applying" | "done" | "error";

export interface UseSmartReframeReturn {
	status: ReframeStatus;
	progress: number;
	result: ReframeResult | null;
	error: string | null;
	/** SCRUM-79: element the pending result belongs to (null until computed). */
	target: ReframeTarget | null;
	startReframe: (
		elementId: string,
		trackId: string,
		preset: ReframePreset,
		options?: Partial<ReframeOptions>,
	) => Promise<void>;
	applyKeyframes: () => void;
	reset: () => void;
}

export function useSmartReframe(): UseSmartReframeReturn {
	const editor = useEditor();
	const [status, setStatus] = useState<ReframeStatus>("idle");
	const [progress, setProgress] = useState(0);
	const [result, setResult] = useState<ReframeResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [target, setTarget] = useState<ReframeTarget | null>(null);

	const startReframe = useCallback(
		async (
			elementId: string,
			trackId: string,
			preset: ReframePreset,
			options?: Partial<ReframeOptions>,
		) => {
			setStatus("detecting");
			setProgress(0);
			setError(null);
			setResult(null);
			setTarget(null);

			try {
				const tracks = editor.timeline.getTracks();
				const track = tracks.find((t) => t.id === trackId);
				if (!track) throw new Error("Track not found");

				const element = track.elements.find((e) => e.id === elementId);
				if (element?.type !== "video") {
					throw new Error("Element must be a video");
				}

				const videoEl = element;
				if (!videoEl.mediaId) throw new Error("Video has no media source");

				const media = editor.media.getAssetById(videoEl.mediaId);
				if (!media?.file) throw new Error("Media file not available");

				setProgress(10);

				const detection: FaceDetectionResult = await aiClient.detectFaces(media.file, {
					sampleInterval: 0.5,
					maxSamples: 240,
				});

				setProgress(60);
				setStatus("computing");

				const opts: ReframeOptions = {
					...getDefaultReframeOptions(),
					targetWidth: preset.width,
					targetHeight: preset.height,
					...options,
				};

				const keyframes = computeReframeKeyframes(detection, opts);

				setProgress(80);

				const reframeResult: ReframeResult = {
					keyframes,
					preset,
					detectionResult: detection,
					framesAnalyzed: detection.frames.length,
				};

				setResult(reframeResult);
				setTarget({ elementId, trackId });
				setProgress(100);
				setStatus("done");
			} catch (err) {
				setStatus("error");
				setError(err instanceof Error ? err.message : "Smart Reframe failed");
			}
		},
		[editor],
	);

	const applyKeyframes = useCallback(() => {
		if (!result || !target) return;

		setStatus("applying");

		try {
			// SCRUM-79: build a single scoped update for the analysed element
			// instead of mutating every video on the timeline.
			const update = buildReframeTimelineUpdate({
				tracks: editor.timeline.getTracks(),
				target,
				keyframes: result.keyframes,
			});
			if (!update) {
				throw new Error("Reframed element no longer exists in the timeline");
			}

			editor.timeline.updateElements({ updates: [update] });

			// SCRUM-79: resize the project canvas to the preset so the preview
			// and any subsequent export render at the reframed aspect ratio.
			void editor.project.updateSettings({
				settings: {
					canvasSize: { width: result.preset.width, height: result.preset.height },
				},
				pushHistory: false,
			});

			setStatus("done");
		} catch (err) {
			setStatus("error");
			setError(err instanceof Error ? err.message : "Failed to apply keyframes");
		}
	}, [result, target, editor]);

	const reset = useCallback(() => {
		setStatus("idle");
		setProgress(0);
		setResult(null);
		setError(null);
		setTarget(null);
	}, []);

	return {
		status,
		progress,
		result,
		error,
		target,
		startReframe,
		applyKeyframes,
		reset,
	};
}
