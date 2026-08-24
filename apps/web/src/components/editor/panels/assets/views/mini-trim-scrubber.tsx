"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	KEYBOARD_NUDGE_SECONDS,
	type ClipRange,
	type TrimBounds,
} from "@/lib/clip-trim-adjust";
import { formatDurationBadge } from "./clips-gallery";

/**
 * SCRUM-76: OpusClip-style mini trim scrubber on gallery cards.
 * Two draggable handles over `[clip.start - 5s, clip.end + 5s]`; arrow keys
 * nudge the focused handle by ±0.5s. Emits raw adjusted ranges upward —
 * clamping against min/max duration lives in clip-trim-adjust.ts.
 */

interface MiniTrimScrubberProps {
	clip: ClipRange;
	bounds: TrimBounds;
	/** Fires during drag and on key nudges; caller debounces re-scoring. */
	onChange: (range: ClipRange) => void;
	disabled?: boolean;
}

const HANDLE_WIDTH_PX = 12;

export function MiniTrimScrubber({
	clip,
	bounds,
	onChange,
	disabled,
}: MiniTrimScrubberProps) {
	const trackRef = useRef<HTMLDivElement>(null);
	/** Which handle keyboard focus sits on; null = none focused. */
	const [focusEdge, setFocusEdge] = useState<"start" | "end" | null>(null);
	const [dragEdge, setDragEdge] = useState<"start" | "end" | null>(null);

	const windowSpan = Math.max(0.1, bounds.max - bounds.min);

	const pct = useCallback(
		(t: number) =>
			Math.min(100, Math.max(0, ((t - bounds.min) / windowSpan) * 100)),
		[bounds.min, windowSpan],
	);

	const timeFromClientX = useCallback(
		(clientX: number): number => {
			const el = trackRef.current;
			if (!el) return clip.start;
			const rect = el.getBoundingClientRect();
			const usable = Math.max(1, rect.width - HANDLE_WIDTH_PX);
			const ratio = Math.min(
				1,
				Math.max(0, (clientX - rect.left - HANDLE_WIDTH_PX / 2) / usable),
			);
			return bounds.min + ratio * windowSpan;
		},
		[bounds.min, windowSpan, clip.start],
	);

	const beginDrag = useCallback(
		(edge: "start" | "end") => (e: React.PointerEvent) => {
			if (disabled) return;
			e.preventDefault();
			e.stopPropagation();
			setDragEdge(edge);
			try {
				trackRef.current?.setPointerCapture?.(e.pointerId);
			} catch {
				// pointer capture is best-effort; window listeners cover the rest
			}
		},
		[disabled],
	);

	useEffect(() => {
		if (!dragEdge) return;
		const move = (e: PointerEvent) => {
			e.preventDefault();
			onChange(
				dragEdge === "start"
					? { start: timeFromClientX(e.clientX), end: clip.end }
					: { start: clip.start, end: timeFromClientX(e.clientX) },
			);
		};
		const up = () => setDragEdge(null);
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		return () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
	}, [dragEdge, onChange, timeFromClientX, clip.start, clip.end]);

	const onKeyDown =
		(edge: "start" | "end") => (e: React.KeyboardEvent<HTMLButtonElement>) => {
			if (disabled) return;
			let dir: -1 | 1 | null = null;
			if (e.key === "ArrowLeft" || e.key === "ArrowDown") dir = -1;
			else if (e.key === "ArrowRight" || e.key === "ArrowUp") dir = 1;
			else if (e.key === "Home") {
				e.preventDefault();
				onChange(
					edge === "start"
						? { start: bounds.min, end: clip.end }
						: { start: clip.start, end: Math.max(bounds.min, clip.start) },
				);
				return;
			} else if (e.key === "End") {
				e.preventDefault();
				onChange(
					edge === "start"
						? { start: Math.min(bounds.max, clip.end), end: clip.end }
						: { start: clip.start, end: bounds.max },
				);
				return;
			}
			if (dir !== null) {
				e.preventDefault();
				e.stopPropagation();
				const base = edge === "start" ? clip.start : clip.end;
				onChange(
					edge === "start"
						? { start: base + dir * KEYBOARD_NUDGE_SECONDS, end: clip.end }
						: { start: clip.start, end: base + dir * KEYBOARD_NUDGE_SECONDS },
				);
			}
		};

	return (
		<div className="flex flex-col gap-1">
			<div
				ref={trackRef}
				className="relative h-4 w-full touch-none select-none rounded-sm bg-muted/60"
			>
				{/* Selected range highlight */}
				<div
					className="absolute top-0 h-full rounded-sm bg-emerald-500/25"
					style={{
						left: `${pct(Math.min(clip.start, clip.end))}%`,
						width: `${Math.max(1.5, pct(clip.end) - pct(clip.start))}%`,
					}}
				/>
				{/* Start handle */}
				<button
					type="button"
					role="slider"
					aria-label="Adjust clip start"
					aria-valuemin={bounds.min}
					aria-valuemax={clip.end}
					aria-valuenow={Number(clip.start.toFixed(1))}
					aria-valuetext={`Start at ${clip.start.toFixed(1)} seconds`}
					disabled={disabled}
					className={`absolute top-0 h-full w-3 rounded-l-sm border transition-colors ${
						focusEdge === "start"
							? "border-emerald-600 bg-emerald-500"
							: "border-emerald-700/50 bg-emerald-500/80 hover:bg-emerald-500"
					}`}
					style={{
						left: `calc(${pct(clip.start)}% - ${HANDLE_WIDTH_PX / 2}px)`,
					}}
					onPointerDown={beginDrag("start")}
					onFocus={() => setFocusEdge("start")}
					onBlur={() => setFocusEdge(null)}
					onKeyDown={onKeyDown("start")}
				/>
				{/* End handle */}
				<button
					type="button"
					role="slider"
					aria-label="Adjust clip end"
					aria-valuemin={clip.start}
					aria-valuemax={bounds.max}
					aria-valuenow={Number(clip.end.toFixed(1))}
					aria-valuetext={`End at ${clip.end.toFixed(1)} seconds`}
					disabled={disabled}
					className={`absolute top-0 h-full w-3 rounded-r-sm border transition-colors ${
						focusEdge === "end"
							? "border-emerald-600 bg-emerald-500"
							: "border-emerald-700/50 bg-emerald-500/80 hover:bg-emerald-500"
					}`}
					style={{
						left: `calc(${pct(clip.end)}% - ${HANDLE_WIDTH_PX / 2}px)`,
					}}
					onPointerDown={beginDrag("end")}
					onFocus={() => setFocusEdge("end")}
					onBlur={() => setFocusEdge(null)}
					onKeyDown={onKeyDown("end")}
				/>
			</div>
			<div className="flex items-center justify-between text-[9px] tabular-nums text-muted-foreground">
				<span>in {formatDurationBadge(clip.start)}</span>
				<span>{windowSpan.toFixed(0)}s window</span>
				<span>out {formatDurationBadge(clip.end)}</span>
			</div>
		</div>
	);
}
