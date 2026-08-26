import { describe, expect, it } from "bun:test";
import {
	buildReframeTimelineUpdate,
	computeReframeKeyframes,
	getDefaultReframeOptions,
	REFRAME_PRESETS,
} from "@/lib/reframe/reframe-types";
import type { FaceDetectionResult } from "@/types/ai";

// ── helpers ────────────────────────────────────────────────────────────────

function emptyDetection(vw = 1920, vh = 1080): FaceDetectionResult {
	return {
		frames: [],
		video_width: vw,
		video_height: vh,
		duration: 10,
		total_faces_detected: 0,
	};
}

function detectionWithFace(
	cx: number,
	cy: number,
	vw = 1920,
	vh = 1080,
): FaceDetectionResult {
	// cx/cy are normalized face center; the bbox is built around them.
	const w = 0.1;
	const h = 0.15;
	return {
		frames: [
			{
				timestamp: 0,
				faces: [
					{
						x: cx - w / 2,
						y: cy - h / 2,
						width: w,
						height: h,
						confidence: 0.9,
					},
				],
			},
			{
				timestamp: 2,
				faces: [
					{
						x: cx - w / 2,
						y: cy - h / 2,
						width: w,
						height: h,
						confidence: 0.9,
					},
				],
			},
		],
		video_width: vw,
		video_height: vh,
		duration: 10,
		total_faces_detected: 2,
	};
}

// ── SCRUM-79: computeReframeKeyframes unit tests ───────────────────────────

describe("computeReframeKeyframes", () => {
	it("returns identity (single scale=1 keyframe) when source and target aspects match", () => {
		// Same aspect: 1920×1080 source → 1920×1080 target (both 16:9)
		const detection = emptyDetection(1920, 1080);
		const opts = { ...getDefaultReframeOptions(), targetWidth: 1920, targetHeight: 1080 };
		const kf = computeReframeKeyframes(detection, opts);
		// No crop needed: identity keyframes
		expect(kf.positionX.length).toBe(1);
		expect(kf.positionX[0].value).toBe(0);
		expect(kf.positionY.length).toBe(1);
		expect(kf.positionY[0].value).toBe(0);
		expect(kf.scale.length).toBe(1);
		expect(kf.scale[0].value).toBe(1);
	});

	it("returns empty arrays when video dimensions are zero (degenerate input)", () => {
		const detection = emptyDetection(0, 0);
		const opts = getDefaultReframeOptions();
		const kf = computeReframeKeyframes(detection, opts);
		expect(kf.positionX.length).toBe(0);
		expect(kf.positionY.length).toBe(0);
		expect(kf.scale.length).toBe(0);
	});

	it("returns identity keyframes when no faces detected in landscape→portrait reframe", () => {
		// No faces: crop needed but we can only center — returns identity position
		const detection = emptyDetection(1920, 1080);
		const tiktok = REFRAME_PRESETS.find((p) => p.id === "tiktok")!;
		const opts = {
			...getDefaultReframeOptions(),
			targetWidth: tiktok.width,
			targetHeight: tiktok.height,
		};
		const kf = computeReframeKeyframes(detection, opts);
		expect(kf.positionX.length).toBe(1);
		expect(kf.positionX[0].value).toBe(0);
		// Scale must be > 1 to fill vertical frame from landscape source
		expect(kf.scale.length).toBe(1);
		expect(kf.scale[0].value).toBeGreaterThan(1);
	});

	it("generates non-zero X offset when face is off-center in a 9:16 reframe", () => {
		// Face at normalized center (0.75, 0.5) — right of center → expect negative X offset
		const detection = detectionWithFace(0.75, 0.5);
		const opts = {
			...getDefaultReframeOptions(),
			targetWidth: 1080,
			targetHeight: 1920,
			smoothingWindow: 0, // disable smoothing so we get raw values
		};
		const kf = computeReframeKeyframes(detection, opts);
		// Face to the right → position X should be non-zero (shift to track subject)
		expect(kf.positionX.length).toBeGreaterThan(0);
		// Left-center face should produce a positive shift; right-center a negative one
		const rightOfCenter = kf.positionX.some((k) => k.value !== 0);
		expect(rightOfCenter).toBe(true);
	});

	it("scale keyframe is always > 0 for any valid aspect change", () => {
		// 16:9 → 9:16 should require scale > 1 (fill the vertical gap)
		const detection = emptyDetection(1920, 1080);
		const opts = { ...getDefaultReframeOptions(), targetWidth: 1080, targetHeight: 1920 };
		const kf = computeReframeKeyframes(detection, opts);
		for (const s of kf.scale) {
			expect(s.value).toBeGreaterThan(0);
		}
	});

	it("face with confidence below minConfidence is ignored", () => {
		const detection: FaceDetectionResult = {
			frames: [
				{
					timestamp: 0,
					faces: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.15, confidence: 0.3 }],
				},
			],
			video_width: 1920,
			video_height: 1080,
			duration: 10,
			total_faces_detected: 1,
		};
		const opts = {
			...getDefaultReframeOptions(),
			targetWidth: 1080,
			targetHeight: 1920,
			minConfidence: 0.5, // face confidence 0.3 < threshold → ignored
		};
		const kf = computeReframeKeyframes(detection, opts);
		// Low-confidence face treated as no face: identity position
		expect(kf.positionX[0].value).toBe(0);
		expect(kf.positionY[0].value).toBe(0);
	});

	it("positionX keyframe IDs are unique", () => {
		const detection = detectionWithFace(0.3, 0.5);
		const opts = { ...getDefaultReframeOptions(), targetWidth: 1080, targetHeight: 1920 };
		const kf = computeReframeKeyframes(detection, opts);
		const ids = kf.positionX.map((k) => k.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(ids.length);
	});

	it("REFRAME_PRESETS contains tiktok preset with 9:16 ratio", () => {
		const tiktok = REFRAME_PRESETS.find((p) => p.id === "tiktok");
		expect(tiktok).toBeDefined();
		expect(tiktok!.width).toBe(1080);
		expect(tiktok!.height).toBe(1920);
		expect(tiktok!.aspectRatio).toBe("9:16");
	});
});

