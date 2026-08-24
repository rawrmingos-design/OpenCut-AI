import type { TCanvasSize } from "@/types/project";

/**
 * SCRUM-74: compute a render-only canvas that matches the requested aspect.
 * Keeps the LONGER source dimension and re-derives the shorter one so a
 * landscape 16:9 project flips to 9:16 with no quality loss, and vice versa.
 */
export function resolveAspectCanvas({
	base,
	aspectOverride,
}: {
	base: TCanvasSize;
	aspectOverride: "16:9" | "9:16";
}): TCanvasSize {
	if (!Number.isFinite(base.width) || !Number.isFinite(base.height)) {
		return base;
	}
	const long = Math.max(base.width, base.height);
	return aspectOverride === "9:16"
		? { width: Math.round((long * 9) / 16), height: long }
		: { width: long, height: Math.round((long * 9) / 16) };
}
