"""Non-LLM clip ranking signals (SCRUM-75).

Computes cheap, deterministic signals that complement the LLM's judgment:

- Audio energy: RMS peak density from decoded PCM (FFmpeg pipe, same
  pattern as engagement/scorer.py) or from a client-provided curve.
- Speech density: words-per-second derived from existing Whisper word
  timings — no extra model calls.
- Speaker activity: diarization-label alternation + coverage from the
  transcript segments; optional face/reframe-derived activity can be
  injected when a video file is available upstream. Absent signals
  degrade gracefully: their weight is redistributed proportionally.

Blending is weight-based with server-configurable weights
(OPENCUTAI_CLIP_SCORE_*_WEIGHT in app.config).
"""

import asyncio
import json
import logging
import math
import struct

logger = logging.getLogger(__name__)

# Words per second considered "high energy delivery" (top of scale).
SPEAKING_WPS_CEILING = 4.0


def rms_curve_from_pcm(pcm: bytes, sample_rate: int = 16000, window_s: float = 1.0) -> list[float]:
    """Normalized 0–1 RMS curve from raw s16le mono PCM."""
    n_samples = len(pcm) // 2
    if n_samples == 0:
        return []
    samples = struct.unpack(f"<{n_samples}h", pcm[: n_samples * 2])
    window_size = max(1, int(sample_rate * window_s))
    envelope: list[float] = []
    for i in range(0, n_samples, window_size):
        chunk = samples[i : i + window_size]
        if len(chunk) < 10:
            break
        rms = math.sqrt(sum(s * s for s in chunk) / len(chunk)) / 32768.0
        envelope.append(rms)
    peak = max(envelope) if envelope else 0.0
    if peak <= 0:
        return [0.0] * len(envelope)
    return [round(v / peak, 4) for v in envelope]


def normalize_energy_curve(curve: list[float]) -> list[float]:
    """Normalize an externally provided RMS curve to 0–1 by its own peak."""
    if not curve:
        return []
    peak = max(curve)
    if peak <= 0:
        return [0.0] * len(curve)
    return [round(max(0.0, min(1.0, v / peak)), 4) for v in curve]


def slice_curve(curve: list[float], start: float, end: float, window_s: float = 1.0) -> list[float]:
    """Extract the portion of a curve covering `[start, end]` seconds."""
    if not curve:
        return []
    lo = max(0, int(start / window_s))
    hi = min(len(curve), max(lo + 1, int(math.ceil(end / window_s))))
    return curve[lo:hi]


def audio_energy_score(curve: list[float]) -> float:
    """RMS peak density → 0–100.

    Rewards consistently lively audio (mean level) plus frequent local
    peaks (density of windows above 60% of the clip's own peak).
    """
    if not curve:
        return 50.0
    mean_level = sum(curve) / len(curve)
    threshold = 0.6
    peak_density = sum(1 for v in curve if v >= threshold) / len(curve)
    score = mean_level * 70 + peak_density * 30
    return round(min(100.0, max(0.0, score)), 1)


def collect_words(
    segments: list[dict],
    start: float,
    end: float,
) -> list[dict]:
    """Flatten word timings overlapping `[start, end]`, clamped to range."""
    words: list[dict] = []
    for seg in segments:
        seg_words = seg.get("words") or []
        if seg_words:
            for w in seg_words:
                ws = float(w.get("start", 0))
                we = float(w.get("end", ws))
                if we > start and ws < end:
                    words.append({
                        "start": max(ws, start),
                        "end": min(we, end),
                    })
        else:
            # Fall back to segment-level timing as one coarse "word".
            ss = float(seg.get("start", 0))
            se = float(seg.get("end", ss))
            if se > start and ss < end:
                words.append({"start": max(ss, start), "end": min(se, end)})
    return words


def speech_density_score(segments: list[dict], start: float, end: float) -> float:
    """Words-per-second over the clip → 0–100 (clamped at 4 wps ceiling)."""
    duration = end - start
    if duration <= 0:
        return 50.0
    words = collect_words(segments, start, end)
    if not words:
        return 50.0
    wps = len(words) / duration
    return round(min(100.0, (wps / SPEAKING_WPS_CEILING) * 100.0), 1)


