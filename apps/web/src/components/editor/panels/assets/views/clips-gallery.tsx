"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ClipCandidate } from "@/types/ai";
import { getClipThumbnail } from "@/lib/clip-thumbnails";
import {
	adjustClipBound,
	computeTrimBounds,
	type ClipRange,
	type TrimBounds,
} from "@/lib/clip-trim-adjust";
import { MiniTrimScrubber } from "./mini-trim-scrubber";

/**
 * SCRUM-73: OpusClip-style results gallery. Renders found clips as a
 * responsive thumbnail card grid with score tiers, duration badges and
 * per-card actions (preview / apply / export). Thumbnails are extracted
 * lazily per card so 10+ clips never block the first paint.
 *
 * SCRUM-76: each card carries a mini trim scrubber bounded by
 * `[start - 5s, end + 5s]`. Adjustments update the working clip (preview /
 * apply / export all use the adjusted bounds) and trigger a debounced
 * re-score via the engagement endpoint.
 */

export const GALLERY_MAX_CLIPS = 12;

/** Debounce window for committing adjustments + re-scoring (ms). */
const RESCORE_DEBOUNCE_MS = 700;

function scoreTierClass(score: number): string {
	if (score >= 80) return "bg-emerald-500/90 text-white border-emerald-400";
	if (score >= 60) return "bg-amber-500/90 text-white border-amber-400";
	return "bg-zinc-600/90 text-white border-zinc-500";
}

export function formatDurationBadge(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	const m = Math.floor(s / 60);
	const rest = s % 60;
	return m > 0 ? `${m}:${rest.toString().padStart(2, "0")} min` : `${s}s`;
}

export interface ClipsGalleryProps {
	clips: ClipCandidate[];
	mediaAssetId: string | null;
	mediaFile: Blob | null;
	isProcessing: boolean;
	onPreview: (clip: ClipCandidate) => void;
	onApply: (clip: ClipCandidate) => void;
	onExport: (clip: ClipCandidate) => void;
	/** SCRUM-74: batch header (Export All + min-score filter) rendered above the grid. */
	header?: React.ReactNode;
	/** SCRUM-76: total media duration (seconds) clamping the scrubber window. */
	mediaTotalDuration?: number | null;
	/** SCRUM-76: commit an adjusted clip (replaces by gallery position). */
	onAdjustClip?: (index: number, next: ClipCandidate) => void;
	/** SCRUM-76: re-score an adjusted clip; returns the new score or null on failure. */
	rescoreClip?: (
		clip: ClipCandidate,
	) => Promise<{ score: number } | null>;
}

/** undefined = loading, null = extraction failed (placeholder), string = data URL */
type ThumbState = string | null | undefined;

