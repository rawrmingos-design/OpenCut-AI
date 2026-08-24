"""SCRUM-75 composite clip scoring — unit + API contract tests.

Pure signal math is tested directly. The find-clips endpoint is tested
with a mocked LLM backend so ranking behavior is deterministic and no
Ollama instance is required.
"""

import math

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routes.podcast import FindClipsRequest, TranscriptSegment, TranscriptWord, router
from app.services.clip_signals import (
    audio_energy_score,
    blend_clip_score,
    normalize_energy_curve,
    rms_curve_from_pcm,
    slice_curve,
    speaker_activity_score,
    speech_density_score,
    speech_density_wps,
)
from app.services.model_backend import llm_backend


# ── Pure signal math ─────────────────────────────────────────────────


def _pcm(*amplitudes: float) -> bytes:
    """s16le mono PCM frames from -1..1 amplitudes."""
    return b"".join(
        int(max(-1.0, min(1.0, a)) * 32767).to_bytes(2, "little", signed=True)
        for a in amplitudes
    )


class TestRmsCurve:
    def test_constant_amplitude_normalizes_to_ones(self):
        pcm = _pcm(*([0.5] * 16000))
        curve = rms_curve_from_pcm(pcm)
        assert len(curve) == 1
        assert curve[0] == 1.0

    def test_quieter_window_scales_below_peak(self):
        loud = [0.8] * 16000
        quiet = [0.4] * 16000
        curve = rms_curve_from_pcm(_pcm(*(loud + quiet)))
        assert len(curve) == 2
        assert curve[0] == 1.0
        assert abs(curve[1] - 0.5) < 0.01

    def test_silence_maps_to_zeros_not_nan(self):
        curve = rms_curve_from_pcm(_pcm(*([0.0] * 32000)))
        assert curve == [0.0, 0.0]

    def test_empty_pcm(self):
        assert rms_curve_from_pcm(b"") == []


class TestEnergyScore:
    def test_empty_curve_is_neutral(self):
        assert audio_energy_score([]) == 50.0

    def test_flat_loud_scores_high(self):
        assert audio_energy_score([1.0] * 10) == 100.0

    def test_flat_quiet_scores_low(self):
        score = audio_energy_score([0.1] * 10)
        assert score < 30

    def test_mixed_curves_rank_by_liveliness(self):
        lively = [0.9, 0.85, 0.95, 0.88]
        dull = [0.2, 0.25, 0.15, 0.22]
        assert audio_energy_score(lively) > audio_energy_score(dull)


class TestSliceCurve:
    def test_slices_second_windows(self):
        curve = list(range(10))
        # [2,5) → windows 2,3,4; end-second excluded (half-open range)
        assert slice_curve(curve, 2.0, 5.0) == [2, 3, 4]

    def test_clamps_to_bounds(self):
        assert slice_curve([1, 2, 3], 2.5, 99) == [3]

    def test_empty(self):
        assert slice_curve([], 0, 5) == []

    def test_normalize_ignores_out_of_range_values(self):
        assert normalize_energy_curve([-0.5, 0.25, 4.0]) == [0.0, 0.0625, 1.0]


def _seg(sid: int, start: float, end: float, text: str, speaker=None, words=None):
    return {
        "id": sid,
        "text": text,
        "start": start,
        "end": end,
        "speaker": speaker,
        "words": words or [],
    }


def _word(w: str, start: float, end: float):
    return {"word": w, "start": start, "end": end, "confidence": 0.95}


class TestSpeechDensity:
    def test_wps_computed_from_word_timings(self):
        words = [_word(f"w{i}", i * 0.5, i * 0.5 + 0.4) for i in range(20)]
        segments = [_seg(0, 0, 10, "...", words=words)]
        # 20 words over 10s = 2 wps
        assert speech_density_wps(segments, 0, 10) == 2.0

    def test_score_caps_at_ceiling(self):
        words = [_word(f"w{i}", i * 0.2, i * 0.2 + 0.15) for i in range(50)]
        segments = [_seg(0, 0, 10, "...", words=words)]
        assert speech_density_score(segments, 0, 10) == 100.0

    def test_words_partially_overlapping_are_clamped(self):
        words = [_word("hi", -1.0, 2.0), _word("yo", 8.0, 12.0)]
        segments = [_seg(0, 0, 10, "...", words=words)]
        # Both count (overlap), duration window still 10s
        assert speech_density_wps(segments, 0, 10) == 0.2

    def test_segment_fallback_is_bounded(self):
        segments = [_seg(0, 0, 10, "plain text")]
        # No word timings: one overlapping segment is the documented coarse
        # fallback, not a fabricated neutral-positive score.
        assert speech_density_score(segments, 0, 10) == 2.5

    def test_no_segments_is_neutral(self):
        assert speech_density_score([], 0, 10) == 50.0


