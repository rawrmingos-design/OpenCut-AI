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
