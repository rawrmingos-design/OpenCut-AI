"use client";

import { useState } from "react";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import { Check, Copy, Download, RotateCcw } from "lucide-react";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	EXPORT_RESOLUTION_VALUES,
	type ExportFormat,
	type ExportQuality,
	type ExportResolution,
} from "@/types/export";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/editor/panels/properties/section";
import { useEditor } from "@/hooks/use-editor";
import {
	DEFAULT_EXPORT_OPTIONS,
	EXPORT_PRESETS,
} from "@/constants/export-constants";
import { useExportQueueStore } from "@/stores/export-queue-store";

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((qualityValue) => qualityValue === value);
}

function isExportResolution(value: string): value is ExportResolution {
	return EXPORT_RESOLUTION_VALUES.some(
		(resolutionValue) => resolutionValue === value,
	);
}

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const editor = useEditor();

	const hasProject = !!editor.project.getActiveOrNull();

	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		if (!open) {
			editor.project.cancelExport();
			editor.project.clearExportState();
		}
		setIsExportPopoverOpen(open);
	};

	return (
		<Popover
			open={isExportPopoverOpen}
			onOpenChange={(open) => handlePopoverOpenChange({ open })}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex items-center gap-1.5 rounded-md bg-[#38BDF8] px-[0.12rem] py-[0.12rem] text-white",
						hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
					)}
					onClick={hasProject ? () => setIsExportPopoverOpen(true) : undefined}
					disabled={!hasProject}
					onKeyDown={(event) => {
						if (hasProject && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							setIsExportPopoverOpen(true);
						}
					}}
				>
					<div className="relative flex items-center gap-1.5 rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7] px-4 py-1 shadow-[0_1px_3px_0px_rgba(0,0,0,0.65)]">
						<HugeiconsIcon icon={TransitionTopIcon} className="z-50 size-4" />
						<span className="z-50 text-[0.875rem]">Export</span>
						<div className="absolute top-0 left-0 z-10 flex size-full items-center justify-center rounded-[0.6rem] bg-linear-to-t from-white/0 to-white/50">
							<div className="absolute top-[0.08rem] z-50 h-[calc(100%-2px)] w-[calc(100%-2px)] rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7]"></div>
						</div>
					</div>
				</button>
			</PopoverTrigger>
			{hasProject && <ExportPopover onOpenChange={setIsExportPopoverOpen} />}
		</Popover>
	);
}

