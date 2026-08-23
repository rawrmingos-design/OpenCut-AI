"use client";
import { useExportQueueWorker } from "@/hooks/use-export-queue-worker";

export function ExportQueueWorkerMount() {
	useExportQueueWorker();
	return null;
}
