import { describe, expect, it } from "bun:test";

import {
	formatDurationBadge,
	GALLERY_MAX_CLIPS,
} from "@/components/editor/panels/assets/views/clips-gallery";
import {
	cachedThumbnail,
	clearThumbnailCache,
	pickSeekTime,
	thumbnailCacheKey,
} from "@/lib/clip-thumbnails";

describe("clip-thumbnails", () => {
	it("builds stable cache keys per asset+timestamp", () => {
		expect(thumbnailCacheKey("a1", 12.32)).toBe("a1@12.3");
		expect(thumbnailCacheKey("a1", 12.38)).toBe("a1@12.4");
	});

	it("clamps seek time into the decodable range", () => {
		expect(pickSeekTime(-5, 30)).toBe(0);
		expect(pickSeekTime(45, 30)).toBeCloseTo(29.9, 1);
		expect(pickSeekTime(10, 0)).toBe(0);
	});

	it("deduplicates concurrent extractions via the cache", async () => {
		clearThumbnailCache();
		let calls = 0;
		const factory = async () => {
			calls += 1;
			return "data:image/jpeg;base64,frame";
		};

		const [a, b] = await Promise.all([
			cachedThumbnail("k1", factory),
			cachedThumbnail("k1", factory),
		]);

		expect(calls).toBe(1);
		expect(a).toBe(b);
	});

	it("caches failures as null without throwing", async () => {
		clearThumbnailCache();
		const result = await cachedThumbnail("bad", async () => {
			throw new Error("decode failed");
		});
		expect(result).toBeNull();
	});
});

describe("gallery helpers", () => {
	it("formats duration badges compactly", () => {
		expect(formatDurationBadge(45)).toBe("45s");
		expect(formatDurationBadge(75)).toBe("1:15 min");
		expect(formatDurationBadge(0)).toBe("0s");
	});

	it("caps the visible grid", () => {
		expect(GALLERY_MAX_CLIPS).toBeLessThanOrEqual(12);
	});
});
