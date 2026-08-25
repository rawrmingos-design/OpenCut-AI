# SCRUM-72 — E2E Podcast Clips Journey (QA)

## Scope

Full user journey against the live Docker stack, driven by `playwright-core`
(Chromium headless) via `scripts/e2e/podcast-clips-e2e.mjs`:

1. Open `/projects`, create a new project
2. Import `scripts/fixtures/podcast-narration-50s.mp4` (50s TTS narration,
   15 unique sentences)
3. Add to timeline via the asset card Plus button
4. Generate transcript — **real Whisper** (`whisper-service`)
5. Find best clips — deterministic NDJSON stub by default; set
   `E2E_LIVE_AI=1` to run against real Ollama (slow on CPU: 2–10 min/request,
   serial queue)
6. Apply Clip — Popover Subs track must appear in the timeline
7. Export from the clip card → render queue → automatic download
8. `ffprobe` the downloaded artifact and assert a real duration
9. Scenario 2: backend unreachable → error must surface in the UI, no silent
   hang

## Latest result (deterministic mode)

```
PASS  bootstrap
PASS  new-project
PASS  import-fixture
PASS  add-to-timeline
PASS  transcribe — whisper transcript ready   (real Whisper)
PASS  find-clips — ≥1 candidate rendered      (stubbed LLM)
PASS  apply-clip — Popover Subs track present
PASS  apply-sanity
PASS  ranged-export-download — ffprobe=16.32s (real WebCodecs render)
PASS  ai-failure-visible-error                (route.abort → visible error)
10/10 steps passed
```

Export artifact: `New project_clip_00-04_to_00-24.mp4`, 16.32s ≈ the stubbed
clip range 3.7–23.7s (20s window minus trailing silence/trim behavior).

## Live-LLM evidence

`E2E_LIVE_AI=1` runs were attempted repeatedly; the journey passes through
transcribe every time but local CPU Ollama (qwen2.5:0.5b) is too slow/flaky
for a stable E2E gate:

- Cold request measured ~9m02s end-to-end (backend log), racing the client's
  own 10-minute abort
- A cancelled browser request keeps occupying Ollama's serial queue, so a
  subsequent run can starve entirely (observed: zero `api/generate` for 11 min)
- Direct warm generation is fast (~1–1.5s), proving the instability is
  cold-start + queue occupancy, not the model

The backend pipeline itself was validated live earlier with the same fixture:
`POST /api/analyze/find-clips` returned 2 candidates (scores 93 / 92 after
SCRUM-75 composite blending) via curl.

## Bugs found & fixed while building this suite

1. **NDJSON line-split bug** (`apps/web/src/lib/ai-client.ts`) — transport
   chunks could split a JSON line; per-chunk parsing swallowed the failure
   and permanently dropped the `{"result": ...}` line ("Stream ended without
   result"). Fixed with line buffering + final-line flush.
   Regression tests: `apps/web/src/lib/__tests__/ai-client-keepalive.test.ts`
   (split-chunk reassembly, no-trailing-newline flush, error propagation,
   plain-JSON fallback).
2. **Audio decode hang** (`podcast-clips.tsx`) — Chromium headless can leave
   `decodeAudioData` pending forever on MP4; Find Clips awaited it unbounded.
   Now wrapped in a 15s race so audio energy stays best-effort.
3. **React synthetic events** — programmatic `element.click()` inside
   `page.evaluate` did not trigger React pointer handlers; the suite uses
   real Playwright hover/click everywhere.

## Local gates at commit time

- `bun test`: **140 pass / 0 fail** (285 expectations, 17 files)
- `tsc --noEmit`: **0 errors**
- Docker web image rebuilt & recreated; `/` serves 200
- Backend live smoke (real Whisper + Ollama): transcript 15 segments,
  find-clips 2 candidates with composite breakdown

## Run

```bash
node scripts/e2e/podcast-clips-e2e.mjs              # deterministic (default)
E2E_LIVE_AI=1 node scripts/e2e/podcast-clips-e2e.mjs # real Ollama (slow)
```

Requires: docker compose stack up (`web :3200`, `ai-backend :8420`,
whisper, ollama), ffmpeg/ffprobe on PATH, playwright chromium in
`~/.cache/ms-playwright`.
