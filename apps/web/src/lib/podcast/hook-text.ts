/**
 * Hook text for podcast clips (SCRUM-80).
 *
 * OpusClip-style shorts open with the clip title rendered as bold
 * on-screen text during the first seconds. This module builds that
 * opening hook as a standard TextElement so it renders in preview
 * and burns into exports like any other text layer.
 */

import type { CreateTextElement } from "@/types/timeline";
import { DEFAULT_TEXT_ELEMENT } from "@/constants/text-constants";

/** Hard cap for hook duration (seconds) regardless of caller input. */
export const HOOK_TEXT_MAX_DURATION = 5;
/** Minimum readable on-screen time (seconds). */
export const HOOK_TEXT_MIN_DURATION = 1;
/** Default hook duration when applied to the timeline. */
export const HOOK_TEXT_DEFAULT_DURATION = 3;

/** Longest hook content (excluding ellipsis) before truncation. */
const MAX_HOOK_CHARS = 60;
const ELLIPSIS = "…";

/**
 * Rough width estimate for bold sans-serif text in editor units,
 * mirroring the approximation used by popover subtitle layout.
 */
function estimateHookWidth(text: string, fontSize: number): number {
	return text.length * fontSize * 0.55;
}

/**
 * Truncate the title so its estimated width fits the canvas with a
 * small margin, never exceeding MAX_HOOK_CHARS.
 */
export function truncateHookTitle(
	title: string,
	fontSize: number,
	canvasWidth: number,
): string {
	const cleaned = title.replace(/\s+/g, " ").trim();
	const maxWidth = canvasWidth * 0.9;
	let out = cleaned;
	if (estimateHookWidth(out, fontSize) > maxWidth || out.length > MAX_HOOK_CHARS) {
		const byWidth = Math.max(1, Math.floor(maxWidth / (fontSize * 0.55)) - 1);
		const limit = Math.min(MAX_HOOK_CHARS, byWidth);
		out = out.slice(0, Math.max(1, limit)).trimEnd() + ELLIPSIS;
	}
	return out.toUpperCase();
}

/**
 * Build a hook text element placed in the upper third of the canvas.
 *
 * Position convention matches popover subtitles / text nodes:
 * transform.position is an OFFSET from the canvas center, so the
 * upper-third target (0.25 * height from the top) becomes a negative
 * offset of -(0.25 * canvasHeight).
 */
export function buildHookTextElement({
	title,
	startTime,
	duration = HOOK_TEXT_DEFAULT_DURATION,
	canvasHeight,
	canvasWidth,
}: {
	title: string;
	startTime: number;
	duration?: number;
	canvasHeight: number;
	canvasWidth: number;
}): Omit<CreateTextElement, "type"> & { type: "text" } {
	const clampedDuration = Math.min(
		HOOK_TEXT_MAX_DURATION,
		Math.max(HOOK_TEXT_MIN_DURATION, duration),
	);
	// Same size class as the "Overlay" question-card template so the
	// hook reads large without overwhelming vertical frames.
	const fontSize = 11;
	const content = truncateHookTitle(title, fontSize, canvasWidth);

	return {
		...DEFAULT_TEXT_ELEMENT,
		type: "text",
		name: `Hook: ${content.slice(0, 30)}`,
		content,
		fontSize,
		fontFamily: "Inter",
		fontWeight: "bold",
		color: "#FFFFFF",
		textAlign: "center",
		startTime,
		duration: clampedDuration,
		trimStart: 0,
		trimEnd: 0,
		background: {
			enabled: true,
			color: "#000000",
			cornerRadius: 8,
			paddingX: 28,
			paddingY: 14,
			offsetX: 0,
			offsetY: 0,
		},
		opacity: 1,
		transform: {
			scale: 1,
			position: { x: 0, y: -canvasHeight * 0.25 },
			rotate: 0,
		},
	};
}
