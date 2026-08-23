"use client";

import { useEffect } from "react";
import {
	installGlobalHandlers,
	flushNow,
} from "@/lib/telemetry/crash-reporter";

export function CrashReporter() {
	useEffect(() => {
		installGlobalHandlers();
		const onUnload = () => {
			void flushNow();
		};
		window.addEventListener("beforeunload", onUnload);
		return () => {
			window.removeEventListener("beforeunload", onUnload);
		};
	}, []);

	return null;
}
