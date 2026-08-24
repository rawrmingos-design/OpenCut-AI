import { describe, expect, it } from "bun:test";

import {
	trimTimelineToRange,
	type TimelineEditor,
} from "../timeline-edits";
import type { TimelineElement, TimelineTrack } from "@/types/timeline";

/** Loose element shape for the in-memory double (avoids union friction). */
interface WEl {
	id: string;
	startTime: number;
	duration: number;
}

interface WTrack {
	id: string;
	type?: string;
	elements: WEl[];
}

function makeElement(
	id: string,
	startTime: number,
	duration: number,
): WEl {
	return { id, startTime, duration };
}

/**
 * In-memory TimelineEditor double that mimics the manager methods used by
 * timeline-edits helpers: split replaces an element with two halves,
 * delete removes ids, update patches properties.
 */
function makeEditor(tracks: WTrack[]): TimelineEditor {
	const state = { tracks };

	const findAt = (time: number) => {
		const found: { trackId: string; elementId: string }[] = [];
		for (const track of state.tracks) {
			for (const el of track.elements) {
				if (el.startTime < time && el.startTime + el.duration > time) {
					found.push({ trackId: track.id, elementId: el.id });
				}
			}
		}
		return found;
	};

	const ref = (
		trackId: string,
		elementId: string,
	): { track?: WTrack; element?: WEl } => {
		const track = state.tracks.find((t) => t.id === trackId);
		return {
			track,
			element: track?.elements.find((e) => e.id === elementId),
		};
	};

	return {
		timeline: {
			getTracks: () => state.tracks as unknown as TimelineTrack[],
			splitElements({
				elements,
				splitTime,
			}: {
				elements: { trackId: string; elementId: string }[];
				splitTime: number;
			}) {
				for (const { trackId, elementId } of findAt(splitTime)) {
					if (
						!elements.some(
							(e) => e.trackId === trackId && e.elementId === elementId,
						)
					) {
						continue;
					}
					const { track, element } = ref(trackId, elementId);
					if (!track || !element) continue;
					const leftDur = splitTime - element.startTime;
					if (leftDur <= 0.01 || element.duration - leftDur <= 0.01) continue;
					const right: WEl = {
						id: `${element.id}-r`,
						startTime: splitTime,
						duration: element.duration - leftDur,
					};
					element.duration = leftDur;
					track.elements.push(right);
				}
			},
			deleteElements({
				elements,
			}: {
				elements: { trackId: string; elementId: string }[];
			}) {
				const kill = new Set(
					elements.map((e) => `${e.trackId}:${e.elementId}`),
				);
				for (const track of state.tracks) {
					track.elements = track.elements.filter(
						(el) => !kill.has(`${track.id}:${el.id}`),
					);
				}
			},
			updateElements({
				updates,
			}: {
				updates: {
					trackId: string;
					elementId: string;
					updates: Partial<TimelineElement>;
				}[];
			}) {
				for (const u of updates) {
					const { element } = ref(u.trackId, u.elementId);
					if (element) Object.assign(element, u.updates);
				}
			},
		},
	} as unknown as TimelineEditor;
}

describe("trimTimelineToRange", () => {
	it("keeps only content inside the range and compacts it to zero", () => {
		const video: WTrack = { id: "v1", type: "video", elements: [makeElement("vid", 0, 30)] };
		const text: WTrack = {
			id: "t1",
			type: "text",
			elements: [
				makeElement("sub-in", 5, 3),
				makeElement("sub-keep", 12, 6),
				makeElement("sub-out", 25, 4),
			],
		};
		const editor = makeEditor([video, text]);

		trimTimelineToRange(editor, { start: 10, end: 20 });

		const vEls = video.elements;
		const tEls = text.elements;

		expect(vEls.length).toBe(1);
		expect(vEls[0].startTime).toBe(0);
		expect(vEls[0].duration).toBeCloseTo(10, 1);

		expect(tEls.map((e) => e.id)).toEqual(["sub-keep"]);
		expect(tEls[0].startTime).toBeCloseTo(2, 1);
	});

	it("preserves internal gaps on text tracks while rebasing to zero", () => {
		const video: WTrack = { id: "v1", type: "video", elements: [makeElement("vid", 0, 30)] };
		const text: WTrack = {
			id: "t1",
			type: "text",
			elements: [
				makeElement("sub-a", 11, 2),
				makeElement("sub-b", 16, 2),
			],
		};
		const editor = makeEditor([video, text]);

		trimTimelineToRange(editor, { start: 10, end: 20 });

		expect(text.elements.map((e) => e.id)).toEqual(["sub-a", "sub-b"]);
		expect(text.elements[0].startTime).toBeCloseTo(1, 1);
		expect(text.elements[1].startTime).toBeCloseTo(6, 1);
	});

	it("splits elements straddling both boundaries", () => {
		const video: WTrack = { id: "v1", elements: [makeElement("vid", 0, 30)] };
		const audio: WTrack = { id: "a1", elements: [makeElement("aud", 8, 8)] };
		const editor = makeEditor([video, audio]);

		trimTimelineToRange(editor, { start: 10, end: 16 });

		expect(video.elements.length).toBe(1);
		expect(video.elements[0].duration).toBeCloseTo(6, 1);

		expect(audio.elements.length).toBe(1);
		expect(audio.elements[0].startTime).toBe(0);
		expect(audio.elements[0].duration).toBeCloseTo(6, 1);
	});

	it("no-ops when the range is empty or inverted", () => {
		const video: WTrack = { id: "v1", elements: [makeElement("vid", 0, 30)] };
		const editor = makeEditor([video]);

		trimTimelineToRange(editor, { start: 15, end: 15 });

		expect(video.elements[0].id).toBe("vid");
		expect(video.elements[0].duration).toBe(30);
	});
});