function ExportPopover({
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const addJob = useExportQueueStore((s) => s.addJob);
	const {
		isExporting,
		progress,
		result: exportResult,
		status,
	} = editor.project.getExportState();
	const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	const [shouldIncludeWatermark, setShouldIncludeWatermark] = useState(true);
	const [resolution, setResolution] = useState<string>("source");
	const [videoBitrate, setVideoBitrate] = useState<number | null>(null);
	const [audioBitrate, setAudioBitrate] = useState<number | null>(null);

	const handlePresetSelect = (presetId: string) => {
		const preset = EXPORT_PRESETS.find((p) => p.id === presetId);
		if (!preset) return;
		setSelectedPresetId(presetId);
		if (isExportFormat(preset.options.format)) setFormat(preset.options.format);
		if (isExportQuality(preset.options.quality))
			setQuality(preset.options.quality);
		setShouldIncludeAudio(preset.options.includeAudio ?? true);
	};

	const selectedPreset = EXPORT_PRESETS.find((p) => p.id === selectedPresetId);

	const handleExport = async () => {
		if (!activeProject) return;

		// SCRUM-24: enqueue the job instead of blocking on it.
		// The queue worker (use-export-queue-worker) picks it up and drives progress.
		addJob({
			projectId: activeProject.metadata.id,
			projectName: activeProject.metadata.name,
			options: {
				format,
				quality,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
				includeWatermark: shouldIncludeWatermark,
				resolution: isExportResolution(resolution) ? resolution : "source",
				videoBitrate: videoBitrate ?? undefined,
				audioBitrate: audioBitrate ?? undefined,
			},
		});

		onOpenChange(false);
	};

	const handleCancel = () => {
		editor.project.cancelExport();
	};

	return (
		<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			{exportResult && !exportResult.success ? (
				<ExportError
					error={exportResult.error || "Unknown error occurred"}
					onRetry={handleExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{isExporting ? "Exporting project" : "Export project"}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						{!isExporting && (
							<>
								{/* Platform presets */}
								<div className="px-3 pt-3 pb-0">
									<p className="text-xs font-medium text-muted-foreground mb-2">
										Export for
									</p>
									<div className="flex flex-wrap gap-1.5">
										{EXPORT_PRESETS.filter((p) => p.id !== "custom").map(
											(preset) => (
												<button
													key={preset.id}
													type="button"
													className={cn(
														"rounded-md px-2.5 py-1 text-[11px] border transition-colors",
														selectedPresetId === preset.id
															? "border-primary bg-primary/10 text-primary"
															: "border-border hover:bg-accent text-muted-foreground",
													)}
													onClick={() => handlePresetSelect(preset.id)}
												>
													{preset.name}
												</button>
											),
										)}
									</div>
									{selectedPreset?.tip && (
										<p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
											{selectedPreset.tip}
										</p>
									)}
								</div>

								<div className="flex flex-col">
									<Section
										collapsible
										defaultOpen={false}
										showTopBorder={false}
									>
										<SectionHeader>
											<SectionTitle>Format</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={format}
												onValueChange={(value) => {
													if (isExportFormat(value)) {
														setFormat(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="mp4" id="mp4" />
													<Label htmlFor="mp4">
														MP4 (H.264) - Better compatibility
													</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="webm" id="webm" />
													<Label htmlFor="webm">
														WebM (VP9) - Smaller file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Quality</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={quality}
												onValueChange={(value) => {
													if (isExportQuality(value)) {
														setQuality(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="low" id="low" />
													<Label htmlFor="low">Low - Smallest file size</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="medium" id="medium" />
													<Label htmlFor="medium">Medium - Balanced</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="high" id="high" />
													<Label htmlFor="high">High - Recommended</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="very_high" id="very_high" />
													<Label htmlFor="very_high">
														Very high - Largest file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Audio</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<div className="flex items-center space-x-2">
												<Checkbox
													id="include-audio"
													checked={shouldIncludeAudio}
													onCheckedChange={(checked) =>
														setShouldIncludeAudio(!!checked)
													}
												/>
												<Label htmlFor="include-audio">
													Include audio in export
												</Label>
											</div>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Advanced</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<div className="space-y-4">
												<div className="space-y-1.5">
													<Label htmlFor="export-resolution">Resolution</Label>
													<select
														id="export-resolution"
														value={resolution}
														onChange={(e) => setResolution(e.target.value)}
														className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
													>
														{EXPORT_RESOLUTION_VALUES.map((r) => (
															<option key={r} value={r}>
																{r === "source"
																	? "Source (canvas size)"
																	: r === "2160p"
																		? "2160p (4K)"
																		: r === "1440p"
																			? "1440p (2K)"
																			: r === "1080p"
																				? "1080p (Full HD)"
																				: r === "720p"
																					? "720p (HD)"
																					: r === "480p"
																						? "480p (SD)"
																						: "360p (Low)"}
															</option>
														))}
													</select>
													<p className="text-[10px] text-muted-foreground">
														Downscales from the canvas while keeping aspect
														ratio. Upscaling is not applied.
													</p>
												</div>

												<div className="space-y-1.5">
													<Label htmlFor="export-video-bitrate">
														Video bitrate (kbps)
													</Label>
													<input
														id="export-video-bitrate"
														type="number"
														min={0}
														step={500}
														placeholder="Auto (quality preset)"
														value={videoBitrate ?? ""}
														onChange={(e) => {
															const v = e.target.value.trim();
															const n = Number(v);
															setVideoBitrate(
																v && Number.isFinite(n) && n > 0
																	? n * 1000
																	: null,
															);
														}}
														className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
													/>
												</div>

												{shouldIncludeAudio && (
													<div className="space-y-1.5">
														<Label htmlFor="export-audio-bitrate">
															Audio bitrate (kbps)
														</Label>
														<input
															id="export-audio-bitrate"
															type="number"
															min={0}
															step={32}
															placeholder="Auto (quality preset)"
															value={audioBitrate ?? ""}
															onChange={(e) => {
																const v = e.target.value.trim();
																const n = Number(v);
																setAudioBitrate(
																	v && Number.isFinite(n) && n > 0
																		? n * 1000
																		: null,
																);
															}}
															className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
														/>
													</div>
												)}
											</div>
										</SectionContent>
									</Section>

									<Section showTopBorder>
										<SectionHeader>
											<SectionTitle>Watermark</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<div className="flex items-start space-x-2">
												<Checkbox
													id="include-watermark"
													checked={shouldIncludeWatermark}
													onCheckedChange={(checked) =>
														setShouldIncludeWatermark(!!checked)
													}
												/>
												<div className="flex flex-col gap-0.5">
													<Label htmlFor="include-watermark">
														Include OpenCut AI watermark
													</Label>
													<p className="text-[10px] text-muted-foreground leading-relaxed">
														This is open-source software. Including the
														watermark helps spread the word and support the
														project.
													</p>
												</div>
											</div>
										</SectionContent>
									</Section>
								</div>

								<div className="p-3 pt-0">
									<Button onClick={handleExport} className="w-full gap-2">
										<Download className="size-4" />
										Export
									</Button>
								</div>
							</>
						)}

						{(isExporting || status === "cancelled" || status === "failed") && (
							<div className="space-y-4 p-3">
								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between text-center">
										<p className="text-muted-foreground text-sm">
											{status === "cancelled"
												? "Cancelled"
												: status === "failed"
													? "Failed"
													: status === "preparing"
														? "Preparing…"
														: status === "finalizing"
															? "Finalizing…"
															: `${Math.round(progress * 100)}%`}
										</p>
										<p className="text-muted-foreground text-sm">100%</p>
									</div>
									<Progress
										value={
											status === "failed" || status === "cancelled"
												? progress * 100
												: progress * 100
										}
										className="w-full"
									/>
								</div>

								<Button
									variant="outline"
									className="w-full rounded-md"
									onClick={handleCancel}
									disabled={status === "cancelled" || status === "failed"}
								>
									{status === "cancelled" ? "Cancelled" : "Cancel"}
								</Button>
							</div>
						)}
					</div>
				</>
			)}
		</PopoverContent>
	);
}

function ExportError({
	error,
	onRetry,
}: {
	error: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-3">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground text-xs">{error}</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
			</div>
		</div>
	);
}
