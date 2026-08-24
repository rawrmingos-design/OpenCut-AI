import { describe, expect, it } from "bun:test";

import {
	audioBufferToMono,
	rmsCurveFromSamples,
} from "@/lib/audio-energy";

describe("rmsCurveFromSamples", () => {
	it("constant amplitude normalizes to 1.0", () => {
		const samples = new Float32Array(16000).fill(0.5);
		const curve = rmsCurveFromSamples(samples, 16000);
		expect(curve.length).toBe(1);
		expect(curve[0]).toBe(1);
	});

	it("quieter window scales below peak", () => {
		const samples = new Float32Array(32000);
		samples.fill(0.8, 0, 16000);
		samples.fill(0.4, 16000);
		const curve = rmsCurveFromSamples(samples, 16000);
		expect(curve.length).toBe(2);
		expect(curve[0]).toBe(1);
		expect(Math.abs(curve[1] - 0.5)).toBeLessThan(0.01);
	});

	it("silence maps to zeros", () => {
		const samples = new Float32Array(32000);
		const curve = rmsCurveFromSamples(samples, 16000);
		expect(curve).toEqual([0, 0]);
	});

	it("empty input yields empty curve", () => {
		expect(rmsCurveFromSamples(new Float32Array(0), 16000)).toEqual([]);
	});
});

describe("audioBufferToMono", () => {
	it("passes through mono buffers", () => {
		const data = new Float32Array([0.1, 0.2, 0.3]);
		const buffer = {
			length: 3,
			numberOfChannels: 1,
			sampleRate: 16000,
			getChannelData: () => data,
		} as unknown as AudioBuffer;
		const mono = audioBufferToMono(buffer);
		expect(mono.length).toBe(3);
		expect(mono[0]).toBeCloseTo(0.1);
		expect(mono[1]).toBeCloseTo(0.2);
		expect(mono[2]).toBeCloseTo(0.3);
	});

	it("averages stereo channels", () => {
		const left = new Float32Array([1, 0]);
		const right = new Float32Array([0, 1]);
		const buffer = {
			length: 2,
			numberOfChannels: 2,
			sampleRate: 16000,
			getChannelData: (c: number) => (c === 0 ? left : right),
		} as unknown as AudioBuffer;
		const mono = audioBufferToMono(buffer);
		expect(mono[0]).toBeCloseTo(0.5);
		expect(mono[1]).toBeCloseTo(0.5);
	});
});
