import { describe, expect, it } from "bun:test";

import {
	HOOK_TEXT_DEFAULT_DURATION,
	HOOK_TEXT_MAX_DURATION,
	buildHookTextElement,
	truncateHookTitle,
} from "@/lib/podcast/hook-text";

describe("truncateHookTitle", () => {
	it("uppercases and preserves short titles", () => {
		expect(truncateHookTitle("best reveal ever", 11, 1080)).toBe(
			"BEST REVEAL EVER",
		);
	});

	it("collapses whitespace", () => {
		expect(truncateHookTitle("  a   b\tc ", 11, 1080)).toBe("A B C");
	});

	it("truncates long titles with an ellipsis", () => {
		const out = truncateHookTitle("word ".repeat(40), 11, 1080);
		expect(out.endsWith("…")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(61);
	});
});

describe("buildHookTextElement", () => {
	it("produces a bold centered text element with background pill", () => {
		const el = buildHookTextElement({
			title: "The secret nobody tells you",
			startTime: 0,
			canvasWidth: 1080,
			canvasHeight: 1920,
		});
		expect(el.type).toBe("text");
		expect(el.content).toBe("THE SECRET NOBODY TELLS YOU");
		expect(el.fontWeight).toBe("bold");
		expect(el.textAlign).toBe("center");
		expect(el.background.enabled).toBe(true);
		expect(el.duration).toBe(HOOK_TEXT_DEFAULT_DURATION);
		expect(el.startTime).toBe(0);
	});

	it("places the hook in the upper third (offset above canvas center)", () => {
		const el = buildHookTextElement({
			title: "Hook",
			startTime: 0.5,
			canvasWidth: 1080,
			canvasHeight: 1920,
		});
		expect(el.transform.position.x).toBe(0);
		expect(el.transform.position.y).toBeCloseTo(-480, 5); // -0.25 * 1920
	});

	it("scales placement with canvas size", () => {
		const el = buildHookTextElement({
			title: "Hook",
			startTime: 0,
			canvasWidth: 720,
			canvasHeight: 1280,
		});
		expect(el.transform.position.y).toBeCloseTo(-320, 5); // -0.25 * 1280
	});

	it("clamps duration to [1, HOOK_TEXT_MAX_DURATION] seconds", () => {
		const tooShort = buildHookTextElement({
			title: "Hook",
			startTime: 0,
			duration: 0.2,
			canvasWidth: 1080,
			canvasHeight: 1920,
		});
		const tooLong = buildHookTextElement({
			title: "Hook",
			startTime: 0,
			duration: 30,
			canvasWidth: 1080,
			canvasHeight: 1920,
		});
		expect(tooShort.duration).toBe(1);
		expect(tooLong.duration).toBe(HOOK_TEXT_MAX_DURATION);
	});
});
