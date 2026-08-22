"use client";

import { useCallback, useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/utils/ui";
import {
	type AIFeature,
	type AIProviderType,
	getUserOverride,
	resolvedProviderType,
	setUserOverride,
} from "@/lib/ai/registry";
import { getDeviceCapabilities, type DeviceTier } from "@/lib/ai/device-tier";

const FEATURES: Array<{
	id: AIFeature;
	label: string;
	description: string;
}> = [
	{
		id: "transcribe",
		label: "Transcribe",
		description: "Convert speech to text (subtitles & text-based editing)",
	},
	{
		id: "auto-caption",
		label: "Auto-Caption",
		description: "Generate styled captions from audio",
	},
	{
		id: "suggest-cut",
		label: "Suggest Cut",
		description: "AI recommends where to trim silence / filler words",
	},
	{
		id: "virality",
		label: "Virality Score",
		description: "Rate clip potential for social media",
	},
];

const PROVIDER_OPTIONS: Array<{
	value: AIProviderType | "auto";
	label: string;
}> = [
	{ value: "auto", label: "Auto (recommended)" },
	{ value: "cloud", label: "Cloud (VPS)" },
	{ value: "local-wasm", label: "Local (browser)" },
	{ value: "disabled", label: "Disabled" },
];

const TIER_LABELS: Record<DeviceTier, { label: string; className: string }> = {
	potato: {
		label: "Potato",
		className: "bg-orange-500/15 text-orange-500 border-orange-500/30",
	},
	standard: {
		label: "Standard",
		className: "bg-blue-500/15 text-blue-500 border-blue-500/30",
	},
	sultan: {
		label: "Sultan",
		className: "bg-green-500/15 text-green-500 border-green-500/30",
	},
};

export function AIModulesSection() {
	const [tier, setTier] = useState<DeviceTier>("standard");
	const [, forceUpdate] = useState(0);

	useEffect(() => {
		setTier(getDeviceCapabilities().tier);
	}, []);

	const handleOverride = useCallback(
		({ feature, value }: { feature: AIFeature; value: string }) => {
			setUserOverride({
				feature,
				provider: value as AIProviderType | "auto",
			});
			forceUpdate((n) => n + 1);
		},
		[],
	);

	const caps = getDeviceCapabilities();

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2">
				<Label className="text-xs">Device tier</Label>
				<span
					className={cn(
						"rounded-full border px-2 py-0.5 text-[9px] font-medium",
						TIER_LABELS[tier].className,
					)}
				>
					{TIER_LABELS[tier].label}
				</span>
				<span className="text-[9px] text-muted-foreground">
					{caps.ramGb !== null ? `${caps.ramGb}GB RAM · ` : ""}
					{caps.cpuCores !== null ? `${caps.cpuCores} cores` : ""}
					{caps.webgpu ? " · WebGPU" : ""}
				</span>
			</div>

			<p className="text-[11px] text-muted-foreground leading-relaxed">
				Choose where each AI feature runs. Cloud uses the remote server,
				Local runs in your browser without internet.
			</p>

			<div className="flex flex-col gap-1">
				{FEATURES.map((feature) => {
					const current = resolvedProviderType({ feature: feature.id });
					const override = getUserOverride({ feature: feature.id });
					return (
						<div
							key={feature.id}
							className="flex items-center gap-2 rounded-md border px-2 py-1.5"
						>
							<div className="flex flex-col flex-1 min-w-0">
								<span className="text-[10px] font-medium truncate">
									{feature.label}
								</span>
								<span className="text-[8px] text-muted-foreground truncate">
									{feature.description}
								</span>
							</div>
							<Badge
								variant="secondary"
								className={cn(
									"text-[8px] px-1 py-0 shrink-0 uppercase",
									current === "disabled" && "opacity-50",
								)}
							>
								{current}
							</Badge>
							<Select
								value={override}
								onValueChange={(value) =>
									handleOverride({ feature: feature.id, value })
								}
							>
								<SelectTrigger className="w-[100px] h-6 text-[9px] shrink-0">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PROVIDER_OPTIONS.map((opt) => (
										<SelectItem
											key={opt.value}
											value={opt.value}
											className="text-[10px]"
										>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					);
				})}
			</div>
		</div>
	);
}
