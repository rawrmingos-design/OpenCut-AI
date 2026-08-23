"use client";

/**
 * Opt-in crash reporter (SCRUM-47).
 * Reports ONLY when user opts in via Settings. Batches + flushes to
 * /api/crash-report; never breaks the app on failure.
 */

import { useAppSettingsStore } from "@/stores/app-settings-store";

const ENDPOINT = "/api/crash-report";
const MAX_QUEUE = 20;
const FLUSH_INTERVAL_MS = 10_000;

interface CrashReport {
	message: string;
	stack?: string;
	source: "window.onerror" | "unhandledrejection" | "error-boundary";
	url?: string;
	userAgent: string;
	timestamp: string;
	appVersion: string;
}

let queue: CrashReport[] = [];
let installed = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function reportAllowed(): boolean {
	try {
		return useAppSettingsStore.getState().optInCrashReporting === true;
	} catch {
		return false;
	}
}

function enqueue(
	partial: Omit<CrashReport, "userAgent" | "timestamp" | "appVersion">,
) {
	if (!reportAllowed()) return;
	queue.push({
		...partial,
		userAgent:
			typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
		timestamp: new Date().toISOString(),
		appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
	});
	if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
	scheduleFlush();
}

function scheduleFlush() {
	if (flushTimer || queue.length === 0) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		void flush();
	}, FLUSH_INTERVAL_MS);
}

async function flush(): Promise<void> {
	if (queue.length === 0) return;
	const batch = queue;
	queue = [];
	try {
		await fetch(ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reports: batch }),
			keepalive: true,
		});
	} catch {
		// Telemetry must never break the app; drop silently.
	}
}

export function installGlobalHandlers(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;

	window.addEventListener("error", (event) => {
		enqueue({
			message: event.message || "unknown error",
			stack: event.error?.stack?.slice(0, 8000),
			source: "window.onerror",
			url: location.pathname,
		});
	});

	window.addEventListener("unhandledrejection", (event) => {
		const reason = event.reason;
		enqueue({
			message:
				reason instanceof Error
					? reason.message
					: String(reason ?? "unhandled rejection"),
			stack: reason instanceof Error ? reason.stack?.slice(0, 8000) : undefined,
			source: "unhandledrejection",
			url: location.pathname,
		});
	});
}

/** Called from React error boundaries for render-tree crashes. */
export function reportErrorBoundary(error: Error): void {
	enqueue({
		message: error.message || "render tree crash",
		stack: error.stack?.slice(0, 8000),
		source: "error-boundary",
		url: typeof location !== "undefined" ? location.pathname : undefined,
	});
}

/** Flush immediately (e.g. before unload). Safe to call repeatedly. */
export function flushNow(): Promise<void> {
	return flush();
}
