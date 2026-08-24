import type { ClipCandidate } from "@/types/ai";
import type { ExportOptions } from "@/types/export";

/**
 * SCRUM-74: one-click batch export for all found clips.
 * Pure planning helpers — store side effects live in `queueBatchExportJobs`.
 */

export const BATCH_EXPORT_DEFAULTS = {
	/** Clips below this score are skipped by "Export All". 0 = keep everything. */
	minScore: 0,
	/** Render every short vertical regardless of project canvas setting. */
	aspectOverride: "9:16" as const,
};

/** Filesystem-safe topic slug for job names. */
export function slugifyTopic(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{Mark}+/gu, "")
		.replace(/[^\p{Letter}\p{Number}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "clip";
}

export interface BatchJobPlan {
	projectName: string;
	options: ExportOptions;
}

interface PlanArgs {
	projectName: string;
	clips: ClipCandidate[];
	format?: ExportOptions["format"];
	quality?: ExportOptions["quality"];
	fps?: number;
	includeAudio?: boolean;
	minScore?: number;
	aspectOverride?: "16:9" | "9:16" | null;
}

/** Build one ranged, auto-named export job per qualifying clip. */
export function buildBatchExportJobs({
	projectName,
	clips,
	format = "mp4",
	quality = "high",
	fps,
	includeAudio = true,
	minScore = BATCH_EXPORT_DEFAULTS.minScore,
	aspectOverride = BATCH_EXPORT_DEFAULTS.aspectOverride,
}: PlanArgs): BatchJobPlan[] {
	const safeBase =
		projectName.replace(/[<>:"/\\|?*]/g, "-").trim() || "project";
	return clips
		.filter((clip) => clip.score >= minScore)
		.map((clip, idx) => ({
			projectName: `${safeBase}-${idx + 1}-${slugifyTopic(clip.title)}`,
			options: {
				format,
				quality,
				...(fps !== undefined ? { fps } : {}),
				includeAudio,
				start: clip.start,
				end: clip.end,
				...(aspectOverride ? { aspectOverride } : {}),
			},
		}));
}

interface QueueArgs {
	addJob: (job: {
		projectId: string;
		projectName: string;
		options: ExportOptions;
	}) => string;
	projectId: string;
	plans: BatchJobPlan[];
}

/** Enqueue planned jobs into the render queue; returns the job ids. */
export function queueBatchExportJobs({
	addJob,
	projectId,
	plans,
}: QueueArgs): string[] {
	return plans.map((plan) =>
		addJob({
			projectId,
			projectName: plan.projectName,
			options: plan.options,
		}),
	);
}
