import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { useEditor } from "@/hooks/use-editor";
import { useState } from "react";
import type { TextElement } from "@/types/timeline";
import { toast } from "sonner";

export const SUBTITLE_PRESETS = {
	classic: {
		fontFamily: "Inter",
		color: "#ffffff",
		highlightColor: "#FACC15",
		fontWeight: "normal",
		wordPopScale: 1.0,
		background: { enabled: true, color: "#000000", opacity: 0.8 },
		transform: { scale: 1, position: { x: 0, y: 720 * 0.8 }, rotate: 0 } // y approx 80%
	},
	tiktok: {
		fontFamily: "Montserrat",
		color: "#ffffff",
		highlightColor: "#00f2fe",
		fontWeight: "bold",
		wordPopScale: 1.25,
		background: { enabled: false, color: "#000000", opacity: 0 },
		transform: { scale: 1, position: { x: 0, y: 720 * 0.5 }, rotate: 0 } // Center pop
	}
} as const;

export function SubtitleStyleControls({ subtitleTrackIds }: { subtitleTrackIds: string[] }) {
	const editor = useEditor();
	const [preset, setPreset] = useState<"classic"|"tiktok">("classic");

	const applyStyle = () => {
		const targetTracks = new Set(subtitleTrackIds);
		if (targetTracks.size === 0) {
			toast.error("No subtitle tracks found.");
			return;
		}

		const tracks = editor.timeline.getTracks();
		const updates: any[] = [];
		const style = SUBTITLE_PRESETS[preset];

		for (const track of tracks) {
			if (!targetTracks.has(track.id)) continue;
			for (const element of track.elements) {
				if (element.type === "text") {
					updates.push({
						trackId: track.id,
						elementId: element.id,
						updates: {
							fontFamily: style.fontFamily,
							color: style.color,
							highlightColor: style.highlightColor,
							fontWeight: style.fontWeight,
							wordPopScale: style.wordPopScale,
							background: { ...style.background },
							transform: { ...element.transform, position: { ...style.transform.position } },
						}
					});
				}
			}
		}

		if (updates.length > 0) {
			editor.timeline.updateElements({ updates });
			toast.success(`Applied ${preset} style to ${updates.length} subtitles`);
		}
	};

	if (subtitleTrackIds.length === 0) return null;

	return (
		<div className="border-t pt-4 flex flex-col gap-3">
			<Label className="text-xs">Subtitle Style Preset</Label>
			<div className="flex gap-2">
				<Select value={preset} onValueChange={(v) => setPreset(v as any)}>
					<SelectTrigger className="flex-1">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="classic">Classic Movie (Bottom, bg)</SelectItem>
						<SelectItem value="tiktok">TikTok Pop (Center, bold)</SelectItem>
					</SelectContent>
				</Select>
				<Button size="sm" onClick={applyStyle}>Apply to All</Button>
			</div>
			<p className="text-[10px] text-muted-foreground">Select a style and apply it to all generated subtitle elements on the timeline.</p>
		</div>
	);
}
