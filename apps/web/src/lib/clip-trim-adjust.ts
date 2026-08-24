/**
 * SCRUM-76: pure math for the mini trim scrubber on gallery cards.
 * Mirrors the backend FindClipsRequest defaults (podcast.py) so card-level
 * adjustments respect the same duration contract the finder used.
 */

/** Scrubber window padding: how far beyond the clip bounds users may drag. */
export const TRIM_PAD_SECONDS = 5;

/** Backend default minimum clip duration (FindClipsRequest.min_duration). */
export const MIN_CLIP_DURATION = 15;

/** Backend default maximum clip duration (FindClipsRequest.max_duration). */
export const MAX_CLIP_DURATION = 90;

/** Keyboard nudge step (arrow keys), seconds. */
export const KEYBOARD_NUDGE_SECONDS = 0.5;

export interface TrimBounds {
	min: number;
	max: number;
}

export interface ClipRange {
	start: number;
	end: number;
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * Scrubber bounds for one clip: `[start - 5s, end + 5s]`, clamped to the
 * media duration when known.
 */
export function computeTrimBounds({
	clip,
	mediaTotalDuration,
}: {
	clip: ClipRange;
	mediaTotalDuration: number | null;
}): TrimBounds {
	const min = Math.max(0, round1(clip.start - TRIM_PAD_SECONDS));
	let max = round1(clip.end + TRIM_PAD_SECONDS);
	if (
		typeof mediaTotalDuration === "number" &&
		Number.isFinite(mediaTotalDuration) &&
		mediaTotalDuration > 0
	) {
		max = Math.min(max, round1(mediaTotalDuration));
	}
	return max > min ? { min, max } : { min, max: min };
}

/**
 * Clamp one edge to a new value honoring the scrubber window AND the
 * backend min/max duration rules. Returns the full adjusted range.
 */
export function adjustClipBound({
	clip,
	bounds,
	edge,
	value,
}: {
	clip: ClipRange;
	bounds: TrimBounds;
	edge: "start" | "end";
	value: number;
}): ClipRange {
	const v = round1(Math.min(bounds.max, Math.max(bounds.min, value)));
	if (edge === "start") {
		const lo = Math.min(
			Math.max(round1(clip.end - MAX_CLIP_DURATION), bounds.min),
			round1(clip.end - 0.1),
		);
		const hi = Math.max(
			Math.min(round1(clip.end - MIN_CLIP_DURATION), bounds.max),
			lo,
		);
		return { start: round1(Math.min(hi, Math.max(lo, v))), end: clip.end };
	}
	const hi = Math.max(
		Math.min(round1(clip.start + MAX_CLIP_DURATION), bounds.max),
		bounds.min,
	);
	const loRaw = Math.max(
		round1(clip.start + MIN_CLIP_DURATION),
		bounds.min,
	);
	const lo = Math.min(loRaw, hi);
	return { start: clip.start, end: round1(Math.min(hi, Math.max(lo, v))) };
}

/** Keyboard path: nudge one edge by ±KEYBOARD_NUDGE_SECONDS then clamp. */
export function nudgeClipBound({
	clip,
	bounds,
	edge,
	direction,
}: {
	clip: ClipRange;
	bounds: TrimBounds;
	edge: "start" | "end";
	direction: -1 | 1;
}): ClipRange {
	const base = edge === "start" ? clip.start : clip.end;
	return adjustClipBound({
		clip,
		bounds,
		edge,
		value: base + direction * KEYBOARD_NUDGE_SECONDS,
	});
}

/** Transcript text covering `[start, end]`, for re-scoring the adjusted clip. */
export function buildTranscriptSlice<T extends { start: number; end: number; text: string }>(
	segments: T[],
	start: number,
	end: number,
): string {
	return segments
		.filter((seg) => seg.end > start && seg.start < end)
		.map((seg) => seg.text.trim())
		.filter(Boolean)
		.join(" ");
}
