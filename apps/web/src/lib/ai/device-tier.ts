"use client";

/**
 * Client-side device capability probe.
 * Classifies the user's device into a tier that decides which AI
 * providers can run locally vs. which should stay on the cloud.
 */

export type DeviceTier = "potato" | "standard" | "sultan";

export interface DeviceCapabilities {
	ramGb: number | null;
	cpuCores: number | null;
	webgpu: boolean;
	tier: DeviceTier;
}

const STORAGE_KEY = "ai-device-tier";

function detectTier({
	ramGb,
	cpuCores,
	webgpu,
}: {
	ramGb: number | null;
	cpuCores: number | null;
	webgpu: boolean;
}): DeviceTier {
	// Sultan: lots of RAM or a discrete GPU with WebGPU support
	if ((ramGb !== null && ramGb >= 8) || webgpu) {
		return "sultan";
	}

	// Potato: low RAM or very few cores
	if (
		(ramGb !== null && ramGb < 4) ||
		(cpuCores !== null && cpuCores < 4)
	) {
		return "potato";
	}

	return "standard";
}

function readCached(): DeviceTier | null {
	if (typeof window === "undefined") return null;
	try {
		const cached = localStorage.getItem(STORAGE_KEY);
		if (
			cached === "potato" ||
			cached === "standard" ||
			cached === "sultan"
		) {
			return cached;
		}
	} catch {
		// localStorage unavailable
	}
	return null;
}

/** One-shot detection (safe to call outside React). */
export function getDeviceTier(): DeviceTier {
	const cached = readCached();
	if (cached) return cached;

	if (typeof navigator === "undefined") return "standard";

	const nav = navigator as Navigator & {
		deviceMemory?: number;
		hardwareConcurrency?: number;
		gpu?: unknown;
	};

	const ramGb = nav.deviceMemory ?? null;
	const cpuCores = nav.hardwareConcurrency ?? null;
	const webgpu = "gpu" in nav && !!nav.gpu;

	const tier = detectTier({ ramGb, cpuCores, webgpu });

	try {
		localStorage.setItem(STORAGE_KEY, tier);
	} catch {
		// non-fatal
	}

	return tier;
}

/** Probe details including raw values (for Settings display). */
export function getDeviceCapabilities(): DeviceCapabilities {
	const tier = getDeviceTier();
	if (typeof navigator === "undefined") {
		return { ramGb: null, cpuCores: null, webgpu: false, tier };
	}

	const nav = navigator as Navigator & {
		deviceMemory?: number;
		hardwareConcurrency?: number;
		gpu?: unknown;
	};

	return {
		ramGb: nav.deviceMemory ?? null,
		cpuCores: nav.hardwareConcurrency ?? null,
		webgpu: "gpu" in nav && !!nav.gpu,
		tier,
	};
}
