"use client";

import { useEffect } from "react";
import { AlertCircle } from "lucide-react";
import { reportErrorBoundary } from "@/lib/telemetry/crash-reporter";

export default function ErrorBoundary({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		reportErrorBoundary(error);
	}, [error]);

	return (
		<div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background p-8 text-center">
			<AlertCircle className="h-10 w-10 text-destructive" />
			<h2 className="text-xl font-semibold">Workspace Error</h2>
			<p className="text-sm text-muted-foreground">
				{error.message || "An unexpected error occurred in this view."}
			</p>
			<button
				type="button"
				onClick={reset}
				className="rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
			>
				Try again
			</button>
		</div>
	);
}