function ClipCard({
	clip,
	index,
	thumbUrl,
	isProcessing,
	onPreview,
	onApply,
	onExport,
	mediaTotalDuration,
	onAdjustClip,
	rescoreClip,
}: {
	clip: ClipCandidate;
	index: number;
	thumbUrl: ThumbState;
	isProcessing: boolean;
	onPreview: (clip: ClipCandidate) => void;
	onApply: (clip: ClipCandidate) => void;
	onExport: (clip: ClipCandidate) => void;
	mediaTotalDuration: number | null;
	onAdjustClip?: (index: number, next: ClipCandidate) => void;
	rescoreClip?: (clip: ClipCandidate) => Promise<{ score: number } | null>;
}) {
	// SCRUM-76: local working range. Initialized once; subsequent edits come
	// from the scrubber. The parent's copy is updated on commit (debounced).
	const [draft, setDraft] = useState<ClipRange>({
		start: clip.start,
		end: clip.end,
	});
	const [displayScore, setDisplayScore] = useState(clip.score);
	const [isRescoring, setIsRescoring] = useState(false);
	const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (commitTimer.current) clearTimeout(commitTimer.current);
		};
	}, []);

	const bounds: TrimBounds = useMemo(
		() => computeTrimBounds({ clip, mediaTotalDuration }),
		[clip.start, clip.end, mediaTotalDuration],
	);

	const dirty =
		Math.abs(draft.start - clip.start) > 0.05 ||
		Math.abs(draft.end - clip.end) > 0.05;

	const adjusted: ClipCandidate = useMemo(
		() => ({ ...clip, start: draft.start, end: draft.end }),
		[clip, draft.start, draft.end],
	);

	const handleScrubChange = (range: ClipRange) => {
		const next =
			range.start === clip.end || range.end === clip.start
				? range // degenerate guard, shouldn't happen
				: range;
		const clamped = adjustClipBound({
			clip,
			bounds,
			edge:
				Math.abs(next.start - draft.start) >
				Math.abs(next.end - draft.end)
					? "start"
					: "end",
			value: Math.abs(next.start - draft.start) >
				Math.abs(next.end - draft.end)
				? next.start
				: next.end,
		});
		setDraft(clamped);

		// Debounce commit + re-score so drags don't spam the backend.
		if (!onAdjustClip) return;
		if (commitTimer.current) clearTimeout(commitTimer.current);
		commitTimer.current = setTimeout(async () => {
			const committed: ClipCandidate = { ...clip, ...clamped };
			onAdjustClip(index, committed);
			if (!rescoreClip) return;
			setIsRescoring(true);
			const result = await rescoreClip(committed);
			if (result) setDisplayScore(result.score);
			setIsRescoring(false);
		}, RESCORE_DEBOUNCE_MS);
	};

	return (
		<div className="flex flex-col overflow-hidden rounded-lg border bg-card">
			<button
				type="button"
				className="relative block aspect-video w-full cursor-pointer overflow-hidden bg-muted"
				onClick={() => onPreview(adjusted)}
				title={`Preview ${clip.title}`}
			>
				{thumbUrl ? (
					<img
						src={thumbUrl}
						alt={`${clip.title} thumbnail`}
						className="h-full w-full object-cover"
						loading="lazy"
					/>
				) : thumbUrl === null ? (
					<span className="flex h-full w-full items-center justify-center text-[10px] text-muted-foreground">
						No preview
					</span>
				) : (
					<span className="flex h-full w-full items-center justify-center">
						<Spinner className="size-4" />
					</span>
				)}
				<span
					className={`absolute right-1 top-1 flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-semibold tabular-nums ${scoreTierClass(displayScore)}`}
				>
					{isRescoring && <Spinner className="size-2" />}
					{displayScore}/100
				</span>
				<span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-medium text-white tabular-nums">
					{formatDurationBadge(draft.end - draft.start)}
				</span>
			</button>

			<div className="flex flex-col gap-1 p-2">
				<p className="truncate text-[11px] font-medium" title={clip.title}>
					{index + 1}. {clip.title}
				</p>
				<Badge
					variant={displayScore >= 80 ? "default" : "secondary"}
					className="w-fit px-1.5 py-0 text-[9px]"
				>
					Score {displayScore}
				</Badge>
				{clip.reason && (
					<p className="line-clamp-2 text-[9px] leading-relaxed text-muted-foreground">
						{clip.reason}
					</p>
				)}

				{/* SCRUM-76: mini trim scrubber */}
				{onAdjustClip && (
					<div className="mt-0.5">
						<MiniTrimScrubber
							clip={draft}
							bounds={bounds}
							onChange={handleScrubChange}
							disabled={isProcessing}
						/>
					</div>
				)}
				{dirty && !onAdjustClip && (
					<p className="text-[9px] text-muted-foreground">
						{draft.start.toFixed(1)}s – {draft.end.toFixed(1)}s
					</p>
				)}

				<div className="mt-1 flex gap-1">
					<Button
						variant="outline"
						size="sm"
						type="button"
						className="h-6 flex-1 px-1 text-[10px]"
						disabled={isProcessing}
						onClick={() => onPreview(adjusted)}
					>
						Preview
					</Button>
					<Button
						variant="default"
						size="sm"
						type="button"
						className="h-6 flex-1 px-1 text-[10px]"
						disabled={isProcessing}
						onClick={() => onApply(adjusted)}
					>
						Apply
					</Button>
					<Button
						variant="outline"
						size="sm"
						type="button"
						className="h-6 flex-1 px-1 text-[10px]"
						disabled={isProcessing}
						onClick={() => onExport(adjusted)}
					>
						Export
					</Button>
				</div>
			</div>
		</div>
	);
}

export function ClipsGallery({
	clips,
	mediaAssetId,
	mediaFile,
	isProcessing,
	onPreview,
	onApply,
	onExport,
	header,
	mediaTotalDuration = null,
	onAdjustClip,
	rescoreClip,
}: ClipsGalleryProps) {
	const visible = useMemo(() => clips.slice(0, GALLERY_MAX_CLIPS), [clips]);
	const [thumbs, setThumbs] = useState<Record<number, ThumbState>>({});

	useEffect(() => {
		let cancelled = false;

		// Seed every card into loading state in ONE update (no per-item setState).
		const seeded: Record<number, ThumbState> = {};
		for (let i = 0; i < visible.length; i++) seeded[i] = undefined;
		setThumbs(seeded);

		(async () => {
			for (let i = 0; i < visible.length; i++) {
				const clip = visible[i];
				if (cancelled) return;
				let url: ThumbState = null;
				if (mediaAssetId && mediaFile) {
					url = await getClipThumbnail({
						assetId: mediaAssetId,
						file: mediaFile,
						timestamp:
							clip.start + Math.min(0.5, (clip.end - clip.start) * 0.1),
					});
				}
				if (!cancelled) {
					setThumbs((prev) => ({ ...prev, [i]: url }));
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [visible, mediaAssetId, mediaFile]);

	// Thumbnail timestamps track the ORIGINAL clip bounds; adjustments only
	// move ±5s inside the window, so no re-extraction is needed on drag.

	return (
		<div className="flex flex-col gap-2">
			{header}
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
				{visible.map((clip, idx) => (
					<ClipCard
						key={`${clip.title}-${idx}`}
						clip={clip}
						index={idx}
						thumbUrl={thumbs[idx] ?? undefined}
						isProcessing={isProcessing}
						onPreview={onPreview}
						onApply={onApply}
						onExport={onExport}
						mediaTotalDuration={mediaTotalDuration}
						onAdjustClip={onAdjustClip}
						rescoreClip={rescoreClip}
					/>
				))}
			</div>
		</div>
	);
}