def speech_density_wps(segments: list[dict], start: float, end: float) -> float:
    """Raw words-per-second for the breakdown payload."""
    duration = max(end - start, 0.001)
    words = collect_words(segments, start, end)
    return round(len(words) / duration, 2)


def speaker_activity_score(
    segments: list[dict],
    start: float,
    end: float,
    face_active_ratio: float | None = None,
) -> float | None:
    """Speaker dynamism → 0–100, or None when no diarization labels exist.

    Blends two sub-signals:
    - coverage: fraction of the clip covered by labeled speech
    - alternation: distinct-speaker exchanges per minute (capped at 12)
    A caller-supplied face_active_ratio (from the face/reframe detector)
    is blended in at 40% when available.
    """
    labeled = [
        seg for seg in segments
        if seg.get("speaker") and float(seg.get("end", 0)) > start and float(seg.get("start", 0)) < end
    ]
    if not labeled:
        return None

    covered = 0.0
    speakers: set[str] = set()
    switches = 0
    prev_speaker: str | None = None
    ordered = sorted(labeled, key=lambda s: float(s.get("start", 0)))
    for seg in ordered:
        ss = float(seg.get("start", 0))
        se = float(seg.get("end", 0))
        covered += min(se, end) - max(ss, start)
        spk = str(seg.get("speaker"))
        speakers.add(spk)
        if prev_speaker is not None and spk != prev_speaker:
            switches += 1
        prev_speaker = spk

    duration = max(end - start, 0.001)
    coverage = min(1.0, max(0.0, covered / duration))
    alternation = min(1.0, (switches / max(duration / 60.0, 0.01)) / 12.0)
    score = coverage * 55 + alternation * 45
    if face_active_ratio is not None:
        ratio = min(1.0, max(0.0, face_active_ratio))
        score = score * 0.6 + ratio * 100.0 * 0.4
    return round(min(100.0, max(0.0, score)), 1)


def blend_clip_score(
    llm_score: float,
    signals: dict[str, float | None],
    weights: dict[str, float],
) -> dict:
    """Weighted blend of the LLM score with non-LLM signals.

    Missing (None) signals have their weight redistributed proportionally
    across the available components, so the composite stays comparable
    when e.g. no diarization labels exist.
    """
    components: dict[str, float] = {"llm": float(llm_score)}
    components.update({k: float(v) for k, v in signals.items() if v is not None})

    total_weight = sum(w for k, w in weights.items() if k in components)
    if total_weight <= 0:
        composite = llm_score
    else:
        composite = sum(
            components[k] * weights.get(k, 0.0) for k in components
        ) / total_weight

    composite = round(min(100.0, max(0.0, composite)), 1)
    return {
        "composite": composite,
        "components": {k: round(v, 1) for k, v in components.items()},
        "weights_applied": {
            k: weights.get(k, 0.0) for k in components
        },
        "missing_signals": sorted(k for k, v in signals.items() if v is None),
    }


async def decode_rms_curve(audio_path: str, timeout_s: float = 120.0) -> list[float]:
    """Decode full-file audio via FFmpeg and return the 1s RMS curve."""
    cmd = [
        "ffmpeg", "-i", audio_path,
        "-f", "s16le", "-acodec", "pcm_s16le",
        "-ar", "16000", "-ac", "1",
        "-y", "pipe:1",
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        proc.kill()
        return []
    if not stdout or len(stdout) < 200:
        return []
    return rms_curve_from_pcm(stdout)


def curve_from_json(raw: str | None) -> list[float]:
    """Parse a client-provided energy curve; tolerant of junk input."""
    if not raw:
        return []
    try:
        data = json.loads(raw)
        if isinstance(data, list):
            return [max(0.0, min(1.0, float(v))) for v in data if isinstance(v, (int, float))]
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return []


# Module-level singleton-style namespace (mirrors other services).
clip_signals = type("ClipSignals", (), {
    "decode_rms_curve": staticmethod(decode_rms_curve),
    "rms_curve_from_pcm": staticmethod(rms_curve_from_pcm),
})()
