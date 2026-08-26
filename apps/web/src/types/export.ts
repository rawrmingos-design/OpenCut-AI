export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export const EXPORT_RESOLUTION_VALUES = [
	"source",
	"2160p",
	"1440p",
	"1080p",
	"720p",
	"480p",
	"360p",
] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];
export type ExportResolution = (typeof EXPORT_RESOLUTION_VALUES)[number];

/** SCRUM-81: per-clip overlay metadata baked into batch export jobs. */
export interface BatchOverlayMetadata {
	/** Source-video transcript segments overlapping the clip (source time). */
	segments: {
		text: string;
		start: number;
		end: number;
		words: { word: string; start: number; end: number; confidence?: number }[];
	}[];
	/** Source-time clip start used as the rebase origin (t=0 at render). */
	clipStart: number;
	/** Rendered clip duration in seconds (end - start). */
	clipDuration: number;
	/** Opening hook text; empty string skips the hook track. */
	hookTitle: string;
	/** Popover subtitle preset id. */
	subtitlePreset: string;
	/** Target canvas dimensions AFTER the aspect override is applied. */
	canvasWidth: number;
	canvasHeight: number;
	/**
	 * Per-mediaId face-tracking keyframes for video elements.
	 * Applied at render time to cloned video tracks — no project mutation.
	 * Key = mediaId, value = {positionX, positionY, scale} keyframe arrays.
	 */
	videoReframeAnimations?: Record<
		string,
		{
			positionX: { id: string; time: number; value: number; interpolation: "linear" | "hold" }[];
			positionY: { id: string; time: number; value: number; interpolation: "linear" | "hold" }[];
			scale: { id: string; time: number; value: number; interpolation: "linear" | "hold" }[];
		}
	>;
}

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: number;
	includeAudio?: boolean;
	includeWatermark?: boolean;
	/** Override output resolution (height-based, e.g. "1080p"). "source" keeps canvas size. */
	resolution?: ExportResolution;
	/** Video bitrate override in bits per second. When set, takes precedence over quality presets. */
	videoBitrate?: number;
	/** Audio bitrate override in bits per second. */
	audioBitrate?: number;
	/** SCRUM-71: render only `[start, end]` seconds of the timeline. */
	start?: number;
	end?: number;
	/** SCRUM-74: render-time aspect override ("16:9" | "9:16") applied WITHOUT mutating project settings. */
	aspectOverride?: "16:9" | "9:16";
	/** SCRUM-81: render-only hook/subtitle overlays for batch jobs. Immutable snapshot; the renderer merges them onto the cloned track list — the live project is untouched. */
	batchOverlays?: BatchOverlayMetadata;
}

export interface ExportResult {
	success: boolean;
	buffer?: ArrayBuffer;
	error?: string;
	cancelled?: boolean;
}

/** SCRUM-35: explicit job lifecycle states for export/render jobs. */
export type ExportJobStatus =
	| "idle"
	| "preparing"
	| "rendering"
	| "finalizing"
	| "done"
	| "cancelled"
	| "failed";

export interface ExportState {
	isExporting: boolean;
	progress: number;
	result: ExportResult | null;
	/** Detailed job state (SCRUM-35). Kept in sync with isExporting/result. */
	status: ExportJobStatus;
}
