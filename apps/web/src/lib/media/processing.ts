import { toast } from "sonner";
import type { MediaAsset } from "@/types/assets";
import { getMediaTypeFromFile } from "@/lib/media/media-utils";
import { getVideoInfo } from "./mediabunny";
import { Input, ALL_FORMATS, BlobSource, VideoSampleSink } from "mediabunny";

export interface ProcessedMediaAsset extends Omit<MediaAsset, "id"> {}

/** Max file size (bytes) we send to the backend probe endpoint. */
const PROBE_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

interface BackendProbeResult {
	duration?: number | null;
	bit_rate?: number | null;
	video?: {
		codec?: string | null;
		width?: number | null;
		height?: number | null;
		fps?: number | null;
		bit_rate?: number | null;
	} | null;
	audio?: {
		codec?: string | null;
		sample_rate?: number | null;
		channels?: number | null;
		bit_rate?: number | null;
	} | null;
}

/**
 * Ask the AI backend to probe the media file via ffprobe.
 * Returns null when the backend is unreachable or probing fails
 * (the client-side browser metadata is always the fallback).
 */
async function probeMediaWithBackend(
	file: File,
): Promise<BackendProbeResult | null> {
	const baseUrl = process.env.NEXT_PUBLIC_AI_BACKEND_URL;
	if (!baseUrl) return null;
	if (file.size > PROBE_MAX_BYTES) return null;

	try {
		const formData = new FormData();
		formData.append("file", file);
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 30_000);

		const response = await fetch(`${baseUrl}/api/media/probe`, {
			method: "POST",
			body: formData,
			signal: controller.signal,
			headers: process.env.NEXT_PUBLIC_AI_API_KEY
				? { "X-API-Key": process.env.NEXT_PUBLIC_AI_API_KEY }
				: {},
		});
		clearTimeout(timeoutId);

		if (!response.ok) return null;
		return (await response.json()) as BackendProbeResult;
	} catch (error) {
		console.warn("Backend media probe unavailable, using browser metadata", error);
		return null;
	}
}

const THUMBNAIL_MAX_WIDTH = 1280;
const THUMBNAIL_MAX_HEIGHT = 720;

const getThumbnailSize = ({
	width,
	height,
}: {
	width: number;
	height: number;
}): { width: number; height: number } => {
	const aspectRatio = width / height;
	let targetWidth = width;
	let targetHeight = height;

	if (targetWidth > THUMBNAIL_MAX_WIDTH) {
		targetWidth = THUMBNAIL_MAX_WIDTH;
		targetHeight = Math.round(targetWidth / aspectRatio);
	}
	if (targetHeight > THUMBNAIL_MAX_HEIGHT) {
		targetHeight = THUMBNAIL_MAX_HEIGHT;
		targetWidth = Math.round(targetHeight * aspectRatio);
	}

	return { width: targetWidth, height: targetHeight };
};

const renderToThumbnailDataUrl = ({
	width,
	height,
	draw,
}: {
	width: number;
	height: number;
	draw: ({
		context,
		width,
		height,
	}: {
		context: CanvasRenderingContext2D;
		width: number;
		height: number;
	}) => void;
}): string => {
	const size = getThumbnailSize({ width, height });
	const canvas = document.createElement("canvas");
	canvas.width = size.width;
	canvas.height = size.height;
	const context = canvas.getContext("2d");

	if (!context) {
		throw new Error("Could not get canvas context");
	}

	draw({ context, width: size.width, height: size.height });
	return canvas.toDataURL("image/jpeg", 0.8);
};

