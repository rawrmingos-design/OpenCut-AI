"use client";
/**
 * AI Module Registry
 *
 * Every AI feature can be served by one of three provider classes:
 *   - cloud       : calls the remote VPS AI backend (default, always available when online)
 *   - local-wasm  : runs in the browser via transformers.js / WebAssembly (no server needed)
 *   - local-native: calls a Tauri sidecar binary (future, desktop only)
 *   - disabled    : feature is completely off
 *
 * Resolution priority (per feature):
 *   1. User explicit override  (localStorage "ai-module-overrides")
 *   2. Device-tier auto-select (sultan/standard → local-wasm if registered; potato → cloud)
 *   3. Cloud fallback
 */

import { getDeviceTier, type DeviceTier } from "@/lib/ai/device-tier";

export type AIFeature =
	| "transcribe"
	| "auto-caption"
	| "suggest-cut"
	| "virality";

export type AIProviderType =
	| "cloud"
	| "local-wasm"
	| "local-native"
	| "disabled";

// biome-ignore lint/suspicious/noExplicitAny: intentional generic impl signature
export type AIProviderImpl = (...args: any[]) => Promise<any>;

interface ProviderEntry {
	type: AIProviderType;
	impl: AIProviderImpl;
	/** Minimum tier required to auto-select this provider */
	minTier?: DeviceTier;
}

const OVERRIDES_KEY = "ai-module-overrides";

/** feature → ordered list of registered providers */
const registry = new Map<AIFeature, ProviderEntry[]>();

// ─── Registration ──────────────────────────────────────────────────────────────

export function registerProvider({
	feature,
	type,
	impl,
	minTier,
}: {
	feature: AIFeature;
	type: AIProviderType;
	impl: AIProviderImpl;
	minTier?: DeviceTier;
}): void {
	const existing = registry.get(feature) ?? [];
	// Replace if same type, else append
	const idx = existing.findIndex((p) => p.type === type);
	if (idx >= 0) {
		existing[idx] = { type, impl, minTier };
	} else {
		existing.push({ type, impl, minTier });
	}
	registry.set(feature, existing);
}

// ─── Overrides ─────────────────────────────────────────────────────────────────

function readOverrides(): Partial<Record<AIFeature, AIProviderType>> {
	if (typeof window === "undefined") return {};
	try {
		const raw = localStorage.getItem(OVERRIDES_KEY);
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

export function setUserOverride({
	feature,
	provider,
}: {
	feature: AIFeature;
	provider: AIProviderType | "auto";
}): void {
	if (typeof window === "undefined") return;
	try {
		const overrides = readOverrides();
		if (provider === "auto") {
			delete overrides[feature];
		} else {
			overrides[feature] = provider;
		}
		localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
	} catch {
		// non-fatal
	}
}

export function getUserOverride({
	feature,
}: {
	feature: AIFeature;
}): AIProviderType | "auto" {
	const overrides = readOverrides();
	return overrides[feature] ?? "auto";
}

// ─── Resolution ────────────────────────────────────────────────────────────────

const TIER_RANK: Record<DeviceTier, number> = {
	potato: 0,
	standard: 1,
	sultan: 2,
};

/**
 * Returns the best available provider implementation for a feature.
 * Returns null if none is registered (caller should degrade gracefully).
 */
export function resolveProvider({
	feature,
}: {
	feature: AIFeature;
}): AIProviderImpl | null {
	const providers = registry.get(feature) ?? [];
	const overrides = readOverrides();
	const userOverride = overrides[feature];
	const tier = getDeviceTier();
	const tierRank = TIER_RANK[tier];

	// 1. User forced a specific type
	if (userOverride && userOverride !== "disabled") {
		const match = providers.find((p) => p.type === userOverride);
		if (match) return match.impl;
		// Requested type not registered → fall through to auto
	}

	if (userOverride === "disabled") return null;

	// 2. Auto: pick best provider this device can run
	//    Prefer local-wasm/native over cloud for capable devices
	const capable = providers.filter(
		(p) =>
			p.type !== "disabled" &&
			(p.minTier === undefined || tierRank >= TIER_RANK[p.minTier]),
	);

	// Sort: local-native > local-wasm > cloud (local is preferred when capable)
	const providerPriority: AIProviderType[] = [
		"local-native",
		"local-wasm",
		"cloud",
	];
	capable.sort(
		(a, b) =>
			providerPriority.indexOf(a.type) - providerPriority.indexOf(b.type),
	);

	// Potato devices skip local-wasm/native to avoid OOM
	if (tier === "potato") {
		const cloud = capable.find((p) => p.type === "cloud");
		return cloud?.impl ?? null;
	}

	return capable[0]?.impl ?? null;
}

/** Which provider type *would* be used (for Settings display). */
export function resolvedProviderType({
	feature,
}: {
	feature: AIFeature;
}): AIProviderType | "auto" {
	const providers = registry.get(feature) ?? [];
	const overrides = readOverrides();
	const userOverride = overrides[feature];

	if (userOverride) return userOverride;
	if (providers.length === 0) return "disabled";

	const tier = getDeviceTier();
	if (tier === "potato") {
		return providers.some((p) => p.type === "cloud") ? "cloud" : "disabled";
	}

	const providerPriority: AIProviderType[] = [
		"local-native",
		"local-wasm",
		"cloud",
	];
	const sorted = [...providers].sort(
		(a, b) =>
			providerPriority.indexOf(a.type) - providerPriority.indexOf(b.type),
	);
	return sorted[0]?.type ?? "disabled";
}
