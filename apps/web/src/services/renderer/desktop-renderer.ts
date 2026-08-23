"use client";

import type { ExportOptions, ExportResult } from "@/types/export";
import type { EditorCore } from "@/core";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { tempDir, join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { mkdir, remove, writeFile } from "@tauri-apps/plugin-fs";
import { qualityMap } from "./scene-exporter";

interface RenderProgress {
	frame: number;
	total_frames: number;
	percent: number;
	fps: number;
	done: boolean;
	error: string | null;
}

export async function exportDesktopProject({
	editor,
	options,
	onProgress,
}: {
	editor: EditorCore;
	options: ExportOptions;
	onProgress?: ({ progress }: { progress: number }) => void;
}): Promise<ExportResult> {
	const activeProject = editor.project.getActive();
	if (!activeProject) return { success: false, error: "No active project" };

	const tracks = editor.timeline.getTracks();
	const mediaAssets = editor.media.getAssets();
	const duration = editor.timeline.getTotalDuration();
	if (duration === 0) return { success: false, error: "Project is empty" };

	const exportFps = options.fps || activeProject.settings.fps;
	const canvasSize = activeProject.settings.canvasSize;
	const targetHeight =
		options.resolution && options.resolution !== "source"
			? Number.parseInt(options.resolution.replace("p", ""), 10)
			: canvasSize.height;
	const targetWidth = Math.round(
		(canvasSize.width / canvasSize.height) * targetHeight,
	);
	// Need even dimensions for libx264
	const w = targetWidth % 2 === 0 ? targetWidth : targetWidth - 1;
	const h = targetHeight % 2 === 0 ? targetHeight : targetHeight - 1;

	// Extract clip metadata from tracks
	const clips = [];
	let hasAudio = false;

	// Only process the first track for now (proof of concept for native render bridge)
	// Multi-track composition is complex in FFmpeg and usually requires overlay filters.
	// For basic trimming & concat, we stick to the main track.
	const mainTrack =
		tracks.find((t) => t.type === "video" && t.isMain) || tracks[0];
	if (!mainTrack) return { success: false, error: "No tracks found" };

	for (const element of (mainTrack as any).elements) {
		if (element.type !== "video" && element.type !== "audio") continue;

		const mediaId = (element as any).mediaId || (element as any).sourceUrl;
		const asset = mediaAssets.find((a) => a.id === mediaId);
		if (!asset && element.type === "video") continue;

		let fileToStream: File | Blob | null = null;
		if (asset) {
			fileToStream = asset.file;
		}

		if (!fileToStream) continue;

		clips.push({
			file: fileToStream,
			spec: {
				src: "", // will fill after streaming to temp
				in_point: element.trimStart || 0,
				out_point:
					element.trimEnd || element.sourceDuration || element.duration,
				volume: (element as any).volume ?? 1.0,
			},
		});

		if (
			element.type === "audio" ||
			(element.type === "video" && !(element as any).muted)
		) {
			hasAudio = true;
		}
	}

	if (clips.length === 0) {
		return { success: false, error: "No valid video/audio clips in timeline" };
	}

	try {
		// 1. Prompt user for output location upfront
		const outPath = await save({
			title: "Export Video",
			defaultPath: `${activeProject.metadata.name}.${options.format}`,
			filters: [
				{
					name: "Video",
					extensions: [options.format],
				},
			],
		});

		if (!outPath) {
			return { success: false, cancelled: true };
		}

		// 2. Stream OPFS/Memory blobs to native temp dir so FFmpeg can read them
		onProgress?.({ progress: 0.05 });
		const tDir = await tempDir();
		const appTemp = await join(tDir, "opencut-ai-render");
		try {
			await mkdir(appTemp, { recursive: true });
		} catch (e) {
			// ignore if exists
		}

		for (let i = 0; i < clips.length; i++) {
			const c = clips[i] as { file: File; spec: { src: string } };
			const ext = c.file.name.split(".").pop() || "mp4";
			const tempPath = await join(appTemp, `clip_${i}.${ext}`);
			c.spec.src = tempPath;

			// Write in chunks to avoid JS memory limits on 4K files
			const arrayBuffer = await c.file.arrayBuffer();
			await writeFile(tempPath, new Uint8Array(arrayBuffer));
			onProgress?.({ progress: 0.05 + (i / clips.length) * 0.15 }); // 5% -> 20%
		}

		// 3. Listen to FFmpeg progress
		const listenerReady = listen<RenderProgress>("render-progress", (event) => {
			const p = event.payload;
			if (p.error && p.error === "cancelled") {
				throw Object.assign(new Error("Cancelled"), { cancelled: true });
			}
			if (p.error) {
				throw new Error(p.error);
			}
			// scale FFmpeg's 0-100% to our remaining 20% -> 99%
			onProgress?.({ progress: 0.2 + p.percent * 0.79 });
		});

		let isCanceled = false;
		const cancelCheck = setInterval(() => {
			const exportState = editor.project.getExportState();
			if (exportState.isExporting && exportState.result?.cancelled === true) {
				isCanceled = true;
				invoke("cancel_render");
				clearInterval(cancelCheck);
			}
		}, 200);

		const progressPromise = new Promise<void>((resolve, reject) => {
			const off = listen<RenderProgress>("render-progress", (event) => {
				if (event.payload.error === "cancelled") {
					reject(new Error("Cancelled"));
					off.then((fn) => fn());
				} else if (event.payload.done) {
					resolve();
					off.then((fn) => fn());
				}
			});
		});

		// 4. Invoke Rust Native Render
		try {
			await invoke("render_video_native", {
				request: {
					clips: clips.map((c) => c.spec),
					out_path: outPath,
					width: w,
					height: h,
					fps: exportFps,
					codec: options.format === "webm" ? "vp9" : "h264",
					bitrate_kbps: Math.floor(
						(options.videoBitrate ??
							(options.quality === "low"
								? 2000
								: options.quality === "medium"
									? 5000
									: options.quality === "high"
										? 10000
										: 20000)) / 1000,
					),
					has_audio: hasAudio && (options.includeAudio ?? true),
				},
			});
			await progressPromise;
		} finally {
			// SCRUM-33: Clean up temp chunks aggressively
			try {
				await remove(appTemp, { recursive: true });
			} catch (cleanupErr) {
				console.warn("Failed to clean up temp render directory", cleanupErr);
			}
		}

		const unlistenError = await listenerReady;

		unlistenError();

		onProgress?.({ progress: 1.0 });

		// Desktop handles saving straight to disk via outPath, no ArrayBuffer to return to UI
		return { success: true, buffer: undefined };
	} catch (e) {
		const errStr = String(e);
		if (errStr.includes("Cancelled") || errStr.includes("cancelled")) {
			return { success: false, cancelled: true };
		}
		console.error("Desktop export failed", e);
		return { success: false, error: errStr };
	}
}
