import { afterEach, describe, expect, test } from "bun:test";
import {
	useBackgroundTasksStore,
	isBackgroundTaskActive,
	isBackgroundTaskTerminal,
	type BackgroundTaskStatus,
} from "../background-tasks-store";

/**
 * SCRUM-77: background task lifecycle — explicit states, cancellation
 * guards, and terminal-state protection against late updates.
 */

const baseTask = () => ({
	id: "t1",
	type: "clip-finder" as const,
	label: "Find best clips",
	progress: "working",
});

function resetStore() {
	useBackgroundTasksStore.setState({ tasks: [], isMinimized: false });
}

describe("background task lifecycle", () => {
	afterEach(resetStore);

	test("active/terminal classification covers all statuses", () => {
		const active: BackgroundTaskStatus[] = ["preparing", "running", "finalizing"];
		const terminal: BackgroundTaskStatus[] = [
			"completed",
			"failed",
			"error",
			"cancelled",
		];
		for (const status of active) {
			expect(isBackgroundTaskActive(status)).toBe(true);
			expect(isBackgroundTaskTerminal(status)).toBe(false);
		}
		for (const status of terminal) {
			expect(isBackgroundTaskActive(status)).toBe(false);
			expect(isBackgroundTaskTerminal(status)).toBe(true);
		}
	});

	test("cancelTask invokes cancel hook and lands in cancelled state", () => {
		let cancelled = false;
		const { addTask, cancelTask } = useBackgroundTasksStore.getState();
		addTask({
			...baseTask(),
			cancel: () => {
				cancelled = true;
			},
		});

		cancelTask("t1");

		const task = useBackgroundTasksStore
			.getState()
			.tasks.find((task) => task.id === "t1");
		expect(cancelled).toBe(true);
		expect(task?.status).toBe("cancelled");
		expect(task?.progress).toBe("Cancelled");
		expect(typeof task?.completedAt).toBe("number");
	});

	test("cancelTask on an unknown or already-terminal task is a no-op", () => {
		let calls = 0;
		const { addTask, cancelTask } = useBackgroundTasksStore.getState();
		addTask({
			...baseTask(),
			id: "t2",
			cancel: () => {
				calls += 1;
			},
		});
		useBackgroundTasksStore.getState().updateTask("t2", {
			status: "completed",
			completedAt: Date.now(),
		});

		cancelTask("missing-id");
		cancelTask("t2");
		expect(calls).toBe(0);

		const task = useBackgroundTasksStore
			.getState()
			.tasks.find((task) => task.id === "t2");
		expect(task?.status).toBe("completed");
	});

	test("late updates after a terminal state are ignored (no zombie spinner)", () => {
		const { addTask, cancelTask, updateTask } =
			useBackgroundTasksStore.getState();
		addTask(baseTask());
		cancelTask("t1");

		updateTask("t1", {
			status: "completed",
			progress: "Late result after cancel",
			completedAt: Date.now(),
		});
		updateTask("t1", { status: "error", error: "Late failure" });

		const task = useBackgroundTasksStore
			.getState()
			.tasks.find((task) => task.id === "t1");
		expect(task?.status).toBe("cancelled");
		expect(task?.progress).toBe("Cancelled");
		expect(task?.error).toBeUndefined();
	});

	test("retryTask invokes the stored retry hook once per call", () => {
		let retries = 0;
		const { addTask, updateTask, retryTask } = useBackgroundTasksStore.getState();
		addTask({
			...baseTask(),
			retry: () => {
				retries += 1;
			},
		});
		updateTask("t1", {
			status: "failed",
			error: "boom",
			completedAt: Date.now(),
		});

		retryTask("t1");
		retryTask("t1");
		expect(retries).toBe(2);

		resetStore();
		const { retryTask: retryMissing } = useBackgroundTasksStore.getState();
		expect(() => retryMissing("nope")).not.toThrow();
	});

	test("clearCompleted keeps active tasks and removes terminal ones", () => {
		const { addTask, updateTask, clearCompleted } =
			useBackgroundTasksStore.getState();
		addTask({ ...baseTask(), id: "keep-running" });
		addTask({ ...baseTask(), id: "drop-done" });
		addTask({ ...baseTask(), id: "drop-cancelled" });
		updateTask("drop-done", { status: "completed", completedAt: Date.now() });
		updateTask("drop-cancelled", {
			status: "cancelled",
			completedAt: Date.now(),
		});

		clearCompleted();

		const ids = useBackgroundTasksStore.getState().tasks.map((t) => t.id);
		expect(ids).toEqual(["keep-running"]);
	});
});
