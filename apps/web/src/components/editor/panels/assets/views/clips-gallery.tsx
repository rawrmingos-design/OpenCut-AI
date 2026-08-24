"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ClipCandidate } from "@/types/ai";
import { getClipThumbnail } from "@/lib/clip-thumbnails";

/**
 * SCRUM-73: OpusClip-style results gallery. Renders found clips as a
 * responsive thumbnail card grid with score tiers, duration badges and
 * per-card actions (preview / apply / export). Thumbnails are extracted
 * lazily per card so 10+ clips never block the first paint.
 */

export const GALLERY_MAX_CLIPS = 12;

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
}: {
	clip: ClipCandidate;
	index: number;
	thumbUrl: ThumbState;
	isProcessing: boolean;
	onPreview: (clip: ClipCandidate) => void;
	onApply: (clip: ClipCandidate) => void;
	onExport: (clip: ClipCandidate) => void;
}) {
	return (
		<div className="flex flex-col overflow-hidden rounded-lg border bg-card">
			<button
				type="button"
				className="relative block aspect-video w-full cursor-pointer overflow-hidden bg-muted"
				onClick={() => onPreview(clip)}
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
					className={`absolute right-1 top-1 rounded border px-1.5 py-0.5 text-[9px] font-semibold tabular-nums ${scoreTierClass(clip.score)}`}
				>
					{clip.score}/100
				</span>
				<span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-medium text-white tabular-nums">
					{formatDurationBadge(clip.end - clip.start)}
				</span>
			</button>

			<div className="flex flex-col gap-1 p-2">
				<p className="truncate text-[11px] font-medium" title={clip.title}>
					{index + 1}. {clip.title}
				</p>
				<Badge
					variant={clip.score >= 80 ? "default" : "secondary"}
					className="w-fit px-1.5 py-0 text-[9px]"
				>
					Score {clip.score}
				</Badge>
				{clip.reason && (
					<p className="line-clamp-2 text-[9px] leading-relaxed text-muted-foreground">
						{clip.reason}
					</p>
				)}
				<div className="mt-1 flex gap-1">
					<Button
						variant="outline"
						size="sm"
						type="button"
						className="h-6 flex-1 px-1 text-[10px]"
						disabled={isProcessing}
						onClick={() => onPreview(clip)}
					>
						Preview
					</Button>
					<Button
						variant="default"
						size="sm"
						type="button"
						className="h-6 flex-1 px-1 text-[10px]"
						disabled={isProcessing}
						onClick={() => onApply(clip)}
					>
						Apply
					</Button>
					<Button
						variant="outline"
						size="sm"
						type="button"
						className="h-6 flex-1 px-1 text-[10px]"
						disabled={isProcessing}
						onClick={() => onExport(clip)}
					>
						Export
					</Button>
				</div>
			</div>
		</div>
	);
}

function clipKey(clip: ClipCandidate): string {
	return `${clip.start}-${clip.end}`;
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
}: ClipsGalleryProps) {
	const visible = useMemo(() => clips.slice(0, GALLERY_MAX_CLIPS), [clips]);
	const [thumbs, setThumbs] = useState<Record<string, ThumbState>>({});

	useEffect(() => {
		let cancelled = false;

		// Seed every card into loading state in ONE update (no per-item setState).
		const seeded: Record<string, ThumbState> = {};
		for (const clip of visible) seeded[clipKey(clip)] = undefined;
		setThumbs(seeded);

		(async () => {
			for (const clip of visible) {
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
					setThumbs((prev) => ({ ...prev, [clipKey(clip)]: url }));
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [visible, mediaAssetId, mediaFile]);

	return (
		<div className="flex flex-col gap-2">
			{header}
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
				{visible.map((clip, idx) => (
					<ClipCard
						key={clipKey(clip)}
						clip={clip}
						index={idx}
						thumbUrl={thumbs[clipKey(clip)] ?? undefined}
						isProcessing={isProcessing}
						onPreview={onPreview}
						onApply={onApply}
						onExport={onExport}
					/>
				))}
			</div>
		</div>
	);
}
