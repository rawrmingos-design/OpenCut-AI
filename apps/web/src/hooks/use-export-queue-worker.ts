"use client";

import { useEffect, useRef } from "react";
import { useExportQueueStore } from "@/stores/export-queue-store";
import { useEditor } from "@/hooks/use-editor";

/**
 * SCRUM-24/25: Background queue worker.
 * Processes one job at a time. Retry is handled by re-adding failed jobs to the queue.
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
