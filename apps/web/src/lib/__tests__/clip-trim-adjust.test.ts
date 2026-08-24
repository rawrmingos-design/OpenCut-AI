import { describe, expect, it } from "bun:test";

import {
	adjustClipBound,
	buildTranscriptSlice,
	computeTrimBounds,
	KEYBOARD_NUDGE_SECONDS,
	MAX_CLIP_DURATION,
	MIN_CLIP_DURATION,
	nudgeClipBound,
	TRIM_PAD_SECONDS,
} from "@/lib/clip-trim-adjust";
import { formatDurationBadge } from "@/components/editor/panels/assets/views/clips-gallery";

const clip = { start: 60, end: 90 };

describe("computeTrimBounds", () => {
	it("pads ±5s around the clip bounds", () => {
		expect(computeTrimBounds({ clip, mediaTotalDuration: null })).toEqual({
			min: 55,
			max: 95,
		});
	});

	it("clamps the window to the media duration", () => {
		expect(computeTrimBounds({ clip, mediaTotalDuration: 92 })).toEqual({
			min: 55,
			max: 92,
		});
		expect(
			computeTrimBounds({
				clip: { start: 2, end: 10 },
				mediaTotalDuration: 600,
			}),
		).toEqual({ min: 0, max: 15 });
	});
});

describe("adjustClipBound (duration clamps mirror FindClipsRequest)", () => {
	const bounds = { min: 55, max: 95 };

	it("keeps duration >= MIN_CLIP_DURATION when dragging start right", () => {
		const next = adjustClipBound({ clip, bounds, edge: "start", value: 80 });
		expect(next.end).toBe(90);
		expect(next.start).toBeCloseTo(90 - MIN_CLIP_DURATION, 5);
	});

	it("keeps duration <= MAX_CLIP_DURATION when dragging start left", () => {
		// Window is only ±5s so this needs a wide synthetic window.
		const wide = { min: 0, max: 200 };
		const next = adjustClipBound({
			clip,
			bounds: wide,
			edge: "start",
			value: 0,
		});
		expect(next.start).toBeCloseTo(90 - MAX_CLIP_DURATION, 5);
	});

	it("keeps duration >= MIN_CLIP_DURATION when dragging end left", () => {
		const next = adjustClipBound({ clip, bounds, edge: "end", value: 62 });
		expect(next.start).toBe(60);
		expect(next.end).toBeCloseTo(60 + MIN_CLIP_DURATION, 5);
	});

	it("allows free movement inside the safe band", () => {
		const next = adjustClipBound({ clip, bounds, edge: "start", value: 70 });
		expect(next.start).toBe(70);
		expect(next.end).toBe(90);
	});

	it("respects the scrubber window over the duration band", () => {
		const next = adjustClipBound({
			clip,
			bounds,
			edge: "end",
			value: 120,
		});
		expect(next.end).toBeLessThanOrEqual(95);
	});
});

describe("nudgeClipBound (keyboard ±0.5s)", () => {
	it("nudges the end handle right by 0.5s", () => {
		const next = nudgeClipBound({
			clip,
			bounds: { min: 55, max: 95 },
			edge: "end",
			direction: 1,
		});
		expect(next.end).toBeCloseTo(clip.end + KEYBOARD_NUDGE_SECONDS, 5);
		expect(TRIM_PAD_SECONDS).toBe(5);
	});

	it("clamps at the minimum duration instead of crossing it", () => {
		const next = nudgeClipBound({
			clip: { start: 60, end: 75.2 },
			bounds: { min: 55, max: 80.2 },
			edge: "end",
			direction: -1,
		});
		expect(next.end).toBeGreaterThanOrEqual(60 + MIN_CLIP_DURATION);
	});
});

describe("buildTranscriptSlice", () => {
	const segments = [
		{ start: 50, end: 58, text: "before clip" },
		{ start: 60, end: 72, text: "inside one" },
		{ start: 74, end: 89, text: "inside two" },
		{ start: 91, end: 100, text: "after clip" },
	];

	it("joins only overlapping segments in order", () => {
		expect(buildTranscriptSlice(segments, 60, 90)).toBe(
			"inside one inside two",
		);
	});

	it("includes partial overlaps at the edges", () => {
		expect(buildTranscriptSlice(segments, 56, 61)).toContain("before clip");
	});

	it("returns an empty string with no overlap", () => {
		expect(buildTranscriptSlice(segments, 101, 110)).toBe("");
	});
});

describe("formatDurationBadge stays stable for scrubber labels", () => {
	it("formats seconds and minutes consistently", () => {
		expect(formatDurationBadge(45)).toBe("45s");
		expect(formatDurationBadge(75)).toBe("1:15 min");
	});
});
