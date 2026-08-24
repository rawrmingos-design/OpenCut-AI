/**
 * SCRUM-75: client-side audio energy extraction for composite clip scoring.
 *
 * Decodes the source media in the browser with WebAudio and produces a
 * 1-second-resolution RMS curve (0–1, peak-normalized) that is sent to
 * `/api/analyze/find-clips` as `energy_curve`. Pure math is separated so
 * it can be unit-tested without a browser.
 */

/** Per-window RMS from mono float32 samples, then peak-normalized to 0–1. */
export function rmsCurveFromSamples(
	samples: Float32Array | number[],
	sampleRate: number,
	windowSeconds = 1,
): number[] {
	const windowSize = Math.max(1, Math.round(sampleRate * windowSeconds));
	const envelope: number[] = [];
	for (let i = 0; i < samples.length; i += windowSize) {
		let sumSquares = 0;
		let count = 0;
		const end = Math.min(i + windowSize, samples.length);
		for (let j = i; j < end; j++) {
			sumSquares += (samples[j] as number) ** 2;
			count++;
		}
		if (count === 0) break;
		envelope.push(Math.sqrt(sumSquares / count));
	}
	const peak = envelope.reduce((m, v) => Math.max(m, v), 0);
	if (peak <= 0) return envelope.map(() => 0);
	return envelope.map((v) => Math.round((v / peak) * 10000) / 10000);
}

/** Downmix all channels of an AudioBuffer to mono float32 samples. */
export function audioBufferToMono(buffer: AudioBuffer): Float32Array {
	const length = buffer.length;
	const channels = buffer.numberOfChannels;
	if (channels === 1) return buffer.getChannelData(0);
	const out = new Float32Array(length);
	for (let c = 0; c < channels; c++) {
		const data = buffer.getChannelData(c);
		for (let i = 0; i < length; i++) out[i] += data[i] / channels;
	}
	return out;
}

/**
 * Decode media bytes and return the 1s RMS energy curve.
 * Throws on decode failure — caller decides how to degrade
 * (the backend treats a missing curve as a missing signal).
 */
export async function extractEnergyCurve(
	file: Blob,
	windowSeconds = 1,
): Promise<number[]> {
	const arrayBuffer = await file.arrayBuffer();
	const AudioCtx =
		window.AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;
	if (!AudioCtx) throw new Error("WebAudio unavailable");
	const ctx = new AudioCtx();
	try {
		const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
		const mono = audioBufferToMono(buffer);
		return rmsCurveFromSamples(mono, buffer.sampleRate, windowSeconds);
	} finally {
		void ctx.close().catch(() => {});
	}
}
