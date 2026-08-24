import { describe, expect, it } from "bun:test";

import {
	BATCH_EXPORT_DEFAULTS,
	buildBatchExportJobs,
	queueBatchExportJobs,
	slugifyTopic,
} from "@/lib/batch-export";
import { resolveAspectCanvas } from "@/lib/aspect";

describe("slugifyTopic", () => {
	it("produces safe lowercase slugs", () => {
		expect(slugifyTopic("Best Moment: The Reveal!")).toBe(
			"best-moment-the-reveal",
		);
		expect(slugifyTopic("  Élan & Vital  ")).toBe("elan-vital");
		expect(slugifyTopic("???")).toBe("clip");
		expect(slugifyTopic("x".repeat(100)).length).toBeLessThanOrEqual(40);
	});
});

describe("buildBatchExportJobs", () => {
	const clips = [
		{ title: "Hook kuat banget", start: 10, end: 40, score: 85, reason: "r", tags: [] },
		{ title: "Cerita lucu", start: 120, end: 150, score: 62, reason: "r", tags: [] },
		{ title: "Lemah", start: 300, end: 320, score: 41, reason: "r", tags: [] },
	];

	it("creates one ranged, auto-named job per clip", () => {
		const plans = buildBatchExportJobs({ projectName: "My Pod", clips });
		expect(plans.length).toBe(3);
		expect(plans[0].projectName).toBe("My Pod-1-hook-kuat-banget");
		expect(plans[1].options.start).toBe(120);
		expect(plans[2].options.end).toBe(320);
		expect(plans[0].options.format).toBe("mp4");
	});

	it("filters by minimum score", () => {
		const plans = buildBatchExportJobs({
			projectName: "My Pod",
			clips,
			minScore: 60,
		});
		expect(plans.length).toBe(2);
	});

	it("applies 9:16 render-time override without touching project settings", () => {
		const plans = buildBatchExportJobs({ projectName: "My Pod", clips });
		for (const plan of plans) {
			expect(plan.options.aspectOverride).toBe("9:16");
			// No canvas mutation exists in options — the renderer derives it.
		}
	});

	it("can opt out of the aspect override", () => {
		const plans = buildBatchExportJobs({
			projectName: "My Pod",
			clips,
			aspectOverride: null,
		});
		expect(plans[0].options.aspectOverride).toBeUndefined();
	});
});

describe("queueBatchExportJobs", () => {
	it("enqueues every plan and returns job ids in order", () => {
		const plans = buildBatchExportJobs({
			projectName: "Pod",
			clips: [
				{ title: "A", start: 0, end: 5, score: 90, reason: "", tags: [] },
				{ title: "B", start: 6, end: 9, score: 70, reason: "", tags: [] },
			],
		});
		const ids: string[] = [];
		const added: string[] = [];
		const result = queueBatchExportJobs({
			addJob: (job) => {
				ids.push(`job-${ids.length}`);
				added.push(job.projectName);
				return `job-${ids.length - 1}`;
			},
			projectId: "p1",
			plans,
		});
		expect(result.length).toBe(2);
		expect(added[0]).toBe("Pod-1-a");
		expect(added[1]).toBe("Pod-2-b");
	});
});

describe("resolveAspectCanvas", () => {
	it("flips landscape to portrait keeping the long edge", () => {
		expect(resolveAspectCanvas({ base: { width: 1920, height: 1080 }, aspectOverride: "9:16" })).toEqual({
			width: 1080,
			height: 1920,
		});
	});

	it("flips portrait back to landscape", () => {
		expect(resolveAspectCanvas({ base: { width: 1080, height: 1920 }, aspectOverride: "16:9" })).toEqual({
			width: 1920,
			height: 1080,
		});
	});

	it("falls back to the base canvas on invalid dimensions", () => {
		const base = { width: Number.NaN, height: 1080 };
		expect(resolveAspectCanvas({ base, aspectOverride: "9:16" })).toBe(base);
	});
});

describe("BATCH_EXPORT_DEFAULTS", () => {
	it("defaults to keep-all scores and vertical shorts", () => {
		expect(BATCH_EXPORT_DEFAULTS.minScore).toBe(0);
		expect(BATCH_EXPORT_DEFAULTS.aspectOverride).toBe("9:16");
	});
});