def _stream_result(response):
    """Unwrap the final NDJSON {result: ...} streaming response."""
    lines = [line for line in response.text.splitlines() if line.strip()]
    return __import__("json").loads(lines[-1])["result"]


class TestSpeakerActivity:
    def test_no_labels_returns_none(self):
        segments = [_seg(0, 0, 10, "hello world")]
        assert speaker_activity_score(segments, 0, 10) is None

    def test_single_speaker_full_coverage(self):
        segments = [_seg(0, 0, 30, "a", speaker="SPEAKER_00")]
        score = speaker_activity_score(segments, 0, 30)
        assert score == 55.0  # full coverage, zero alternation

    def test_alternating_speakers_score_higher(self):
        single = [_seg(0, 0, 60, "a", speaker="SPEAKER_00")]
        duo = [
            _seg(i, i * 10, (i + 1) * 10, "x", speaker=f"SPEAKER_0{i % 2}")
            for i in range(6)
        ]
        s_single = speaker_activity_score(single, 0, 60)
        s_duo = speaker_activity_score(duo, 0, 60)
        assert s_duo > s_single

    def test_face_ratio_blends_in(self):
        segments = [_seg(0, 0, 30, "a", speaker="SPEAKER_00")]
        base = speaker_activity_score(segments, 0, 30)
        boosted = speaker_activity_score(segments, 0, 30, face_active_ratio=1.0)
        assert boosted == round(base * 0.6 + 40.0, 1)


class TestBlend:
    WEIGHTS = {
        "llm": 0.55,
        "audio_energy": 0.20,
        "speech_density": 0.15,
        "speaker_activity": 0.10,
    }

    def test_all_signals_present(self):
        result = blend_clip_score(
            80.0,
            {"audio_energy": 70.0, "speech_density": 60.0, "speaker_activity": 50.0},
            self.WEIGHTS,
        )
        expected = (80 * 0.55 + 70 * 0.20 + 60 * 0.15 + 50 * 0.10)
        assert result["composite"] == round(expected, 1)
        assert result["missing_signals"] == []
        assert result["components"]["llm"] == 80.0

    def test_missing_signal_weight_redistributes(self):
        result = blend_clip_score(
            80.0,
            {"audio_energy": None, "speech_density": 60.0, "speaker_activity": 50.0},
            self.WEIGHTS,
        )
        expected = (80 * 0.55 + 60 * 0.15 + 50 * 0.10) / 0.80
        assert result["composite"] == round(expected, 1)
        assert result["missing_signals"] == ["audio_energy"]

    def test_all_signals_missing_falls_back_to_llm(self):
        result = blend_clip_score(73.0, {
            "audio_energy": None, "speech_density": None, "speaker_activity": None,
        }, self.WEIGHTS)
        assert result["composite"] == 73.0
        assert result["missing_signals"] == [
            "audio_energy", "speaker_activity", "speech_density",
        ]

    def test_composite_stays_bounded(self):
        result = blend_clip_score(100.0, {
            "audio_energy": 100.0, "speech_density": 100.0, "speaker_activity": 100.0,
        }, self.WEIGHTS)
        assert result["composite"] == 100.0


# ── API contract (mocked LLM) ────────────────────────────────────────


