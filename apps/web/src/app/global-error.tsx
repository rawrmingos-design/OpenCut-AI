"use client";

import { useEffect } from "react";
import { AlertCircle } from "lucide-react";
import { reportErrorBoundary } from "@/lib/telemetry/crash-reporter";

export default function GlobalError({
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
		<html lang="en">
			<body
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					minHeight: "100vh",
					gap: 16,
					fontFamily: "system-ui, sans-serif",
				}}
			>
				<AlertCircle size={48} color="#ef4444" />
				<h2 style={{ margin: 0 }}>Something went wrong</h2>
				<p style={{ margin: 0, opacity: 0.7 }}>
					{error.message || "An unexpected error occurred."}
				</p>
				<button
					type="button"
					onClick={reset}
					style={{
						padding: "8px 20px",
						borderRadius: 8,
						border: "1px solid #d4d4d8",
						cursor: "pointer",
					}}
				>
					Try again
				</button>
			</body>
		</html>
	);
}
