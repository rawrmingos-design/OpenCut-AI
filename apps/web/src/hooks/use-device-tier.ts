"use client";
import { useEffect, useState } from "react";
import { getDeviceTier, type DeviceTier } from "@/lib/ai/device-tier";

export function useDeviceTier(): DeviceTier {
	const [tier, setTier] = useState<DeviceTier>("standard");

	useEffect(() => {
		setTier(getDeviceTier());
	}, []);

	return tier;
}