@pytest.fixture()
def client(monkeypatch):
    app = FastAPI()
    app.include_router(router)

    async def fake_available():
        return True

    async def fake_generate_json(prompt: str, **kwargs):
        return {"clips": [
            {"title": "A", "start": 0, "end": 20, "score": 90, "reason": "r", "tags": []},
            {"title": "B", "start": 30, "end": 50, "score": 60, "reason": "r", "tags": []},
            {"title": "B-dup", "start": 55, "end": 75, "score": 60, "reason": "r", "tags": []},
            {"title": "C", "start": 80, "end": 100, "score": 40, "reason": "r", "tags": []},
            {"title": "D", "start": 105, "end": 125, "score": 30, "reason": "r", "tags": []},
        ]}

    monkeypatch.setattr(llm_backend, "check_available", fake_available)
    monkeypatch.setattr(llm_backend, "generate_json", fake_generate_json)
    return TestClient(app)


def _request_body(**overrides):
    words = [_word(f"w{i}", i * 0.45, i * 0.45 + 0.4) for i in range(280)]
    segments = [
        TranscriptSegment(id=0, text="talking about stuff", start=0, end=130,
                          speaker="SPEAKER_00",
                          words=[TranscriptWord(**w) for w in words]),
    ]
    payload = FindClipsRequest(segments=segments).model_dump()
    payload.update(overrides)
    return payload


def test_llm_only_mode_preserves_order_and_has_no_signals(client):
    resp = client.post("/api/analyze/find-clips", json=_request_body(use_composite=False))
    assert resp.status_code == 200
    data = _stream_result(resp)
    scores = [c["score"] for c in data["clips"]]
    assert scores == sorted(scores, reverse=True)
    assert all(c.get("signals") is None for c in data["clips"])
    assert data["ranking_comparison"] is None
    assert data["clips"][0]["title"] == "A"


def test_composite_mode_returns_breakdown_and_ids(client):
    resp = client.post("/api/analyze/find-clips", json=_request_body())
    assert resp.status_code == 200
    data = _stream_result(resp)

    for clip in data["clips"]:
        assert clip["id"], f"missing deterministic id on {clip}"
        assert clip["signals"] is not None
        signals = clip["signals"]
        assert set(signals["weights_applied"]) >= {"llm"}
        # energy curve absent → reported missing, never faked
        assert "audio_energy" in signals["missing_signals"]
        # density computed from word timings
        assert signals["speech_density"] is not None
        assert signals["speech_wps"] is not None
        # legacy flat field matches blended composite
        assert clip["score"] == int(round(signals["composite"]))

    rc = data["ranking_comparison"]
    assert rc is not None
    assert rc["top5_overlap_count"] == len(set(rc["llm_only_top5"]) & set(rc["composite_top5"]))
    # ids are unique even when titles duplicate ("B" twice)
    ids = [c["id"] for c in data["clips"]]
    assert len(ids) == len(set(ids))


def test_client_energy_curve_feeds_signal(client):
    # 130s curve: seconds 0–59 loud, 60–129 quiet (one full period).
    curve = [1.0 if s < 60 else 0.05 for s in range(130)]
    body = _request_body(energy_curve=curve)

    with_curve = _stream_result(client.post("/api/analyze/find-clips", json=body))
    body_no_energy = {k: v for k, v in body.items() if k != "energy_curve"}
    without_curve = _stream_result(client.post("/api/analyze/find-clips", json=body_no_energy))

    by_id_with = {c["id"]: c for c in with_curve["clips"]}
    by_id_without = {c["id"]: c for c in without_curve["clips"]}
    some_id = next(iter(by_id_with))
    sig_with = by_id_with[some_id]["signals"]
    sig_without = by_id_without[some_id]["signals"]

    assert "audio_energy" not in (sig_with["missing_signals"] or [])
    assert "audio_energy" in (sig_without["missing_signals"] or [])
    assert sig_with["audio_energy"] is not None
    assert sig_with["speech_density"] == pytest.approx(sig_without["speech_density"])
    # A fully-loud clip must outscore a fully-quiet one on energy.
    loud = [c for c in with_curve["clips"] if c["end"] <= 60]
    quiet = [c for c in with_curve["clips"] if c["start"] >= 60]
    assert loud and quiet
    e = loud[0]["signals"]["audio_energy"]
    o = quiet[0]["signals"]["audio_energy"]
    assert e > 90 and o < 10
