import { describe, expect, it } from "bun:test";

import {
	buildBatchOverlayTracks,
	rebaseReframeKeyframesForClip,
} from "@/lib/podcast/batch-overlays";
import { buildBatchOverlayMetadata } from "@/lib/batch-export";
import type { BatchOverlayMetadata } from "@/types/export";

// ── helpers ─────────────────────────────────────────────────────────────────

const CANVAS_9_16 = { canvasWidth: 1080, canvasHeight: 1920 };

function makeSegment(
	start: number,
	end: number,
	text = "hello world",
): BatchOverlayMetadata["segments"][0] {
	const mid = (start + end) / 2;
	return {
		text,
		start,
		end,
		words: [
			{ word: "hello", start, end: mid, confidence: 0.9 },
			{ word: "world", start: mid, end, confidence: 0.9 },
		],
	};
}

function baseMeta(overrides?: Partial<BatchOverlayMetadata>): BatchOverlayMetadata {
	return {
		segments: [makeSegment(10, 40)],
		clipStart: 10,
		clipDuration: 30,
		hookTitle: "Amazing Hook",
		subtitlePreset: "hormozi",
		...CANVAS_9_16,
		...overrides,
	};
}

describe("buildBatchOverlayMetadata", () => {
	it("slices source transcript to one clip and keys reframe by media id", () => {
		const metadata = buildBatchOverlayMetadata({
			clip: { title: "Clip A", start: 10, end: 20 },
			segments: [
				{ id: 1, text: "before", start: 0, end: 8, words: [] },
				{ id: 2, text: "inside", start: 9, end: 21, words: [] },
				{ id: 3, text: "after", start: 22, end: 30, words: [] },
			],
			subtitlePreset: "hormozi",
			hookTitle: "CLIP A",
			canvasWidth: 1080,
			canvasHeight: 1920,
			mediaId: "media-a",
			clipReframe: {
				positionX: [{ id: "x", time: 0, value: 12, interpolation: "linear" }],
				positionY: [{ id: "y", time: 0, value: 0, interpolation: "linear" }],
				scale: [{ id: "s", time: 0, value: 1.77, interpolation: "linear" }],
			},
		});

		expect(metadata.clipStart).toBe(10);
		expect(metadata.clipDuration).toBe(10);
		expect(metadata.segments.map((segment) => segment.text)).toEqual(["inside"]);
		expect(metadata.segments[0].start).toBe(10);
		expect(metadata.segments[0].end).toBe(20);
		expect(metadata.videoReframeAnimations?.["media-a"]?.positionX[0].value).toBe(12);
		expect(metadata.videoReframeAnimations?.["media-b"]).toBeUndefined();
	});

	it("does not create a reframe map when face analysis is unavailable", () => {
		const metadata = buildBatchOverlayMetadata({
			clip: { title: "No face", start: 0, end: 5 },
			segments: [],
			subtitlePreset: "classic-podcast",
			hookTitle: "",
			canvasWidth: 1080,
			canvasHeight: 1920,
		});
		expect(metadata.videoReframeAnimations).toBeUndefined();
	});

	it("keeps boundary-straddling words clamped inside the clip window", () => {
		const metadata = buildBatchOverlayMetadata({
			clip: { title: "Clip B", start: 10, end: 20 },
			segments: [
				{
					id: 1,
					text: "edge word",
					start: 8,
					end: 12,
					words: [
						// fully before the clip → dropped
						{ word: "gone", start: 8.2, end: 9.6, confidence: 0.9 },
						// straddles clip start → kept and clamped to [10, 11.5]
						{ word: "edge", start: 9, end: 11.5, confidence: 0.95 },
					],
				},
			],
			subtitlePreset: "hormozi",
			hookTitle: "",
			canvasWidth: 1080,
			canvasHeight: 1920,
		});
		const seg = metadata.segments[0];
		expect(seg.words.map((w) => w.word)).toEqual(["edge"]);
		expect(seg.words[0].start).toBe(10);
		expect(seg.words[0].end).toBe(11.5);
	});
});

// ── buildBatchOverlayTracks ──────────────────────────────────────────────────

