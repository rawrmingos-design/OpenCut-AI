"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	Cancel01Icon,
	Tick01Icon,
	AlertCircleIcon,
} from "@hugeicons/core-free-icons";
import {
	isBackgroundTaskActive,
	useBackgroundTasksStore,
	type BackgroundTask,
} from "@/stores/background-tasks-store";

function formatElapsed(startedAt: number, completedAt?: number): string {
	const elapsed = Math.floor(
		((completedAt ?? Date.now()) - startedAt) / 1000,
	);
	if (elapsed < 60) return `${elapsed}s`;
	return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
}

function TaskRow({ task }: { task: BackgroundTask }) {
	const cancelTask = useBackgroundTasksStore((s) => s.cancelTask);
	const retryTask = useBackgroundTasksStore((s) => s.retryTask);
	const removeTask = useBackgroundTasksStore((s) => s.removeTask);
	const [elapsed, setElapsed] = useState(
		formatElapsed(task.startedAt, task.completedAt),
	);

	useEffect(() => {
		if (!isBackgroundTaskActive(task.status)) return;
		const timer = setInterval(
			() => setElapsed(formatElapsed(task.startedAt)),
			1000,
		);
		return () => clearInterval(timer);
	}, [task.status, task.startedAt]);

	const isActive = isBackgroundTaskActive(task.status);

	return (
		<div className="flex items-center gap-2 px-3 py-2">
			{isActive && <Spinner className="size-3 shrink-0" />}
			{task.status === "completed" && (
				<HugeiconsIcon
					icon={Tick01Icon}
					className="size-3.5 text-green-500 shrink-0"
				/>
			)}
			{(task.status === "error" || task.status === "failed") && (
				<HugeiconsIcon
					icon={AlertCircleIcon}
					className="size-3.5 text-red-500 shrink-0"
				/>
			)}
			{task.status === "cancelled" && (
				<HugeiconsIcon
					icon={Cancel01Icon}
					className="size-3.5 text-muted-foreground shrink-0"
				/>
			)}

			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-1.5">
					<span className="text-[11px] font-medium truncate">
						{task.label}
					</span>
					<span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
						{elapsed}
					</span>
				</div>
				{isActive && task.progress && (
					<p className="text-[10px] text-muted-foreground truncate">
						{task.progress}
					</p>
				)}
				{(task.status === "error" || task.status === "failed") && task.error && (
					<p className="text-[10px] text-red-400 truncate">
						{task.error}
					</p>
				)}
				{task.status === "cancelled" && (
					<p className="text-[10px] text-muted-foreground truncate">
						Cancelled
					</p>
				)}
			</div>

			{/* SCRUM-77: cancel running tasks, retry failed/cancelled ones */}
			{isActive && (
				<Button
					variant="ghost"
					size="sm"
					className="h-5 px-1.5 text-[10px] text-muted-foreground shrink-0"
					onClick={() => cancelTask(task.id)}
				>
					Cancel
				</Button>
			)}
			{(task.status === "failed" || task.status === "error") && task.retry && (
				<Button
					variant="ghost"
					size="sm"
					className="h-5 px-1.5 text-[10px] text-primary shrink-0"
					onClick={() => retryTask(task.id)}
				>
					Retry
				</Button>
			)}
			{!isActive && (
				<Button
					variant="ghost"
					size="icon"
					className="size-5 shrink-0"
					onClick={() => removeTask(task.id)}
				>
					<HugeiconsIcon icon={Cancel01Icon} className="size-3" />
				</Button>
			)}
		</div>
	);
}

export function BackgroundTasksWidget() {
	const tasks = useBackgroundTasksStore((s) => s.tasks);
	const isMinimized = useBackgroundTasksStore((s) => s.isMinimized);
	const setMinimized = useBackgroundTasksStore((s) => s.setMinimized);
	const clearCompleted = useBackgroundTasksStore((s) => s.clearCompleted);

	if (tasks.length === 0) return null;

	const runningCount = tasks.filter((t) =>
		isBackgroundTaskActive(t.status),
	).length;
	const hasCompleted = tasks.some((t) => !isBackgroundTaskActive(t.status));

	return (
		<div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg border bg-background shadow-lg overflow-hidden">
			{/* Header */}
			<div
				className="flex items-center justify-between px-3 py-2 border-b cursor-pointer hover:bg-accent/50 transition-colors"
				onClick={() => setMinimized(!isMinimized)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") setMinimized(!isMinimized);
				}}
				role="button"
				tabIndex={0}
			>
				<div className="flex items-center gap-2">
					{runningCount > 0 && <Spinner className="size-3" />}
					<span className="text-xs font-semibold">
						{runningCount > 0
							? `${runningCount} task${runningCount > 1 ? "s" : ""} running`
							: "Tasks completed"}
					</span>
				</div>
				<div className="flex items-center gap-1">
					{hasCompleted && !isMinimized && (
						<Button
							variant="ghost"
							size="sm"
							className="h-5 px-1.5 text-[10px] text-muted-foreground"
							onClick={(e) => {
								e.stopPropagation();
								clearCompleted();
							}}
						>
							Clear
						</Button>
					)}
					<HugeiconsIcon
						icon={isMinimized ? ArrowUp01Icon : ArrowDown01Icon}
						className="size-3.5 text-muted-foreground"
					/>
				</div>
			</div>

			{/* Task list — running/latest on top, finished at bottom */}
			{!isMinimized && (
				<div className="max-h-60 overflow-y-auto divide-y">
					{[...tasks]
						.sort((a, b) => {
							// Running tasks first
							const aActive = isBackgroundTaskActive(a.status);
							const bActive = isBackgroundTaskActive(b.status);
							if (aActive && !bActive) return -1;
							if (!aActive && bActive) return 1;
							// Within same status group, newest first
							return b.startedAt - a.startedAt;
						})
						.map((task) => (
							<TaskRow key={task.id} task={task} />
						))}
				</div>
			)}
		</div>
	);
}
