"use client";

import { useEffect, useRef } from "react";
import { useExportQueueStore } from "@/stores/export-queue-store";
import { useEditor } from "@/hooks/use-editor";
import { downloadBuffer } from "@/lib/export";
import { getExportMimeType } from "@/lib/export";

/**
 * SCRUM-24/25: Background queue worker.
 * Processes one job at a time. Retry is handled by re-adding failed jobs to the queue.
 * SCRUM-71: successful jobs deliver their rendered file via an automatic
 * browser download (the queue previously dropped the finished buffer).
 */
export function useExportQueueWorker() {
	const { jobs, updateJob } = useExportQueueStore();
	const editor = useEditor();
	const runningJobId = useRef<string | null>(null);

	useEffect(() => {
		// Find the first idle job
		const nextJob = jobs.find((j) => j.status === "idle");
		if (!nextJob || runningJobId.current) return;

		runningJobId.current = nextJob.id;
		updateJob(nextJob.id, { status: "preparing" });

		editor.renderer
			.exportProject({
				options: nextJob.options,
				onProgress: ({ progress }) => {
					const status =
						progress < 0.05
							? "preparing"
							: progress >= 0.99
								? "finalizing"
								: "rendering";
					updateJob(nextJob.id, { progress, status });
				},
				onCancel: () => {
					const job = useExportQueueStore
						.getState()
						.jobs.find((j) => j.id === nextJob.id);
					return job?.status === "cancelled";
				},
			})
			.then((result) => {
				const finalStatus = result.cancelled
					? "cancelled"
					: result.success
						? "done"
						: "failed";
				updateJob(nextJob.id, {
					status: finalStatus,
					result,
					progress: result.success ? 1 : 0,
				});

				// SCRUM-71: hand the finished file to the user (browser path).
				if (
					finalStatus === "done" &&
					result.buffer &&
					typeof document !== "undefined"
				) {
					downloadBuffer({
						buffer: result.buffer,
						filename: buildExportFilename({
							projectName: nextJob.projectName,
							options: nextJob.options,
						}),
						mimeType: getExportMimeType({ format: nextJob.options.format }),
					});
				}
			})
			.catch((err) => {
				updateJob(nextJob.id, {
					status: "failed",
					result: { success: false, error: String(err) },
				});
			})
			.finally(() => {
				runningJobId.current = null;
			});
	}, [jobs, editor.renderer, updateJob]);
}

/** Build a descriptive filename; ranged exports include their window. */
export function buildExportFilename({
	projectName,
	options,
}: {
	projectName: string;
	options: { format: string; start?: number; end?: number };
}): string {
	const safeName =
		projectName.replace(/[<>:"/\\|?*]/g, "-").trim() || "export";
	if (
		typeof options.start !== "number" ||
		typeof options.end !== "number"
	) {
		return `${safeName}.${options.format}`;
	}
	const fmt = (value: number) => {
		const totalSeconds = Math.max(0, Math.round(value));
		const mm = Math.floor(totalSeconds / 60);
		const ss = String(totalSeconds % 60).padStart(2, "0");
		return `${String(mm).padStart(2, "0")}-${ss}`;
	};
	return `${safeName}_clip_${fmt(options.start)}_to_${fmt(options.end)}.${options.format}`;
}