describe("buildReframeTimelineUpdate", () => {
	const keyframes = computeReframeKeyframes(
		detectionWithFace(0.75, 0.5),
		{ ...getDefaultReframeOptions(), targetWidth: 1080, targetHeight: 1920 },
	);

	it("returns an update for only the selected video element", () => {
		const tracks = [
			{
				id: "track-a",
				name: "A",
				type: "video",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [
					{ id: "video-a", type: "video", mediaId: "media-a", animations: { channels: {} } },
					{ id: "video-b", type: "video", mediaId: "media-b", animations: { channels: {} } },
				],
			},
		] as never;

		const update = buildReframeTimelineUpdate({
			tracks,
			target: { trackId: "track-a", elementId: "video-b" },
			keyframes,
		});

		expect(update?.trackId).toBe("track-a");
		expect(update?.elementId).toBe("video-b");
		expect(update?.updates.animations.channels["transform.position.x"]).toBeDefined();
		expect(update?.updates.animations.channels["transform.position.y"]).toBeDefined();
		expect(update?.updates.animations.channels["transform.scale"]).toBeDefined();
	});

	it("does not create an update when the target is not a video", () => {
		const tracks = [
			{
				id: "track-a",
				name: "A",
				type: "video",
				isMain: true,
				muted: false,
				hidden: false,
				elements: [{ id: "image-a", type: "image", mediaId: "media-a" }],
			},
		] as never;

		expect(
			buildReframeTimelineUpdate({
				tracks,
				target: { trackId: "track-a", elementId: "image-a" },
				keyframes,
			}),
		).toBeNull();
	});
});
