import { create } from "zustand";
import { toast } from "sonner";

export type BackgroundTaskStatus =
	| "preparing"
	| "running"
	| "finalizing"
	| "completed"
	| "failed"
	| "error"
	| "cancelled";

export interface BackgroundTask {
	id: string;
	type:
		| "transcription"
		| "voiceover"
		| "translation"
		| "tts"
		| "clip-finder"
		| "keyword-extraction"
		| "question-cards"
		| "popover-subs"
		| "speaker-diarization"
		| "template-generation"
		| "broll-suggestions"
		| "broll-batch"
		| "smart-cut"
		| "proxy-generation"
		| "dubbing";
	label: string;
	status: BackgroundTaskStatus;
	progress: string;
	startedAt: number;
	completedAt?: number;
	error?: string;
	cancel?: () => void;
	retry?: () => void;
}

interface BackgroundTasksState {
	tasks: BackgroundTask[];
	isMinimized: boolean;

	addTask: (task: Omit<BackgroundTask, "startedAt" | "status">) => void;
	updateTask: (
		id: string,
		updates: Partial<
			Pick<BackgroundTask, "progress" | "status" | "error" | "completedAt">
		>,
	) => void;
	cancelTask: (id: string) => void;
	retryTask: (id: string) => void;
	removeTask: (id: string) => void;
	clearCompleted: () => void;
	setMinimized: (minimized: boolean) => void;
}

export const ACTIVE_BACKGROUND_TASK_STATUSES: BackgroundTaskStatus[] = [
	"preparing",
	"running",
	"finalizing",
];

export function isBackgroundTaskActive(status: BackgroundTaskStatus): boolean {
	return ACTIVE_BACKGROUND_TASK_STATUSES.includes(status);
}

export function isBackgroundTaskTerminal(status: BackgroundTaskStatus): boolean {
	return !isBackgroundTaskActive(status);
}

export const useBackgroundTasksStore = create<BackgroundTasksState>(
	(set, get) => ({
		tasks: [],
		isMinimized: false,

		addTask: (task) => {
			set((state) => ({
				tasks: [
					...state.tasks,
					{ ...task, status: "running" as const, startedAt: Date.now() },
				],
				isMinimized: false,
			}));
		},

		updateTask: (id, updates) => {
			const existing = get().tasks.find((task) => task.id === id);
			if (!existing || isBackgroundTaskTerminal(existing.status)) return;

			const next = { ...existing, ...updates };
			set((state) => ({
				tasks: state.tasks.map((task) => (task.id === id ? next : task)),
			}));

			if (updates.status === "failed" || updates.status === "error") {
				if (updates.error) {
					toast.error(`${existing.label} failed`, {
						description: updates.error,
					});
				}
			} else if (updates.status === "cancelled") {
				toast.info(`${existing.label} cancelled`);
			} else if (updates.status === "completed") {
				toast.success(`${existing.label} completed`);
			}
		},

		cancelTask: (id) => {
			const existing = get().tasks.find((task) => task.id === id);
			if (!existing || !isBackgroundTaskActive(existing.status)) return;
			existing.cancel?.();
			get().updateTask(id, {
				status: "cancelled",
				progress: "Cancelled",
				completedAt: Date.now(),
			});
		},

		retryTask: (id) => {
			const retry = get().tasks.find((task) => task.id === id)?.retry;
			retry?.();
		},

		removeTask: (id) => {
			set((state) => ({
				tasks: state.tasks.filter((task) => task.id !== id),
			}));
		},

		clearCompleted: () => {
			set((state) => ({
				tasks: state.tasks.filter((task) => isBackgroundTaskActive(task.status)),
			}));
		},

		setMinimized: (minimized) => {
			set({ isMinimized: minimized });
		},
	}),
);
