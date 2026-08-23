import { create } from "zustand";
import type {
	ExportOptions,
	ExportJobStatus,
	ExportResult,
} from "@/types/export";

export interface ExportJob {
	id: string;
	projectId: string;
	projectName: string;
	options: ExportOptions;
	status: ExportJobStatus;
	progress: number;
	result: ExportResult | null;
	createdAt: number;
}

interface ExportQueueState {
	jobs: ExportJob[];
	addJob: (
		job: Omit<ExportJob, "id" | "status" | "progress" | "result" | "createdAt">,
	) => string;
	updateJob: (id: string, updates: Partial<ExportJob>) => void;
	removeJob: (id: string) => void;
	clearCompleted: () => void;
}

export const useExportQueueStore = create<ExportQueueState>((set) => ({
	jobs: [],
	addJob: (job) => {
		const id = crypto.randomUUID();
		set((state) => ({
			jobs: [
				...state.jobs,
				{
					...job,
					id,
					status: "idle",
					progress: 0,
					result: null,
					createdAt: Date.now(),
				},
			],
		}));
		return id;
	},
	updateJob: (id, updates) =>
		set((state) => ({
			jobs: state.jobs.map((job) =>
				job.id === id ? { ...job, ...updates } : job,
			),
		})),
	removeJob: (id) =>
		set((state) => ({
			jobs: state.jobs.filter((job) => job.id !== id),
		})),
	clearCompleted: () =>
		set((state) => ({
			jobs: state.jobs.filter(
				(job) =>
					job.status !== "done" &&
					job.status !== "cancelled" &&
					job.status !== "failed",
			),
		})),
}));
