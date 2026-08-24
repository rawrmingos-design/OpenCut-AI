import { describe, expect, it } from "bun:test";

import {
	buildExportFilename,
} from "@/hooks/use-export-queue-worker";
import {
	rebaseTracksToTimeWindow,
	resolveExportRange,
} from "@/lib/timeline-window";
import type { TimelineTrack } from "@/types/timeline";

function makeVideoElement(
	id: string,
	startTime: number,
	duration: number,
	trimStart = 0,
): any {
	return {
		id,
		type: "video",
		name: id,
		mediaId: `media-${id}`,
		startTime,
		duration,
		trimStart,
		trimEnd: 0,
	};
}

function makeTextElement(id: string, startTime: number, duration: number): any {
	return { id, type: "text", name: id, startTime, duration, trimStart: 0, trimEnd: 0 };
}

function makeVideoTrack(elements: any[]): TimelineTrack {
	return {
		id: "v1",
		type: "video",
		name: "V1",
		isMain: true,
		muted: false,
		hidden: false,
		elements,
	} as TimelineTrack;
}

function makeTextTrack(elements: any[]): TimelineTrack {
	return {
		id: "t1",
		type: "text",
		name: "T1",
		hidden: false,
		elements,
	} as TimelineTrack;
}

describe("rebaseTracksToTimeWindow", () => {
	it("drops elements fully outside the window", () => {
		const tracks = [
			makeVideoTrack([
				makeVideoElement("a", 0, 4),
				makeVideoElement("b", 10, 5),
				makeVideoElement("c", 40, 5),
			]),
		];

		const out = rebaseTracksToTimeWindow({ tracks, start: 8, end: 20 });

		expect(out[0].elements.map((e: any) => e.id)).toEqual(["b"]);
		expect(out[0].elements[0].startTime).toBeCloseTo(2, 1);
		expect(out[0].elements[0].duration).toBeCloseTo(5, 1);
	});

	it("clips an element straddling the IN point and advances trimStart", () => {
		const tracks = [makeVideoTrack([makeVideoElement("long", 0, 30, 5)])];

		const out = rebaseTracksToTimeWindow({ tracks, start: 12, end: 20 });
		const el: any = out[0].elements[0];

		expect(el.startTime).toBe(0);
		expect(el.duration).toBeCloseTo(8, 1);
		expect(el.trimStart).toBeCloseTo(17, 1);
	});

	it("clips an element straddling the OUT point without touching trimStart", () => {
		const tracks = [makeVideoTrack([makeVideoElement("long", 15, 30, 3)])];

		const out = rebaseTracksToTimeWindow({ tracks, start: 10, end: 25 });
		const el: any = out[0].elements[0];

		expect(el.startTime).toBe(5);
		expect(el.duration).toBeCloseTo(10, 1);
		expect(el.trimStart).toBe(3);
	});

	it("advances trimStart scaled by playbackRate", () => {
		const tracks = [
			makeVideoTrack([{ ...makeVideoElement("fast", 0, 20), playbackRate: 2 }]),
		];

		const out = rebaseTracksToTimeWindow({ tracks, start: 6, end: 10 });
		const el: any = out[0].elements[0];
		expect(el.trimStart).toBeCloseTo(12, 1);
	});

	it("rebases overlay tracks while keeping internal gaps", () => {
		const tracks = [
			makeVideoTrack([makeVideoElement("vid", 0, 60)]),
			makeTextTrack([
				makeTextElement("sub-a", 12, 2),
				makeTextElement("sub-b", 20, 2),
			]),
		];

		const out = rebaseTracksToTimeWindow({ tracks, start: 10, end: 30 });
		const subs = out[1].elements;

		expect(subs.map((e: any) => e.id)).toEqual(["sub-a", "sub-b"]);
		expect((subs[0] as any).startTime).toBeCloseTo(2, 1);
		expect((subs[1] as any).startTime).toBeCloseTo(10, 1);
	});
});

describe("resolveExportRange", () => {
	it("clamps to duration and enforces minimum span", () => {
		const r = resolveExportRange({
			start: -5,
			end: 9999,
			duration: 30,
			fps: 30,
		});
		expect(r).toEqual({ start: 0, end: 30 });
	});

	it("returns null for inverted ranges", () => {
		expect(
			resolveExportRange({ start: 20, end: 10, duration: 30, fps: 30 }),
		).toBeNull();
	});
});

describe("buildExportFilename", () => {
	it("returns plain name for full exports", () => {
		expect(
			buildExportFilename({
				projectName: "My Pod",
				options: { format: "mp4" },
			}),
		).toBe("My Pod.mp4");
	});

	it("embeds the window for ranged exports", () => {
		expect(
			buildExportFilename({
				projectName: "My Pod",
				options: { format: "mp4", start: 12, end: 45 },
			}),
		).toBe("My Pod_clip_00-12_to_00-45.mp4");
	});
});
