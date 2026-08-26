"use client";

import { useCallback, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-view";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useTranscriptStore } from "@/stores/transcript-store";
import { useBackgroundTasksStore } from "@/stores/background-tasks-store";
import { useEditor } from "@/hooks/use-editor";
import { aiClient } from "@/lib/ai-client";
import { toast } from "sonner";
import {
	POPOVER_SUBTITLE_PRESETS,
	buildPopoverSubtitleElements,
	distributeElementsToTracks,
	type PopoverSubtitlePreset,
} from "@/lib/podcast/subtitle-presets";
import { buildQuestionCardElement, QUESTION_CARD_TEMPLATES } from "@/lib/templates/question-card";
import { buildHookTextElement, HOOK_TEXT_DEFAULT_DURATION } from "@/lib/podcast/hook-text";
import type { ClipCandidate, QuestionCard, } from "@/types/ai";
import { hasMediaId } from "@/lib/timeline";
import { trimTimelineToRange } from "@/lib/timeline-edits";
import { useExportQueueStore } from "@/stores/export-queue-store";
import { DEFAULT_EXPORT_OPTIONS } from "@/constants/export-constants";
import {
	BATCH_EXPORT_DEFAULTS,
	buildBatchExportJobs,
	queueBatchExportJobs,
} from "@/lib/batch-export";
import { ClipsGallery } from "./clips-gallery";
import { buildTranscriptSlice } from "@/lib/clip-trim-adjust";
import type { TimelineElement } from "@/types/timeline";

export function PodcastClipsView() {
	const segments = useTranscriptStore((s) => s.segments);
	const editor = useEditor();
	const bgTasks = useBackgroundTasksStore();
	const addExportJob = useExportQueueStore((s) => s.addJob);

	// SCRUM-73: media backing the gallery thumbnails
	const [galleryAsset, setGalleryAsset] = useState<{
		id: string;
		file: Blob;
	} | null>(null);
	const [batchMinScore, setBatchMinScore] = useState(0);

	// SCRUM-76: media duration clamp for mini trim scrubbers
	const [mediaTotalDuration, setMediaTotalDuration] = useState<
		number | null
	>(null);

	// Clip finder state
	const [clips, setClips] = useState<ClipCandidate[]>([]);
	const [isFindingClips, setIsFindingClips] = useState(false);
	const activeClipTaskId = useRef<string | null>(null);
	// SCRUM-78: backend job id for the in-flight find-clips request.
	const activeClipJobIdRef = useRef<string | null>(null);
	const [isApplying, setIsApplying] = useState(false);

	// Subtitle style
	const [subtitlePreset, setSubtitlePreset] = useState<PopoverSubtitlePreset>("hormozi");

	// Apply behavior
	const [switchToVertical, setSwitchToVertical] = useState(true);

	// Feature toggles
	const [enableQuestionCards, setEnableQuestionCards] = useState(true);
	const [enableKeywordHighlight, setEnableKeywordHighlight] = useState(true);
	const [enableHookText, setEnableHookText] = useState(true);
	const [cardTemplate, setCardTemplate] = useState("overlay");
	const [cardTransparentBg, setCardTransparentBg] = useState(true);

	// Generated data
	const [questionCards, setQuestionCards] = useState<QuestionCard[]>([]);
	const [keywords, setKeywords] = useState<{ word: string; color: string }[]>([]);

	const hasTranscript = segments.length > 0;
	const [isReframing, setIsReframing] = useState(false);
	const speakerPositions = useTranscriptStore((s) => s.speakerPositions);

	// ── Auto-Reframe 16:9 → 9:16 (background task) ──
	const handleAutoReframe = useCallback(async () => {
		const taskId = `auto-reframe-${Date.now()}`;
		setIsReframing(true);

		bgTasks.addTask({
			id: taskId,
			type: "popover-subs",
			label: "Auto-reframe 9:16",
			progress: "Finding media file...",
		});

		try {
			// Find media file
			const tracks = editor.timeline.getTracks();
			let foundMediaId: string | null = null;
			for (const track of tracks) {
				for (const element of track.elements) {
					if (
						(track.type === "video" || track.type === "audio") &&
						hasMediaId(element as TimelineElement)
					) {
						foundMediaId = (element as TimelineElement & { mediaId: string }).mediaId;
						break;
					}
				}
				if (foundMediaId) break;
			}

			if (!foundMediaId) {
				bgTasks.updateTask(taskId, { status: "error", error: "No video found on timeline.", completedAt: Date.now() });
				return;
			}

			const mediaAsset = editor.media.getAssets().find((a) => a.id === foundMediaId);
			if (!mediaAsset?.file) {
				bgTasks.updateTask(taskId, { status: "error", error: "Cannot access media file.", completedAt: Date.now() });
				return;
			}

			bgTasks.updateTask(taskId, { progress: "Detecting faces..." });

			let file = mediaAsset.file;
			if (!file.name?.includes(".")) {
				file = new File([file], `media.mp4`, { type: file.type || "video/mp4" });
			}

			const faceResult = await aiClient.detectFaces(file, { sampleInterval: 0.5 });

			if (faceResult.total_faces_detected === 0) {
				bgTasks.updateTask(taskId, { status: "completed", progress: "No faces detected", completedAt: Date.now() });
				return;
			}

			bgTasks.updateTask(taskId, { progress: "Applying crop transforms..." });

			// Change canvas to 9:16
			const canvasSize = editor.project.getActive().settings.canvasSize;
			const isAlreadyVertical = canvasSize.height > canvasSize.width;

			// Compute per-segment face positions based on speaker diarization
			const storeSegs = useTranscriptStore.getState().segments;
			const videoTracks = editor.timeline.getTracks().filter((t) => t.type === "video");

			for (const track of videoTracks) {
				for (const el of track.elements) {
					const videoEl = el as TimelineElement & { transform?: { scale: number; position: { x: number; y: number }; rotate: number } };
					if (!videoEl.transform) continue;

					// Find the dominant face position for this element's time range
					const elStart = el.startTime;
					const elEnd = el.startTime + el.duration;

					// Find which speaker is active during this element
					const activeSeg = storeSegs.find((seg) => seg.start < elEnd && seg.end > elStart);
					const speakerId = activeSeg?.speaker;
					const position = speakerId ? (speakerPositions[speakerId] ?? "center") : "center";

					// Find face frames within this element's time range
					const relevantFrames = faceResult.frames.filter(
						(f) => f.timestamp >= elStart && f.timestamp <= elEnd && f.faces.length > 0,
					);

					let targetX = 0.5; // center
					let targetY = 0.4; // slightly above center

					if (relevantFrames.length > 0) {
						// Average face center across relevant frames
						let sumX = 0;
						let sumY = 0;
						let count = 0;
						for (const frame of relevantFrames) {
							// Pick the face closest to the expected position
							const face = position === "left"
								? frame.faces.reduce((a, b) => (a.x < b.x ? a : b))
								: position === "right"
									? frame.faces.reduce((a, b) => (a.x + a.width > b.x + b.width ? a : b))
									: frame.faces[0];
							sumX += face.x + face.width / 2;
							sumY += face.y + face.height / 2;
							count++;
						}
						targetX = sumX / count;
						targetY = sumY / count;
					}

					if (!isAlreadyVertical) {
						// Apply crop: scale up to fill 9:16 and offset to center on face
						const scaleNeeded = canvasSize.width / (canvasSize.height * (9 / 16));
						const offsetX = (targetX - 0.5) * canvasSize.width * -scaleNeeded;
						const offsetY = (targetY - 0.5) * canvasSize.height * -0.5;

						editor.timeline.updateElements({
							updates: [{
								trackId: track.id,
								elementId: el.id,
								updates: {
									transform: {
										scale: Math.max(scaleNeeded, 1.5),
										position: { x: offsetX, y: offsetY },
										rotate: 0,
									},
								},
							}],
						});
					}
				}
			}

			bgTasks.updateTask(taskId, {
				status: "completed",
				progress: `Reframed ${faceResult.total_faces_detected} faces across ${faceResult.frames.length} frames`,
				completedAt: Date.now(),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Auto-reframe failed";
			let detail = message;
			if (message.includes("404")) detail = "Face endpoint not found. Restart the AI backend.";
			else if (message.includes("503")) detail = "Face service not running. Start with: docker compose up -d face-service";
			else if (message.includes("Cannot connect")) detail = "AI backend not reachable.";
			bgTasks.updateTask(taskId, { status: "error", error: detail, completedAt: Date.now() });
		} finally {
			setIsReframing(false);
		}
	}, [editor, bgTasks, speakerPositions]);

	// ── Find Best Clips (background task) ──
	const handleFindClips = useCallback(() => {
		if (!hasTranscript) return;

		const startFindClips = (controller: AbortController, taskId: string) => {
			activeClipTaskId.current = taskId;
			activeClipJobIdRef.current = null;
			setIsFindingClips(true);
			bgTasks.addTask({
				id: taskId,
				type: "clip-finder",
				label: "Find best clips",
				progress: "Preparing analysis...",
				// SCRUM-78: Cancel also cancels the server-side LLM job so
				// CPU-bound Ollama work stops even after the fetch aborts.
				cancel: () => {
					controller.abort();
					const jobId = activeClipJobIdRef.current;
					if (jobId) void aiClient.cancelLLMJob(jobId).catch(() => {});
				},
				retry: () =>
					startFindClips(
						new AbortController(),
						`clip-finder-${Date.now()}`,
					),
			});

			void (async () => {
				try {
					// SCRUM-75: decode audio energy client-side (WebAudio) so the
					// backend can blend real RMS signal into the ranking. Best-effort:
					// decode failure just means the energy signal is reported missing.
					let energyCurve: number[] | undefined;
					try {
						const sourceElement = editor.timeline
							.getTracks()
							.flatMap((track) => track.elements as TimelineElement[])
							.find((element) => hasMediaId(element));
						const mediaId = sourceElement && hasMediaId(sourceElement)
							? sourceElement.mediaId
							: null;
						const asset = mediaId
							? editor.media.getAssets().find((a) => a.id === mediaId)
							: null;
						if (asset?.file) {
							const { extractEnergyCurve } = await import("@/lib/audio-energy");
							const extraction = extractEnergyCurve(asset.file);
							const timeout = new Promise<never>((_, reject) => {
								window.setTimeout(
									() => reject(new Error("Audio energy decode timed out")),
									15_000,
								);
							});
							energyCurve = await Promise.race([extraction, timeout]);
						}
					} catch {
						energyCurve = undefined;
					}

					if (controller.signal.aborted) return;
					// SCRUM-78: surface queue position and lifecycle state from
					// backend job frames instead of a static spinner label.
					const applyJobUpdate = (job: {
						jobId?: string;
						state?: string;
						queuePosition?: number;
					}) => {
						// A late frame from a cancelled run must not overwrite the
						// backend job id owned by a newer retry.
						if (activeClipTaskId.current !== taskId) return;
						if (job.jobId) activeClipJobIdRef.current = job.jobId;
						let progressText: string | null = null;
						if (job.state === "queued") {
							progressText =
								job.queuePosition && job.queuePosition > 0
									? `Queued (position ${job.queuePosition})...`
									: "Queued...";
						} else if (job.state === "running") {
							progressText = "Analyzing transcript with AI...";
						} else if (job.state === "finalizing") {
							progressText = "Finalizing clips...";
						}
						if (progressText) bgTasks.updateTask(taskId, { progress: progressText });
					};
					const result = await aiClient.findClips(segments, {
						energyCurve,
						signal: controller.signal,
						onJobUpdate: applyJobUpdate,
					});
					activeClipJobIdRef.current = null;

					// A cancelled task must not accept late results.
					if (controller.signal.aborted) return;
					setClips(result.clips);

					// Resolve one source media file for lazy gallery thumbnails.
					const sourceElement = editor.timeline
						.getTracks()
						.flatMap((track) => track.elements as TimelineElement[])
						.find((element) => hasMediaId(element));
					const sourceMediaId = sourceElement && hasMediaId(sourceElement)
						? sourceElement.mediaId
						: null;
					const sourceAsset = sourceMediaId
						? editor.media.getAssets().find((asset) => asset.id === sourceMediaId)
						: null;
					setGalleryAsset(
						sourceAsset?.file && sourceMediaId
							? { id: sourceMediaId, file: sourceAsset.file }
							: null,
					);

					const assetDuration = (sourceAsset as { duration?: number } | undefined)
						?.duration;
					if (typeof assetDuration === "number" && assetDuration > 0) {
						setMediaTotalDuration(assetDuration);
					} else {
						const maxSegEnd = segments.reduce(
							(max, seg) => Math.max(max, seg.end),
							0,
						);
						setMediaTotalDuration(maxSegEnd > 0 ? maxSegEnd : null);
					}

					bgTasks.updateTask(taskId, {
						status: "completed",
						progress:
							result.clips.length === 0
								? "No high-scoring clips found"
								: `${result.clips.length} clips found`,
						completedAt: Date.now(),
					});
				} catch (err) {
					if (controller.signal.aborted) return;

					const message =
						err instanceof Error ? err.message : "Failed to find clips";
					const detail = message.includes("Cannot connect") || message.includes("connection_refused")
						? "Cannot connect to AI backend. Make sure it is running with Ollama (docker compose up -d)."
						: message.includes("503")
							? "Ollama LLM is not available. Start it with: docker compose up -d ollama"
							: message;
					bgTasks.updateTask(taskId, {
						status: "failed",
						error: detail,
						completedAt: Date.now(),
					});
				} finally {
					// SCRUM-77: only clear the spinner when THIS task still owns the
					// panel — a retry already started a newer run with its own task.
					if (activeClipTaskId.current === taskId) {
						setIsFindingClips(false);
					}
				}
			})();
		};

		startFindClips(
			new AbortController(),
			`clip-finder-${Date.now()}`,
		);
	}, [segments, hasTranscript, editor, bgTasks]);

	// ── Preview Clip (seek to time) ──
	const handlePreviewClip = useCallback(
		(clip: ClipCandidate) => {
			editor.playback.seek({ time: clip.start });
			toast.info(`Seeking to ${clip.title}`, {
				description: `${clip.start.toFixed(1)}s - ${clip.end.toFixed(1)}s`,
			});
		},
		[editor],
	);

	// ── Export Clip (ranged export via SCRUM-71 queue) ──
	const handleExportClip = useCallback(
		(clip: ClipCandidate) => {
			const activeProject = editor.project.getActive();
			if (!activeProject) {
				toast.error("No active project");
				return;
			}
			addExportJob({
				projectId: activeProject.metadata.id,
				projectName: activeProject.metadata.name,
				options: {
					format: DEFAULT_EXPORT_OPTIONS.format,
					quality: DEFAULT_EXPORT_OPTIONS.quality,
					fps: activeProject.settings.fps,
					includeAudio: DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
					start: clip.start,
					end: clip.end,
				},
			});
			toast.info(`Queued export: ${clip.title}`, {
				description: `${clip.start.toFixed(1)}s – ${clip.end.toFixed(1)}s`,
			});
		},
		[editor, addExportJob],
	);

	// ── Export All (SCRUM-74: one-click batch queue) ──
	const handleExportAllClips = useCallback(() => {
		const activeProject = editor.project.getActive();
		if (!activeProject) {
			toast.error("No active project");
			return;
		}
		const plans = buildBatchExportJobs({
			projectName: activeProject.metadata.name,
			clips,
			fps: activeProject.settings.fps,
			minScore: batchMinScore,
			aspectOverride: BATCH_EXPORT_DEFAULTS.aspectOverride,
		});
		if (plans.length === 0) {
			toast.info("No clips match the score filter");
			return;
		}
		queueBatchExportJobs({
			addJob: addExportJob,
			projectId: activeProject.metadata.id,
			plans,
		});
		toast.success(`${plans.length} exports queued`, {
			description: "9:16 renders — progress in the render queue",
		});
	}, [editor, clips, addExportJob, batchMinScore]);

	// ── Mini trim adjustments (SCRUM-76) ──
	const handleAdjustClip = useCallback((index: number, next: ClipCandidate) => {
		setClips((prev) => {
			if (!prev[index]) return prev;
			const copy = prev.slice();
			copy[index] = next;
			return copy;
		});
	}, []);

	const handleRescoreClip = useCallback(
		async (clip: ClipCandidate): Promise<{ score: number } | null> => {
			try {
				const transcriptText =
					buildTranscriptSlice(segments, clip.start, clip.end) ||
					clip.reason;
				const result = await aiClient.engagementScore({
					transcript_text: transcriptText,
					start: clip.start,
					end: clip.end,
					title: clip.title,
				});
				const composite = Number(result?.composite);
				if (!Number.isFinite(composite)) return null;
				return { score: Math.max(0, Math.min(100, Math.round(composite))) };
			} catch {
				// Re-scoring is best-effort; keep the previous score on failure.
				return null;
			}
		},
		[segments],
	);

	// ── Apply Clip (generate subtitle elements — background task) ──
	const handleApplyClip = useCallback(
		async (clip: ClipCandidate) => {
			const taskId = `apply-clip-${Date.now()}`;
			setIsApplying(true);

			bgTasks.addTask({
				id: taskId,
				type: "popover-subs",
				label: `Apply: ${clip.title}`,
				progress: "Preparing clip segments...",
			});

			try {
				// Filter segments to the clip's time range
				const clipSegments = segments
					.filter((seg) => seg.start < clip.end && seg.end > clip.start)
					.map((seg) => ({
						text: seg.text,
						start: Math.max(seg.start, clip.start),
						end: Math.min(seg.end, clip.end),
						words: seg.words
							.filter((w) => w.start >= clip.start && w.end <= clip.end)
							.map((w) => ({
								word: w.word,
								start: w.start,
								end: w.end,
								confidence: w.confidence,
							})),
					}));

				// Extract keywords if enabled
				let clipKeywords: { word: string; color: string }[] = [];
				if (enableKeywordHighlight) {
					try {
						bgTasks.updateTask(taskId, { progress: "Extracting keywords..." });
						const kwResult = await aiClient.extractKeywords(
							clipSegments.map((s, i) => ({
								id: i,
								text: s.text,
								start: s.start,
								end: s.end,
								words: s.words,
							})),
						);
						clipKeywords = kwResult.keywords;
						setKeywords(clipKeywords);
					} catch {
						// Continue without keywords
					}
				}

				// Generate question cards if enabled
				let cards: QuestionCard[] = [];
				if (enableQuestionCards) {
					try {
						bgTasks.updateTask(taskId, { progress: "Generating topic cards..." });
						const cardsResult = await aiClient.generateQuestionCards(
							clipSegments.map((s, i) => ({
								id: i,
								text: s.text,
								start: s.start,
								end: s.end,
								words: s.words,
							})),
							2,
						);
						cards = cardsResult.cards;
						setQuestionCards(cards);
					} catch {
						// Continue without cards
					}
				}

				bgTasks.updateTask(taskId, { progress: "Adding to timeline..." });
				const canvasSize = editor.project.getActive().settings.canvasSize;

				// Build card time ranges so subtitles can skip them
				const cardRanges = cards.map((c) => ({ start: c.timestamp, end: c.timestamp + 2.5 }));

				// Build popover elements (skipping card time ranges)
				const subtitleElements = buildPopoverSubtitleElements({
					segments: clipSegments,
					preset: subtitlePreset,
					canvasHeight: canvasSize.height,
					canvasWidth: canvasSize.width,
					keywords: clipKeywords,
					cardTimeRanges: cardRanges,
				});

				// Distribute across multiple tracks so overlapping words are all visible
				const trackBuckets = distributeElementsToTracks(subtitleElements);

				bgTasks.updateTask(taskId, { progress: "Trimming timeline to clip range..." });

				// Real trim: cut the timeline down to [clip.start, clip.end] as one
				// undoable transaction. Everything outside is excised; survivors are
				// compacted so the clip starts at t=0.
				const supportsTransaction =
					typeof editor.command.beginTransaction === "function";
				if (supportsTransaction) editor.command.beginTransaction();
				try {
					trimTimelineToRange(editor, { start: clip.start, end: clip.end });
				} finally {
					if (supportsTransaction) editor.command.commitTransaction();
				}

				// Subtitles/cards were authored in source-video time; shift them to
				// the trimmed timeline (t=0 base). Text tracks were NOT touched by
				// the trim (only media/audio/video), so a pure rebase is safe.
				const trimOffset = clip.start;
				const rebasedBuckets = trackBuckets.map((bucket) =>
					bucket.map((el) => ({
						...el,
						startTime: Math.max(0, el.startTime - trimOffset),
					})),
				);

				for (let t = 0; t < rebasedBuckets.length; t++) {
					const subTrackId = editor.timeline.addTrack({ type: "text", index: 0 });
					const label = rebasedBuckets.length === 1
						? "Popover Subs"
						: `Popover Subs ${t + 1}`;
					editor.timeline.renameTrack({ trackId: subTrackId, name: label });

					for (const el of rebasedBuckets[t]) {
						editor.timeline.insertElement({
							placement: { mode: "explicit", trackId: subTrackId },
							element: el,
						});
					}
				}

				// Add question card track if cards were generated (timestamps
				// rebased to the trimmed timeline as well)
				if (cards.length > 0) {
					const cardTrackId = editor.timeline.addTrack({ type: "text", index: 0 });
					editor.timeline.renameTrack({ trackId: cardTrackId, name: "Topic Cards" });

					for (const card of cards) {
						const cardElement = buildQuestionCardElement({
							question: card.question,
							startTime: Math.max(0, card.timestamp - trimOffset),
							theme: cardTemplate,
							emoji: card.emoji,
							useTransparentBackground: cardTransparentBg,
						});
						editor.timeline.insertElement({
							placement: { mode: "explicit", trackId: cardTrackId },
							element: cardElement,
						});
					}
				}

				// Optional: flip the canvas to vertical for the new short clip
				if (switchToVertical) {
					const activeProject = editor.project.getActive();
					const size = activeProject.settings.canvasSize;
					if (size.width > size.height) {
						const height = Math.min(size.width, 1920);
						editor.project.updateSettings({
							settings: {
								canvasSize: {
									width: Math.round((height * 9) / 16),
									height,
								},
							},
						});
					}
				}

				// SCRUM-80: burn the clip title as an opening hook. Runs after
				// the canvas resize so upper-third placement uses the final
				// (vertical) canvas dimensions.
				let hookAdded = false;
				if (enableHookText && clip.title.trim().length > 0) {
					const finalSize = editor.project.getActive().settings.canvasSize;
					const hookElement = buildHookTextElement({
						title: clip.title,
						startTime: 0,
						duration: HOOK_TEXT_DEFAULT_DURATION,
						canvasWidth: finalSize.width,
						canvasHeight: finalSize.height,
					});
					const hookTrackId = editor.timeline.addTrack({ type: "text", index: 0 });
					editor.timeline.renameTrack({ trackId: hookTrackId, name: "Hook Text" });
					editor.timeline.insertElement({
						placement: { mode: "explicit", trackId: hookTrackId },
						element: hookElement,
					});
					hookAdded = true;
				}

				const summary = `${subtitleElements.length} words across ${trackBuckets.length} tracks${cards.length > 0 ? `, ${cards.length} cards` : ""}${hookAdded ? ", opening hook" : ""}`;
				bgTasks.updateTask(taskId, {
					status: "completed",
					progress: summary,
					completedAt: Date.now(),
				});

				// Park the playhead at the start of the trimmed clip
				editor.playback.seek({ time: 0 });
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to apply clip";
				bgTasks.updateTask(taskId, {
					status: "error",
					error: message,
					completedAt: Date.now(),
				});
			} finally {
				setIsApplying(false);
			}
		},
		[segments, editor, subtitlePreset, switchToVertical, enableKeywordHighlight, enableQuestionCards, enableHookText, cardTemplate, cardTransparentBg, bgTasks],
	);

	// ── Add Popover Subtitles (full transcript — background task) ──
	const handleAddPopoverSubs = useCallback(async () => {
		if (!hasTranscript) return;

		const taskId = `popover-subs-${Date.now()}`;
		setIsApplying(true);

		bgTasks.addTask({
			id: taskId,
			type: "popover-subs",
			label: "Popover subtitles",
			progress: "Starting...",
		});

		try {
			let kws: { word: string; color: string }[] = [];
			if (enableKeywordHighlight) {
				try {
					bgTasks.updateTask(taskId, { progress: "Extracting keywords..." });
					const kwResult = await aiClient.extractKeywords(segments);
					kws = kwResult.keywords;
					setKeywords(kws);
				} catch {
					// Continue without keywords
				}
			}

			bgTasks.updateTask(taskId, { progress: "Building popover elements..." });
			const canvasSize = editor.project.getActive().settings.canvasSize;

			const subtitleElements = buildPopoverSubtitleElements({
				segments: segments.map((s) => ({
					text: s.text,
					start: s.start,
					end: s.end,
					words: s.words,
				})),
				preset: subtitlePreset,
				canvasHeight: canvasSize.height,
				canvasWidth: canvasSize.width,
				keywords: kws,
			});

			// Distribute across multiple tracks so overlapping words are all visible
			const trackBuckets = distributeElementsToTracks(subtitleElements);

			for (let t = 0; t < trackBuckets.length; t++) {
				const trackId = editor.timeline.addTrack({ type: "text", index: 0 });
				const label = trackBuckets.length === 1
					? "Popover Subs"
					: `Popover Subs ${t + 1}`;
				editor.timeline.renameTrack({ trackId, name: label });

				for (const el of trackBuckets[t]) {
					editor.timeline.insertElement({
						placement: { mode: "explicit", trackId },
						element: el,
					});
				}
			}

			bgTasks.updateTask(taskId, {
				status: "completed",
				progress: `${subtitleElements.length} words across ${trackBuckets.length} tracks`,
				completedAt: Date.now(),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to add popover subtitles";
			bgTasks.updateTask(taskId, {
				status: "error",
				error: message,
				completedAt: Date.now(),
			});
		} finally {
			setIsApplying(false);
		}
	}, [segments, editor, subtitlePreset, enableKeywordHighlight, hasTranscript, bgTasks]);

	// ── Generate Question Cards (full transcript — background task) ──
	const handleGenerateCards = useCallback(async () => {
		if (!hasTranscript) return;

		const taskId = `question-cards-${Date.now()}`;
		setIsApplying(true);

		bgTasks.addTask({
			id: taskId,
			type: "question-cards",
			label: "Question cards",
			progress: "Analyzing topic shifts...",
		});

		try {
			const result = await aiClient.generateQuestionCards(segments, 5);
			setQuestionCards(result.cards);

			if (result.cards.length === 0) {
				bgTasks.updateTask(taskId, {
					status: "completed",
					progress: "No topic shifts detected",
					completedAt: Date.now(),
				});
				return;
			}

			bgTasks.updateTask(taskId, { progress: "Adding cards to timeline..." });

			const cardTrackId = editor.timeline.addTrack({ type: "text", index: 0 });
			editor.timeline.renameTrack({ trackId: cardTrackId, name: "Topic Cards" });

			for (const card of result.cards) {
				const cardElement = buildQuestionCardElement({
					question: card.question,
					startTime: card.timestamp,
					theme: cardTemplate,
					emoji: card.emoji,
					useTransparentBackground: cardTransparentBg,
				});
				editor.timeline.insertElement({
					placement: { mode: "explicit", trackId: cardTrackId },
					element: cardElement,
				});
			}

			bgTasks.updateTask(taskId, {
				status: "completed",
				progress: `${result.cards.length} cards added`,
				completedAt: Date.now(),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to generate question cards";
			const detail = message.includes("Cannot connect") || message.includes("connection_refused")
				? "Cannot connect to AI backend. Make sure Ollama is running."
				: message.includes("503")
					? "Ollama LLM is not available. Start it with: docker compose up -d ollama"
					: message;
			bgTasks.updateTask(taskId, {
				status: "error",
				error: detail,
				completedAt: Date.now(),
			});
		} finally {
			setIsApplying(false);
		}
	}, [segments, editor, hasTranscript, cardTemplate, cardTransparentBg, bgTasks]);

	const isProcessing = isFindingClips || isApplying;

	return (
		<PanelView title="Podcast Clips">
			<div className="flex flex-col gap-4 pb-4">
				{!hasTranscript ? (
					<div className="flex flex-col gap-3">
						<p className="text-xs text-muted-foreground leading-relaxed">
							Transcribe your video first using the Transcript tab, then come back here to create podcast-style clips.
						</p>
					</div>
				) : (
					<>
						{/* ── Smart Clip Finder ── */}
						<div className="flex flex-col gap-2">
							<Label className="text-xs font-medium">Find best clips</Label>
							<p className="text-[11px] text-muted-foreground leading-relaxed">
								AI analyzes your transcript and finds the most viral-worthy moments. You can switch tabs while it runs.
							</p>
							<Button
								variant="default"
								size="sm"
								className="w-full"
								onClick={handleFindClips}
								disabled={isFindingClips}
							>
								{isFindingClips && <Spinner className="mr-1 size-3" />}
								{isFindingClips
									? "Finding clips..."
									: clips.length > 0
										? "Re-scan for clips"
										: "Find best clips"}
							</Button>
						</div>

						{/* ── Clip Results Gallery (SCRUM-73) ── */}
						{clips.length > 0 && (
							<div className="flex flex-col gap-2">
								<div className="flex items-center justify-between">
									<Label className="text-xs font-medium">Clip results</Label>
									<span className="text-[10px] text-muted-foreground tabular-nums">
										{clips.length} found
										{clips.length > 12
											? ` · showing top ${12}`
											: ""}
									</span>
								</div>
								<ClipsGallery
									clips={clips}
									mediaAssetId={galleryAsset?.id ?? null}
									mediaFile={galleryAsset?.file ?? null}
									isProcessing={isProcessing}
									onPreview={handlePreviewClip}
									onApply={(clip) => void handleApplyClip(clip)}
									onExport={handleExportClip}
									mediaTotalDuration={mediaTotalDuration}
									onAdjustClip={handleAdjustClip}
									rescoreClip={handleRescoreClip}
									header={
										<div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
											<div className="flex items-center gap-1.5">
												<span className="text-[10px] text-muted-foreground">
													Min score
												</span>
												<Select
													value={String(batchMinScore)}
													onValueChange={(v) => setBatchMinScore(Number(v))}
												>
													<SelectTrigger className="h-6 w-[74px] px-2 text-[10px]">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="0">All</SelectItem>
														<SelectItem value="60">60+</SelectItem>
														<SelectItem value="80">80+</SelectItem>
													</SelectContent>
												</Select>
											</div>
											<Button
												variant="default"
												size="sm"
												type="button"
												className="h-7 px-2.5 text-[11px]"
												disabled={isProcessing || clips.length === 0}
												onClick={handleExportAllClips}
											>
												Export all ({clips.filter((c) => c.score >= batchMinScore).length})
											</Button>
										</div>
									}
								/>
							</div>
						)}

						{/* ── Subtitle Style ── */}
						<div className="border-t pt-3 flex flex-col gap-2">
							<Label className="text-xs font-medium">Popover subtitle style</Label>
							<Select
								value={subtitlePreset}
								onValueChange={(v) => setSubtitlePreset(v as PopoverSubtitlePreset)}
							>
								<SelectTrigger className="h-8 text-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{POPOVER_SUBTITLE_PRESETS.map((p) => (
										<SelectItem key={p.id} value={p.id}>
											<div className="flex flex-col">
												<span className="text-xs">{p.name}</span>
												<span className="text-[10px] text-muted-foreground">
													{p.description}
												</span>
											</div>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								variant="outline"
								size="sm"
								className="w-full"
								onClick={handleAddPopoverSubs}
								disabled={isProcessing}
							>
								{isApplying && <Spinner className="mr-1 size-3" />}
								Add popover subtitles
							</Button>
						</div>

						{/* ── Auto Features ── */}
						<div className="border-t pt-3 flex flex-col gap-3">
							<Label className="text-xs font-medium">Auto features</Label>

							<div className="flex items-center justify-between">
								<div className="flex flex-col">
									<span className="text-xs">Hook text</span>
									<span className="text-[10px] text-muted-foreground">
										Render the clip title at the opening
									</span>
								</div>
								<Switch
									checked={enableHookText}
									onCheckedChange={setEnableHookText}
								/>
							</div>

							<div className="flex items-center justify-between">
								<div className="flex flex-col">
									<span className="text-xs">Keyword highlighting</span>
									<span className="text-[10px] text-muted-foreground">
										Color-code important words via AI
									</span>
								</div>
								<Switch
									checked={enableKeywordHighlight}
									onCheckedChange={setEnableKeywordHighlight}
								/>
							</div>

							<div className="flex items-center justify-between">
								<div className="flex flex-col">
									<span className="text-xs">Question cards</span>
									<span className="text-[10px] text-muted-foreground">
										AI topic intro slides between segments
									</span>
								</div>
								<Switch
									checked={enableQuestionCards}
									onCheckedChange={setEnableQuestionCards}
								/>
							</div>

							<div className="flex items-center justify-between">
								<div className="flex flex-col">
									<span className="text-xs">Switch to 9:16 on Apply</span>
									<span className="text-[10px] text-muted-foreground">
										Vertical canvas for the new short clip
									</span>
								</div>
								<Switch
									checked={switchToVertical}
									onCheckedChange={setSwitchToVertical}
								/>
							</div>
						</div>

						{/* ── Auto-Reframe ── */}
						<div className="border-t pt-3 flex flex-col gap-2">
							<Label className="text-xs font-medium">Auto-reframe for Shorts</Label>
							<p className="text-[11px] text-muted-foreground leading-relaxed">
								Detect faces and auto-crop 16:9 video to 9:16 vertical, centering on the active speaker.
							</p>
							<Button
								variant="outline"
								size="sm"
								className="w-full"
								onClick={handleAutoReframe}
								disabled={isProcessing || isReframing}
							>
								{isReframing && <Spinner className="mr-1 size-3" />}
								{isReframing ? "Reframing..." : "Auto-reframe 9:16"}
							</Button>
						</div>

						{/* ── Question Cards ── */}
						<div className="border-t pt-3 flex flex-col gap-2">
							<Label className="text-xs font-medium">Topic cards</Label>
							<p className="text-[11px] text-muted-foreground leading-relaxed">
								AI topic questions overlaid on video. Subtitles are hidden during cards.
							</p>

							<Select
								value={cardTemplate}
								onValueChange={setCardTemplate}
							>
								<SelectTrigger className="h-8 text-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{QUESTION_CARD_TEMPLATES.map((t) => (
										<SelectItem key={t.id} value={t.id}>
											<div className="flex flex-col">
												<span className="text-xs">{t.name}</span>
												<span className="text-[10px] text-muted-foreground">
													{t.description}
												</span>
											</div>
										</SelectItem>
									))}
								</SelectContent>
							</Select>

							<div className="flex items-center justify-between">
								<div className="flex flex-col">
									<span className="text-xs">Transparent background</span>
									<span className="text-[10px] text-muted-foreground">
										Show video behind card text
									</span>
								</div>
								<Switch
									checked={cardTransparentBg}
									onCheckedChange={setCardTransparentBg}
								/>
							</div>

							<Button
								variant="outline"
								size="sm"
								className="w-full"
								onClick={handleGenerateCards}
								disabled={isProcessing}
							>
								{isApplying && <Spinner className="mr-1 size-3" />}
								Generate question cards
							</Button>

							{questionCards.length > 0 && (
								<div className="flex flex-col gap-1 mt-1">
									{questionCards.map((card, idx) => (
										<div
											key={`${card.timestamp}-${idx}`}
											className="flex items-center gap-2 rounded-md border px-2 py-1.5"
										>
											{card.emoji && (
												<span className="text-sm shrink-0">{card.emoji}</span>
											)}
											<div className="flex-1 min-w-0">
												<p className="text-[11px] font-medium truncate">
													{card.question}
												</p>
												<p className="text-[9px] text-muted-foreground tabular-nums">
													{formatTime(card.timestamp)}
												</p>
											</div>
											<Badge
												variant="outline"
												className="text-[8px] px-1 py-0 h-3.5 shrink-0"
											>
												{card.theme}
											</Badge>
										</div>
									))}
								</div>
							)}
						</div>

						{/* ── Keywords (if extracted) ── */}
						{keywords.length > 0 && (
							<div className="border-t pt-3 flex flex-col gap-2">
								<Label className="text-xs font-medium">Detected keywords</Label>
								<div className="flex flex-wrap gap-1">
									{keywords.slice(0, 20).map((kw, idx) => (
										<Badge
											key={`${kw.word}-${idx}`}
											variant="outline"
											className="text-[10px] px-1.5 py-0 h-5"
											style={{ borderColor: kw.color, color: kw.color }}
										>
											{kw.word}
										</Badge>
									))}
								</div>
							</div>
						)}
					</>
				)}
			</div>
		</PanelView>
	);
}

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}