export async function generateFilmstrip({
	videoFile,
	duration,
	frameCount = 10,
}: {
	videoFile: File;
	duration: number;
	frameCount?: number;
}): Promise<string[]> {
	const input = new Input({
		source: new BlobSource(videoFile),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	if (!videoTrack) throw new Error("No video track found");
	
	const canDecode = await videoTrack.canDecode();
	if (!canDecode) throw new Error("Video codec not supported");

	const sink = new VideoSampleSink(videoTrack);
	const urls: string[] = [];
	
	// Avoid sampling exactly at 0 or max duration to prevent seeking errors
	const safeDuration = Math.max(0.1, duration - 0.1);
	const step = safeDuration / Math.max(1, frameCount - 1);
	
	for (let i = 0; i < frameCount; i++) {
		const time = Math.min(i * step, safeDuration);
		const frame = await sink.getSample(time);
		if (!frame) continue;

		try {
			const url = renderToThumbnailDataUrl({
				width: videoTrack.displayWidth,
				height: videoTrack.displayHeight,
				draw: ({ context, width, height }) => {
					frame.draw(context, 0, 0, width, height);
				},
			});
			urls.push(url);
		} finally {
			frame.close();
		}
	}
	
	return urls;
}

export async function generateThumbnail({
	videoFile,
	timeInSeconds,
}: {
	videoFile: File;
	timeInSeconds: number;
}): Promise<string> {
	const input = new Input({
		source: new BlobSource(videoFile),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	if (!videoTrack) {
		throw new Error("No video track found in the file");
	}

	const canDecode = await videoTrack.canDecode();
	if (!canDecode) {
		throw new Error("Video codec not supported for decoding");
	}

	const sink = new VideoSampleSink(videoTrack);

	const frame = await sink.getSample(timeInSeconds);

	if (!frame) {
		throw new Error("Could not get frame at specified time");
	}

	try {
		return renderToThumbnailDataUrl({
			width: videoTrack.displayWidth,
			height: videoTrack.displayHeight,
			draw: ({ context, width, height }) => {
				frame.draw(context, 0, 0, width, height);
			},
		});
	} finally {
		frame.close();
	}
}

export async function generateImageThumbnail({
	imageFile,
}: {
	imageFile: File;
}): Promise<string> {
	return new Promise((resolve, reject) => {
		const image = new window.Image();
		const objectUrl = URL.createObjectURL(imageFile);

		image.addEventListener("load", () => {
			try {
				const dataUrl = renderToThumbnailDataUrl({
					width: image.naturalWidth,
					height: image.naturalHeight,
					draw: ({ context, width, height }) => {
						context.drawImage(image, 0, 0, width, height);
					},
				});
				resolve(dataUrl);
			} catch (error) {
				reject(
					error instanceof Error ? error : new Error("Could not render image"),
				);
			} finally {
				URL.revokeObjectURL(objectUrl);
				image.remove();
			}
		});

		image.addEventListener("error", () => {
			URL.revokeObjectURL(objectUrl);
			image.remove();
			reject(new Error("Could not load image"));
		});

		image.src = objectUrl;
	});
}

export async function processMediaAssets({
	files,
	onProgress,
}: {
	files: FileList | File[];
	onProgress?: ({ progress }: { progress: number }) => void;
}): Promise<ProcessedMediaAsset[]> {
	const fileArray = Array.from(files);
	const processedAssets: ProcessedMediaAsset[] = [];

	const total = fileArray.length;
	let completed = 0;

	for (const file of fileArray) {
		const fileType = getMediaTypeFromFile({ file });

		if (!fileType) {
			toast.error(`Unsupported file type: ${file.name}`);
			continue;
		}

		const url = URL.createObjectURL(file);
		let thumbnailUrl: string | undefined;
		let filmstripUrls: string[] | undefined;
		let duration: number | undefined;
		let width: number | undefined;
		let height: number | undefined;
		let fps: number | undefined;
		let bitrate: number | undefined;
		let channels: number | undefined;
		let sampleRate: number | undefined;

		// Best-effort backend probe (ffprobe) for full metadata.
		// Browser metadata below always remains the fallback.
		const backendProbe =
			fileType === "video" || fileType === "audio"
				? await probeMediaWithBackend(file)
				: null;

		try {
			if (fileType === "image") {
				const dimensions = await getImageDimensions({ file });
				width = dimensions.width;
				height = dimensions.height;
				thumbnailUrl = await generateImageThumbnail({ imageFile: file });
			} else if (fileType === "video") {
				try {
					const videoInfo = await getVideoInfo({ videoFile: file });
					duration = videoInfo.duration;
					width = videoInfo.width;
					height = videoInfo.height;
					fps = Number.isFinite(videoInfo.fps)
						? Math.round(videoInfo.fps)
						: undefined;

					thumbnailUrl = await generateThumbnail({
						videoFile: file,
						timeInSeconds: 1,
					});
					// Sample a few extra frames for the timeline filmstrip (best effort).
					if (duration && Number.isFinite(duration)) {
						try {
							filmstripUrls = await generateFilmstrip({
								videoFile: file,
								duration,
								frameCount: 10,
							});
						} catch (error) {
							console.warn("Filmstrip generation failed", error);
						}
					}
				} catch (error) {
					console.warn("Video processing failed", error);
				}
			} else if (fileType === "audio") {
				// For audio, we don't set width/height/fps (they'll be undefined)
				duration = await getMediaDuration({ file });
			}

			// Merge backend probe data (only fills what browser metadata missed).
			if (backendProbe) {
				if (!duration && backendProbe.duration) {
					duration = backendProbe.duration;
				}
				if (!width && backendProbe.video?.width) {
					width = backendProbe.video.width;
				}
				if (!height && backendProbe.video?.height) {
					height = backendProbe.video.height;
				}
				if (!fps && backendProbe.video?.fps) {
					fps = Math.round(backendProbe.video.fps);
				}
				if (!bitrate) {
					bitrate =
						backendProbe.video?.bit_rate ?? backendProbe.bit_rate ?? undefined;
				}
				if (!channels && backendProbe.audio?.channels) {
					channels = backendProbe.audio.channels;
				}
				if (!sampleRate && backendProbe.audio?.sample_rate) {
					sampleRate = backendProbe.audio.sample_rate;
				}
			}

			processedAssets.push({
				name: file.name,
				type: fileType,
				file,
				url,
				thumbnailUrl,
				filmstripUrls,
				duration,
				width,
				height,
				fps,
				bitrate,
				channels,
				sampleRate,
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			completed += 1;
			if (onProgress) {
				const percent = Math.round((completed / total) * 100);
				onProgress({ progress: percent });
			}
		} catch (error) {
			console.error("Error processing file:", file.name, error);
			toast.error(`Failed to process ${file.name}`);
			URL.revokeObjectURL(url); // Clean up on error
		}
	}

	return processedAssets;
}

const getImageDimensions = ({
	file,
}: {
	file: File;
}): Promise<{ width: number; height: number }> => {
	return new Promise((resolve, reject) => {
		const img = new window.Image();
		const objectUrl = URL.createObjectURL(file);

		img.addEventListener("load", () => {
			const width = img.naturalWidth;
			const height = img.naturalHeight;
			resolve({ width, height });
			URL.revokeObjectURL(objectUrl);
			img.remove();
		});

		img.addEventListener("error", () => {
			reject(new Error("Could not load image"));
			URL.revokeObjectURL(objectUrl);
			img.remove();
		});

		img.src = objectUrl;
	});
};

const getMediaDuration = ({ file }: { file: File }): Promise<number> => {
	return new Promise((resolve, reject) => {
		const element = document.createElement(
			file.type.startsWith("video/") ? "video" : "audio",
		) as HTMLVideoElement;
		const objectUrl = URL.createObjectURL(file);

		element.addEventListener("loadedmetadata", () => {
			resolve(element.duration);
			URL.revokeObjectURL(objectUrl);
			element.remove();
		});

		element.addEventListener("error", () => {
			reject(new Error("Could not load media"));
			URL.revokeObjectURL(objectUrl);
			element.remove();
		});

		element.src = objectUrl;
		element.load();
	});
};
