import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface AppSettings {
	optInCrashReporting: boolean;
	hasSeenOnboarding: boolean;
}

export interface AppSettingsState extends AppSettings {
	updateSettings: (settings: Partial<AppSettings>) => void;
}

export const useAppSettingsStore = create<AppSettingsState>()(
	persist(
		(set) => ({
			optInCrashReporting: false,
			hasSeenOnboarding: false,
			updateSettings: (settings) => set((state) => ({ ...state, ...settings })),
		}),
		{ name: "opencut-app-settings" },
	),
);
