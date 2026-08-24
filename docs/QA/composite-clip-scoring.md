# SCRUM-75 Composite Clip Scoring QA

## Contract

`POST /api/analyze/find-clips` preserves the legacy flat `score` field and adds
`signals` to each candidate when `use_composite` is enabled (the default).
The composite is weighted from the LLM score plus client-derived 1-second RMS
energy, transcript speech density, and diarization speaker activity.

Default weights (`CLIP_SCORE_*_WEIGHT`, env-configurable):

| Signal | Weight |
|---|---:|
| LLM score | 0.55 |
| Audio energy | 0.20 |
| Speech density | 0.15 |
| Speaker activity | 0.10 |

Missing optional signals have their weight redistributed over the signals that
are present and are listed in `signals.missing_signals`; no missing signal is
replaced with a synthetic neutral score.

## Deterministic fixture result

Fixture: `services/ai-backend/tests/test_clip_composite_scoring.py`

- 5 mocked LLM candidates, including two candidates with duplicate-looking
  titles (`B` and `B-dup`) to prove deterministic IDs.
- 130 seconds of transcript word timings; one labeled speaker
  (`SPEAKER_00`), so coverage is measured and alternation is zero.
- Composite mode without `energy_curve`: `audio_energy` reported missing,
  remaining weights normalized.
- Composite mode with a 130-point RMS curve (seconds 0–59 loud, 60–129 quiet):
  loud clips score `>90` on the energy signal, quiet clips `<10`.
- LLM-only mode (`use_composite=false`) preserves descending LLM ordering and
  omits the breakdown.
- Ranking comparison uses deterministic IDs
  (`clip-{index}-{start-ms}-{end-ms}`); the API computes the actual top-5
  intersection from the same pre-truncation candidate set.

## Automated verification

```text
PYTHONPATH=. pytest -q tests/test_clip_composite_scoring.py   # 28 passed
bun test                                                      # 136 tests, 0 fail
apps/web: npx tsc --noEmit -p tsconfig.json                   # exit 0
```

The API tests mock only the LLM response. Signal math, missing-signal weight
normalization, both ranking modes, response serialization, deterministic IDs,
and energy-curve behavior are exercised without inventing a production API
response.

## Actual response shape (from the mocked contract)

```json
{
  "id": "clip-0-0-20000",
  "score": 79,
  "signals": {
    "llm_score": 90,
    "audio_energy": null,
    "speech_density": 56.2,
    "speech_wps": 2.25,
    "speaker_activity": 55.0,
    "composite": 79.3,
    "weights_applied": {"llm": 0.55, "speech_density": 0.15, "speaker_activity": 0.1},
    "missing_signals": ["audio_energy"]
  }
}
```

## Limitations

The browser podcast endpoint receives transcript segments rather than a server
media path. Audio RMS is therefore decoded with WebAudio in the browser and
sent as a bounded 1-second curve. Face activity is not inferred on this
transcript-only route; speaker activity requires diarization labels and is
reported missing when labels are absent.

The server-side YouTube clip pipeline keeps its existing FFmpeg/face path;
this ticket changes only the browser Podcast Clips ranking contract.

## Security notes

The endpoint accepts only a bounded numeric curve validated client-side and by
the Pydantic request model. It does not accept filesystem paths. Server-side
pipelines keep the validated media-ID/job-reference contract.

## Release evidence

Filled after production build, live smoke, and CI:

- Commit:
- Backend tests:
- Web tests/TSC:
- Docker service:
- Live API smoke:
- CI run / SHA:
- Public shell / `sw.js`:

## Follow-up

SCRUM-72 should add browser-level coverage for the visible breakdown and the
energy-decode failure path.
