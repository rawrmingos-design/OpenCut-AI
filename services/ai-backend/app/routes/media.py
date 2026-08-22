"""Media metadata probing via ffprobe."""
from __future__ import annotations

import json
import logging
from app.auth import get_api_key
import subprocess
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/media", tags=["media"], dependencies=[Depends(get_api_key)])

_PROBE_ARGS = [
    "-v", "error",
    "-show_entries",
    "format=duration,bit_rate,size,format_name",
    "-show_entries",
    "stream=index,codec_name,codec_type,width,height,avg_frame_rate,r_frame_rate,bit_rate,sample_rate,channels,channel_layout",
    "-of", "json",
]


def _parse_rate(value: str) -> float | None:
    """Convert ffprobe frame rate strings like '24/1' or '30000/1001' to fps."""
    try:
        if "/" in value:
            num, den = value.split("/", 1)
            num_f, den_f = float(num), float(den)
            return round(num_f / den_f, 4) if den_f else None
        return round(float(value), 4)
    except (ValueError, ZeroDivisionError):
        return None


def _probe_media(path: str) -> dict:
    cmd = ["ffprobe", *_PROBE_ARGS, path]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=500, detail="ffprobe timed out") from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail="ffprobe not available") from exc

    if result.returncode != 0:
        raise HTTPException(
            status_code=422,
            detail=f"Could not probe media: {result.stderr.strip()[:300]}",
        )

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="Invalid ffprobe output") from exc

    fmt = data.get("format", {})
    streams = data.get("streams", [])

    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    def _int(v):
        try:
            return int(v) if v not in (None, "N/A") else None
        except (TypeError, ValueError):
            return None

    def _float(v):
        try:
            return float(v) if v not in (None, "N/A") else None
        except (TypeError, ValueError):
            return None

    payload = {
        "duration": _float(fmt.get("duration")),
        "format_name": fmt.get("format_name"),
        "size_bytes": _int(fmt.get("size")),
        "bit_rate": _int(fmt.get("bit_rate")),
        "video": {
            "codec": video_stream.get("codec_name") if video_stream else None,
            "width": _int(video_stream.get("width")) if video_stream else None,
            "height": _int(video_stream.get("height")) if video_stream else None,
            "fps": _parse_rate(video_stream.get("avg_frame_rate")) if video_stream else None,
            "r_frame_rate": _parse_rate(video_stream.get("r_frame_rate")) if video_stream else None,
            "bit_rate": _int(video_stream.get("bit_rate")) if video_stream else None,
        } if video_stream else None,
        "audio": {
            "codec": audio_stream.get("codec_name") if audio_stream else None,
            "sample_rate": _int(audio_stream.get("sample_rate")) if audio_stream else None,
            "channels": _int(audio_stream.get("channels")) if audio_stream else None,
            "channel_layout": audio_stream.get("channel_layout") if audio_stream else None,
            "bit_rate": _int(audio_stream.get("bit_rate")) if audio_stream else None,
        } if audio_stream else None,
    }
    return payload


@router.post("/probe")
async def probe_media(file: UploadFile = File(...)):
    """Probe an uploaded media file and return metadata (duration, codecs, fps, bitrate, channels)."""
    if not file.filename:
        raise HTTPException(status_code=422, detail="Missing filename")

    suffix = Path(file.filename).suffix or ".bin"
    tmp_path = Path(tempfile.gettempdir()) / f"probe-{uuid.uuid4().hex}{suffix}"
    try:
        with tmp_path.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                out.write(chunk)
        return _probe_media(str(tmp_path))
    finally:
        tmp_path.unlink(missing_ok=True)
