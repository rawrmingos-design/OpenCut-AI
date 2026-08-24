import type { TimelineTrack } from "@/types/timeline";

const EPSILON = 0.01;

type AnyElement = TimelineTrack["elements"][number];

/**
 * SCRUM-71: clone the given tracks restricted to the `[start, end]` window,
 * rebased so the window begins at t=0. Used for range-only exports — the
 * original timeline is never mutated (pure data transform, no commands).
 *
 * Rules per element:
 * - Fully outside the window → dropped.
 * - Fully inside → shifted by `-start`.
 * - Straddling the IN point → clipped at the window edge and its media
 *   `trimStart` advanced by the cut amount (scaled by playbackRate) so the
 *   correct source frames still play.
 * - Straddling the OUT point → duration shortened; no trim changes needed
 *   since playback simply ends earlier.
 */
export function rebaseTracksToTimeWindow({
	tracks,
	start,
	end,
}: {
	tracks: TimelineTrack[];
	start: number;
	end: number;
}): TimelineTrack[] {
	const out: TimelineTrack[] = [];

	for (const track of tracks) {
		const kept: AnyElement[] = [];

		for (const raw of track.elements) {
			const element = raw as AnyElement & {
				type?: string;
				playbackRate?: number;
				trimStart?: number;
			};
			const elementStart = element.startTime ?? 0;
			const elementEnd = elementStart + (element.duration ?? 0);

			if (
				elementEnd <= start + EPSILON ||
				elementStart >= end - EPSILON
			) {
				continue;
			}

			const headCut = Math.max(0, start - elementStart);
			const newStart = Math.max(0, elementStart - start);
			const newEnd = Math.min(elementEnd, end) - start;
			const duration = newEnd - newStart;
			if (duration <= EPSILON) continue;

			const next = {
				...element,
				startTime: newStart,
				duration,
			};

			if (
				headCut > 0 &&
				(element.type === "video" || element.type === "audio") &&
				typeof element.trimStart === "number"
			) {
				next.trimStart =
					element.trimStart + headCut * (element.playbackRate ?? 1);
			}

			kept.push(next as AnyElement);
		}

		out.push({ ...track, elements: kept } as TimelineTrack);
	}

	return out;
}

/** Clamp + validate a requested export window against the timeline duration. */
export function resolveExportRange({
	start,
	end,
	duration,
	fps,
}: {
	start: number;
	end: number;
	duration: number;
	fps: number;
}): { start: number; end: number } | null {
	const minSpan = fps > 0 ? 1 / fps : 0.05;
	const s = Math.max(0, Math.min(start, duration));
	const e = Math.max(0, Math.min(end, duration));
	if (e - s < minSpan) return null;
	return { start: s, end: e };
}
