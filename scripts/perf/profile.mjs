#!/usr/bin/env node
/**
 * SCRUM-49 Performance Profiling Harness
 *
 * Measures:
 *   1. Startup  — cold navigation to the web app: load time, FCP, LCP (PerformanceObserver)
 *   2. Preview  — 2s rAF sampling on the landing page: avg FPS + long-task count
 *   3. Render   — POST /api/export/render on a generated 5s 1080p fixture (2 runs)
 *
 * Usage:
 *   OPENCUTAI_API_KEY=... node scripts/perf/profile.mjs [--url http://127.0.0.1:3200]
 *
 * Startup/preview sections need playwright-core (set PLAYWRIGHT_CORE_PATH) and a
 * Chromium binary (PLAYWRIGHT_CHROMIUM_PATH). Render section needs docker CLI and
 * a reachable ai-backend (OPENCUTAI_API_URL, default http://127.0.0.1:8420).
 * Results are written to docs/QA/perf-baseline.json.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const urlFlag = args.indexOf("--url");
const WEB_URL = urlFlag >= 0 ? args[urlFlag + 1] : process.env.OPENCUT_WEB_URL || "http://127.0.0.1:3200";
const API_URL = process.env.OPENCUTAI_API_URL || "http://127.0.0.1:8420";
const API_KEY = process.env.OPENCUTAI_API_KEY || "";
const CONTAINER = process.env.OPENCUTAI_CONTAINER || "opencut-ai-ai-backend-1";

const result = {
	timestamp: new Date().toISOString(),
	web_url: WEB_URL,
	api_url: API_URL,
	startup: null,
	preview: null,
	render_runs: [],
	render_avg_ms: null,
	targets: { startup_ms: 3000 },
	passed: false,
};

function log(section, msg) {
	console.log(`[${section}] ${msg}`);
}

async function profileBrowser() {
	let pw;
	try {
		const pwPath = process.env.PLAYWRIGHT_CORE_PATH || "/tmp/node_modules/playwright-core";
		const { createRequire } = await import("node:module");
		const require = createRequire(import.meta.url);
		pw = require(pwPath);
	} catch (e) {
		log("startup", `SKIP: playwright-core not found (${e.message})`);
		return;
	}
	const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
		|| "/home/fahmi/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
	if (!fs.existsSync(executablePath)) {
		log("startup", `SKIP: chromium binary not found at ${executablePath}`);
		return;
	}

	const browser = await pw.chromium.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
	try {
		const ctx = await browser.newContext();
		await ctx.addInitScript(() => {
			window.__ocPerf = { fcp: null, lcp: null, longTasks: 0 };
			new PerformanceObserver((l) => {
				for (const e of l.getEntries()) {
					if (e.name === "first-contentful-paint") window.__ocPerf.fcp = e.startTime;
				}
			}).observe({ type: "paint", buffered: true });
			new PerformanceObserver((l) => {
				for (const e of l.getEntries()) window.__ocPerf.lcp = e.startTime;
			}).observe({ type: "largest-contentful-paint", buffered: true });
			new PerformanceObserver((l) => {
				window.__ocPerf.longTasks += l.getEntries().length;
			}).observe({ type: "longtask", buffered: true });
		});

		const page = await ctx.newPage();
		const t0 = Date.now();
		await page.goto(WEB_URL, { waitUntil: "load", timeout: 20000 });
		const loadMs = Date.now() - t0;
		await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
		const perf = await page.evaluate(() => ({ ...window.__ocPerf }));

		result.startup = {
			load_ms: loadMs,
			fcp_ms: perf.fcp != null ? Math.round(perf.fcp) : null,
			lcp_ms: perf.lcp != null ? Math.round(perf.lcp) : null,
			long_tasks_initial: perf.longTasks,
			target_met: loadMs < result.targets.startup_ms,
		};
		log("startup", `load=${loadMs}ms fcp=${result.startup.fcp_ms}ms lcp=${result.startup.lcp_ms}ms longTasks=${perf.longTasks} targetMet=${result.startup.target_met}`);

		// Preview proxy: 2s rAF sampling (landing page has no video timeline)
		const fps = await page.evaluate(() => new Promise((resolve) => {
			let frames = 0;
			const start = performance.now();
			function tick() {
				frames += 1;
				if (performance.now() - start < 2000) requestAnimationFrame(tick);
				else resolve({ frames, elapsed_ms: performance.now() - start });
			}
			requestAnimationFrame(tick);
		}));
		const heap = await page.evaluate(() =>
			(performance?.memory?.usedJSHeapSize ?? 0) / 1024 / 1024);
		result.preview = {
			sample_ms: Math.round(fps.elapsed_ms),
			frames: fps.frames,
			avg_fps: Math.round(fps.frames / (fps.elapsed_ms / 1000)),
			js_heap_mb: Number(heap.toFixed(2)),
			note: "landing page rAF proxy — editor-canvas FPS tracked separately post-QA",
		};
		log("preview", `avgFPS=${result.preview.avg_fps} heapMB=${result.preview.js_heap_mb}`);
	} finally {
		await browser.close();
	}
}

async function runRenderOnce(label) {
	log("render", `${label}: generating 5s 1080p fixture in container`);
	execSync(
		`docker exec ${CONTAINER} sh -c "ffmpeg -y -f lavfi -i testsrc=duration=5:size=1920x1080:rate=30 -f lavfi -i sine=frequency=1000:duration=5 -c:v libx264 -c:a aac /app/uploads/bench_in.mp4"`,
		{ stdio: "ignore" },
	);
	const body = {
		input_path: "/app/uploads/bench_in.mp4",
		output_format: "mp4",
		resolution: "1920x1080",
		fps: 30,
		video_codec: "libx264",
		audio_codec: "aac",
		video_bitrate: "2M",
		audio_bitrate: "128k",
		preset: "ultrafast",
	};
	const t0 = Date.now();
	const resp = await fetch(`${API_URL}/api/export/render`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
		body: JSON.stringify(body),
	});
	const elapsed = Date.now() - t0;
	if (!resp.ok) {
		throw new Error(`render ${label} failed: HTTP ${resp.status} ${await resp.text()}`);
	}
	const data = await resp.json();
	execSync(`docker exec ${CONTAINER} rm -f /app/uploads/bench_in.mp4 ${data.output_path}`, { stdio: "ignore" });
	const entry = { label, ms: elapsed, size_mb: data.file_size_mb, duration_s: data.duration };
	result.render_runs.push(entry);
	log("render", `${label}: ${elapsed}ms (${(elapsed / 5000).toFixed(2)}x realtime) out=${data.file_size_mb}MB`);
}

async function profileRender() {
	try {
		await runRenderOnce("cold");
		await runRenderOnce("warm");
		result.render_avg_ms = Math.round(
			result.render_runs.reduce((a, r) => a + r.ms, 0) / result.render_runs.length,
		);
	} catch (err) {
		log("render", `FAIL: ${err.message}`);
		result.render_error = err.message;
	}
}

await profileBrowser();
await profileRender();

result.passed = Boolean(result.startup?.target_met) && !result.render_error;

const outDir = path.join(REPO_ROOT, "docs", "QA");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "perf-baseline.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(`\nSaved -> docs/QA/perf-baseline.json | passed=${result.passed}`);
process.exit(result.passed ? 0 : 1);