describe("buildBatchOverlayTracks", () => {
	it("returns at least one subtitle track when segments are provided", () => {
		const tracks = buildBatchOverlayTracks(baseMeta());
		const subsTracks = tracks.filter((t) => t.name.startsWith("Popover Subs"));
		expect(subsTracks.length).toBeGreaterThan(0);
	});

	it("includes a Hook Text track when hookTitle is non-empty", () => {
		const tracks = buildBatchOverlayTracks(baseMeta());
		const hookTrack = tracks.find((t) => t.name === "Hook Text");
		expect(hookTrack).toBeDefined();
		expect(hookTrack!.type).toBe("text");
	});

	it("does NOT include a Hook Text track when hookTitle is empty", () => {
		const tracks = buildBatchOverlayTracks(baseMeta({ hookTitle: "" }));
		const hookTrack = tracks.find((t) => t.name === "Hook Text");
		expect(hookTrack).toBeUndefined();
	});

	it("returns no subtitle tracks when segments array is empty", () => {
		const tracks = buildBatchOverlayTracks(
			baseMeta({ segments: [] }),
		);
		const subsTracks = tracks.filter((t) => t.name.startsWith("Popover Subs"));
		expect(subsTracks.length).toBe(0);
	});

	it("rebases subtitle element startTimes to clip-local time (t=0 origin)", () => {
		// clip runs [10,40]; subtitle word starts at t=10 → should appear at t=0
		const tracks = buildBatchOverlayTracks(baseMeta());
		const subsTracks = tracks.filter((t) => t.name.startsWith("Popover Subs"));
		for (const track of subsTracks) {
			for (const el of track.elements) {
				expect(el.startTime).toBeGreaterThanOrEqual(0);
				expect(el.startTime).toBeLessThan(30); // within clip duration
			}
		}
	});

	it("hook element startTime is 0 (appears at start of clip)", () => {
		const tracks = buildBatchOverlayTracks(baseMeta());
		const hook = tracks.find((t) => t.name === "Hook Text");
		expect(hook!.elements[0].startTime).toBe(0);
	});

	it("hook duration is clamped to max 25% of clip duration", () => {
		// clipDuration = 8s → max hook = 2s (8 * 0.25)
		const tracks = buildBatchOverlayTracks(baseMeta({
			clipDuration: 8,
			segments: [makeSegment(10, 18)],
		}));
		const hook = tracks.find((t) => t.name === "Hook Text");
		expect(hook!.elements[0].duration).toBeLessThanOrEqual(2);
	});

	it("words from outside the clip window are excluded", () => {
		// segment spans [5, 45] but clip is [10, 40]
		// word [5,10) is before clip start → should be dropped
		const segWithLeadingWord: BatchOverlayMetadata["segments"][0] = {
			text: "before hello world",
			start: 5,
			end: 45,
			words: [
				{ word: "before", start: 5, end: 9.9, confidence: 0.9 }, // outside
				{ word: "hello", start: 10, end: 25, confidence: 0.9 },   // inside
				{ word: "world", start: 25, end: 40, confidence: 0.9 },  // inside
			],
		};
		const tracks = buildBatchOverlayTracks(
			baseMeta({ segments: [segWithLeadingWord] }),
		);
		const subsTracks = tracks.filter((t) => t.name.startsWith("Popover Subs"));
		for (const track of subsTracks) {
			for (const el of track.elements) {
				// No element should have a negative startTime (pre-clip word leaked)
				expect(el.startTime).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it("all returned tracks have unique string IDs", () => {
		const tracks = buildBatchOverlayTracks(baseMeta());
		const ids = tracks.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("project-state isolation: two calls with different clipStarts produce independent tracks", () => {
		const tracks1 = buildBatchOverlayTracks(
			baseMeta({ clipStart: 0, clipDuration: 30 }),
		);
		const tracks2 = buildBatchOverlayTracks(
			baseMeta({ clipStart: 100, clipDuration: 30, segments: [makeSegment(100, 130)] }),
		);
		// IDs must be different (no shared mutable references)
		const ids1 = new Set(tracks1.map((t) => t.id));
		const ids2 = new Set(tracks2.map((t) => t.id));
		for (const id of ids2) {
			expect(ids1.has(id)).toBe(false);
		}
		// Each batch's element startTimes must be in clip-local range
		for (const track of tracks2) {
			for (const el of track.elements) {
				expect(el.startTime).toBeGreaterThanOrEqual(0);
				expect(el.startTime).toBeLessThan(30);
			}
		}
	});
});

// ── rebaseReframeKeyframesForClip ────────────────────────────────────────────

describe("rebaseReframeKeyframesForClip", () => {
	const rawKf = {
		positionX: [
			{ id: "rx-0", time: 5, value: -100, interpolation: "linear" as const },
			{ id: "rx-1", time: 15, value: 50, interpolation: "linear" as const },
			{ id: "rx-2", time: 35, value: 80, interpolation: "linear" as const },
		],
		positionY: [
			{ id: "ry-0", time: 5, value: 20, interpolation: "linear" as const },
			{ id: "ry-1", time: 20, value: -30, interpolation: "linear" as const },
		],
		scale: [
			{ id: "rs-0", time: 0, value: 1.77, interpolation: "linear" as const },
		],
	};

	it("drops keyframes before clip window and rebases survivors to t=0", () => {
		// clip=[10,40], clipDuration=30
		const result = rebaseReframeKeyframesForClip(rawKf, 10, 30);
		// rx-0 at t=5 is before clipStart=10 → clamped boundary at t=0
		// (holds its value so the crop is continuous at the cut)
		// rx-1 at t=15 → rebased to 5; rx-2 at t=35 → rebased to 25
		expect(result.positionX.length).toBe(3);
		expect(result.positionX[0].time).toBe(0);
		expect(result.positionX[0].value).toBeCloseTo(-100);
		expect(result.positionX[1].time).toBeCloseTo(5);
		expect(result.positionX[2].time).toBeCloseTo(25);
	});

	it("returns fallback center keyframe when no keyframes fall in clip window", () => {
		// Keyframes live at t∈{5,15,20,35}; clip=[50,60] contains none.
		// The last prior keyframe (t=35) becomes the clamped t=0 boundary.
		const result = rebaseReframeKeyframesForClip(rawKf, 50, 10);
		expect(result.positionX.length).toBe(1);
		expect(result.positionX[0].time).toBe(0);
		// value holds the last known position before the clip
		expect(result.positionX[0].value).toBeCloseTo(80);
	});

	it("uses first scale keyframe as fallback when channel has no keyframes", () => {
		const emptyScale = { ...rawKf, scale: [] };
		const result = rebaseReframeKeyframesForClip(emptyScale, 50, 30);
		// No scale kfs anywhere → deterministic neutral scale fallback.
		expect(result.scale.length).toBe(1);
		expect(result.scale[0].value).toBe(1);
	});

	it("rebased keyframe times stay within [0, clipDuration]", () => {
		const result = rebaseReframeKeyframesForClip(rawKf, 10, 30);
		for (const kf of [
			...result.positionX,
			...result.positionY,
			...result.scale,
		]) {
			expect(kf.time).toBeGreaterThanOrEqual(0);
			expect(kf.time).toBeLessThanOrEqual(30);
		}
	});
});
