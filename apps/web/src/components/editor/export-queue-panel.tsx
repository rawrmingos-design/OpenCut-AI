"use client";

import type { ExportJob } from "@/stores/export-queue-store";
import { useExportQueueStore } from "@/stores/export-queue-store";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
	CheckCircle2,
	XCircle,
	Clock,
	Loader2,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { cn } from "@/utils/ui";

const STATUS_META: Record<
	string,
	{ icon: React.ReactNode; label: string; className: string }
> = {
	idle: {
		icon: <Clock className="size-3.5" />,
		label: "Queued",
		className: "text-muted-foreground",
	},
	preparing: {
		icon: <Loader2 className="size-3.5 animate-spin" />,
		label: "Preparing",
		className: "text-blue-500",
	},
	rendering: {
		icon: <Loader2 className="size-3.5 animate-spin" />,
		label: "Rendering",
		className: "text-blue-500",
	},
	finalizing: {
		icon: <Loader2 className="size-3.5 animate-spin" />,
		label: "Finalizing",
		className: "text-blue-500",
	},
	done: {
		icon: <CheckCircle2 className="size-3.5" />,
		label: "Done",
		className: "text-green-600",
	},
	cancelled: {
		icon: <XCircle className="size-3.5" />,
		label: "Cancelled",
		className: "text-muted-foreground",
	},
	failed: {
		icon: <XCircle className="size-3.5" />,
		label: "Failed",
		className: "text-destructive",
	},
};

function JobRow({ job }: { job: ExportJob }) {
	const updateJob = useExportQueueStore((s) => s.updateJob);
	const removeJob = useExportQueueStore((s) => s.removeJob);
	const meta = STATUS_META[job.status] ?? STATUS_META.idle;
	const isActive = ["idle", "preparing", "rendering", "finalizing"].includes(
		job.status,
	);

	return (
		<div className="flex items-center gap-2 rounded-md border px-2.5 py-2">
			{meta.icon}
			<div className="min-w-0 flex-1">
				<p className="truncate text-xs font-medium">{job.projectName}</p>
				{isActive && (
					<Progress value={job.progress * 100} className="mt-1 h-1" />
				)}
				{job.status === "failed" && job.result?.error && (
					<p className="mt-0.5 truncate text-[10px] text-destructive">
						{job.result.error}
					</p>
				)}
			</div>
			<span
				className={cn(
					"shrink-0 text-[10px] font-medium uppercase",
					meta.className,
				)}
			>
				{meta.label}
			</span>
			{job.status === "failed" && (
				<Button
					variant="ghost"
					size="icon"
					className="size-6 shrink-0"
					title="Retry"
					onClick={() =>
						updateJob(job.id, { status: "idle", progress: 0, result: null })
					}
				>
					<RotateCcw className="size-3.5" />
				</Button>
			)}
			{(isActive || job.status === "failed" || job.status === "cancelled") && (
				<Button
					variant="ghost"
					size="icon"
					className="size-6 shrink-0"
					title={isActive ? "Cancel" : "Remove"}
					onClick={() => {
						if (isActive) updateJob(job.id, { status: "cancelled" });
						else removeJob(job.id);
					}}
				>
					<Trash2 className="size-3.5" />
				</Button>
			)}
		</div>
	);
}

export function ExportQueuePanel() {
	const jobs = useExportQueueStore((s) => s.jobs);
	const clearCompleted = useExportQueueStore((s) => s.clearCompleted);

	if (jobs.length === 0) return null;

	const activeCount = jobs.filter(
		(j) =>
			j.status !== "done" && j.status !== "cancelled" && j.status !== "failed",
	).length;

	return (
		<div className="fixed right-4 bottom-4 z-50 w-72 space-y-1.5 rounded-lg border bg-background p-2 shadow-lg">
			<div className="flex items-center justify-between px-1 pb-1">
				<p className="text-xs font-medium">
					Render queue{" "}
					{activeCount > 0 && (
						<span className="text-muted-foreground">
							({activeCount} pending)
						</span>
					)}
				</p>
				<Button
					variant="ghost"
					size="sm"
					className="h-6 px-2 text-[10px]"
					onClick={clearCompleted}
				>
					Clear finished
				</Button>
			</div>
			{jobs.map((job) => (
				<JobRow key={job.id} job={job} />
			))}
		</div>
	);
}
