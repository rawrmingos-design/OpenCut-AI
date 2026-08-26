/**
 * SCRUM-81: Batch export overlay builder.
 *
 * Builds extra TimelineTrack objects (subtitle + hook text) that the renderer
 * merges on top of range-rebased clip tracks at export time — WITHOUT touching
 * the live editor project or timeline. All operations are pure data transforms.
 *
 * Overlay tracks are authored in REBASED time (t=0 = clipStart), so they slot
 * directly into the tracks already produced by `rebaseTracksToTimeWindow`.
 */

import { generateUUID } from "@/utils/id";
import type { TextTrack, TimelineTrack } from "@/types/timeline";
import type { BatchOverlayMetadata } from "@/types/export";
import type { PopoverSubtitlePreset } from "@/lib/podcast/subtitle-presets";
import {
	buildPopoverSubtitleElements,
	distributeElementsToTracks,
} from "@/lib/podcast/subtitle-presets";
import {
	buildHookTextElement,
	HOOK_TEXT_DEFAULT_DURATION,
} from "@/lib/podcast/hook-text";

type ReframeKf = {
	id: string;
	time: number;
	value: number;
	interpolation: "linear" | "hold";
};

/**
 * Rebase face-tracking keyframes from SOURCE time into clip-local time
 * (clipStart = t=0).
 *
 * Keyframes before the clip window are CLAMPED to t=0 (their value holds at
 * the clip start, preserving crop continuity); keyframes after the window
 * are dropped. If a channel has no keyframes at all, a flat fallback is
 * returned so the crop stays deterministic.
 *
 * Returns a channel triple ready for `videoReframeAnimations` in the metadata.
 */
export function rebaseReframeKeyframesForClip(
	keyframes: {
		positionX: ReframeKf[];
		positionY: ReframeKf[];
		scale: ReframeKf[];
	},
	clipStart: number,
	clipDuration: number,
): NonNullable<BatchOverlayMetadata["videoReframeAnimations"]>[string] {
	const rebaseChannel = (channel: ReframeKf[], fallback: number): ReframeKf[] => {
		const sorted = [...channel].sort((a, b) => a.time - b.time);
		const inside = sorted.filter(
			(kf) =>
				kf.time >= clipStart - 0.01 &&
				kf.time <= clipStart + clipDuration + 0.01,
		);
		const prior = sorted.filter((kf) => kf.time < clipStart - 0.01).at(-1);
		const boundary = prior ?? inside[0];

		if (!boundary) {
			return [{ id: "rk-0", time: 0, value: fallback, interpolation: "linear" }];
		}

		const rebased: ReframeKf[] = [
			{
				id: `${boundary.id}-boundary`,
				time: 0,
				value: boundary.value,
				interpolation: "linear",
			},
		];
		for (const [index, kf] of inside.entries()) {
			const time = Math.max(0, Math.min(clipDuration, kf.time - clipStart));
			if (time <= 0.01 && boundary === kf) continue;
			rebased.push({
				id: `${kf.id}-c${index}`,
				time,
				value: kf.value,
				interpolation: "linear",
			});
		}
		return rebased;
	};

	const fallbackScale = keyframes.scale.length > 0 ? keyframes.scale[0].value : 1;

	return {
		positionX: rebaseChannel(keyframes.positionX, 0),
		positionY: rebaseChannel(keyframes.positionY, 0),
		scale: rebaseChannel(keyframes.scale, fallbackScale),
	};
}

/**
 * Build TextTrack[] to inject over the rebased clip tracks at render time.
 *
 * All returned elements have `startTime` in REBASED time (clipStart = t=0),
 * ready to pass directly to `buildScene`. The live editor state is never read
 * or mutated.
 */
export function buildBatchOverlayTracks(meta: BatchOverlayMetadata): TimelineTrack[] {
	const {
		segments,
		clipStart,
		clipDuration,
		hookTitle,
		subtitlePreset,
		canvasWidth,
		canvasHeight,
	} = meta;

	const overlayTracks: TextTrack[] = [];

	// ── Subtitle tracks ─────────────────────────────────────────────────────
	// Segments arrive in SOURCE time; rebase to clipStart = t=0.
	// Words outside the clip window are dropped so nothing leaks past the range.
	const rebasedSegments = segments.map((seg) => ({
		text: seg.text,
		start: Math.max(0, seg.start - clipStart),
		end: Math.min(clipDuration, seg.end - clipStart),
		words: seg.words
			.filter((w) => w.end > clipStart && w.start < clipStart + clipDuration)
			.map((w) => ({
				word: w.word,
				start: Math.max(0, w.start - clipStart),
				end: Math.min(clipDuration, w.end - clipStart),
				confidence: w.confidence,
			})),
	}));

	const subtitleElements = buildPopoverSubtitleElements({
		segments: rebasedSegments,
		preset: subtitlePreset as PopoverSubtitlePreset,
		canvasHeight,
		canvasWidth,
	});

	const trackBuckets = distributeElementsToTracks(subtitleElements);

	for (let i = 0; i < trackBuckets.length; i++) {
		const label =
			trackBuckets.length === 1 ? "Popover Subs" : `Popover Subs ${i + 1}`;
		const elements = trackBuckets[i].map((el) => ({ ...el, id: generateUUID() }));
		overlayTracks.push({
			id: generateUUID(),
			type: "text",
			name: label,
			hidden: false,
			elements: elements as TextTrack["elements"],
		});
	}

	// ── Hook text track ──────────────────────────────────────────────────────
	if (hookTitle.trim().length > 0) {
		const hookDuration = Math.max(
			1,
			Math.min(HOOK_TEXT_DEFAULT_DURATION, clipDuration * 0.25),
		);
		const hookElement = buildHookTextElement({
			title: hookTitle,
			startTime: 0,
			duration: hookDuration,
			canvasWidth,
			canvasHeight,
		});
		overlayTracks.push({
			id: generateUUID(),
			type: "text",
			name: "Hook Text",
			hidden: false,
			elements: [{ ...hookElement, id: generateUUID() }] as TextTrack["elements"],
		});
	}

	return overlayTracks;
}
