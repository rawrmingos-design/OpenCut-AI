/**
 * SCRUM-73: client-side thumbnail extraction for the Podcast Clips gallery.
 *
 * Frames are grabbed near `clip.start` by seeking a detached <video> element
 * over the project's media File and painting it onto an offscreen canvas.
 * Results are cached per media asset + rounded timestamp so re-renders and
 * repeated scans never re-seek the same frame.
 */

const THUMBNAIL_WIDTH = 320;

export function thumbnailCacheKey(assetId: string, timestamp: number): string {
	return `${assetId}@${timestamp.toFixed(1)}`;
}

/** Clamp a requested seek position into the decodable range of a media file. */
export function pickSeekTime(timestamp: number, duration: number): number {
	const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
	const latest = Math.max(0, safeDuration - 0.1);
	return Math.min(Math.max(0, timestamp), latest);
}

type CacheValue = Promise<string | null>;

// Module-level memo shared across gallery mounts. Failed/null extractions are
// cached too so a broken codec doesn't cause retry storms while scrolling.
const thumbnailCache = new Map<string, CacheValue>();

export function clearThumbnailCache(): void {
	thumbnailCache.clear();
}

/** Deduplicating memo around thumbnail extraction (test seam included). */
export function cachedThumbnail(
	key: string,
	factory: () => Promise<string | null>,
): Promise<string | null> {
	const existing = thumbnailCache.get(key);
	if (existing) return existing;
	const pending = factory()
		.catch(() => null)
		.finally(() => {
			// Keep resolved entries bounded: drop them after 5 minutes so long
			// editing sessions don't pin every data URL forever.
			setTimeout(() => thumbnailCache.delete(key), 5 * 60 * 1000);
		});
	thumbnailCache.set(key, pending);
	return pending;
}

interface ExtractArgs {
	file: Blob;
	timestamp: number;
	width?: number;
}

/**
 * Grab a single frame as a JPEG data URL. Resolves null on any failure
 * (unsupported codec, decode error, timeout) — callers render a placeholder.
 */
export async function extractThumbnail({
	file,
	timestamp,
	width = THUMBNAIL_WIDTH,
}: ExtractArgs): Promise<string | null> {
	if (typeof document === "undefined") return null;

	const objectUrl = URL.createObjectURL(file);
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";
	video.src = objectUrl;

	try {
		await waitFor(video, "loadedmetadata", 8000);
		const seekTo = pickSeekTime(timestamp, video.duration);
		if (video.currentTime !== seekTo) {
			video.currentTime = seekTo;
			await waitFor(video, "seeked", 8000);
		}

		const ratio =
			video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = Math.max(1, Math.round(width / ratio));
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
		return canvas.toDataURL("image/jpeg", 0.72);
	} catch {
		return null;
	} finally {
		video.removeAttribute("src");
		video.load();
		URL.revokeObjectURL(objectUrl);
	}
}

function waitFor(el: HTMLVideoElement, event: string, timeoutMs: number) {
	return new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			el.removeEventListener(event, onEvent);
			el.removeEventListener("error", onError);
			clearTimeout(timer);
		};
		const onEvent = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error(`video ${event} failed`));
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`${event} timed out`));
		}, timeoutMs);
		el.addEventListener(event, onEvent, { once: true });
		el.addEventListener("error", onError, { once: true });
	});
}

interface ClipThumbArgs {
	assetId: string;
	file: Blob;
	timestamp: number;
}

/** Cached wrapper — one extraction per asset+timestamp across the session. */
export function getClipThumbnail({
	assetId,
	file,
	timestamp,
}: ClipThumbArgs): Promise<string | null> {
	return cachedThumbnail(thumbnailCacheKey(assetId, timestamp), () =>
		extractThumbnail({ file, timestamp }),
	);
}
