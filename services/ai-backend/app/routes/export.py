"""Export / render routes using FFmpeg."""

import asyncio
import logging
from app.auth import get_api_key
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/export", tags=["export"], dependencies=[Depends(get_api_key)])

# SCRUM-50: strict whitelists — these values are interpolated into the FFmpeg
# command line, so anything outside the allowlist is rejected outright.
_ALLOWED_OUTPUT_FORMATS = {"mp4", "webm", "mov"}
_ALLOWED_VIDEO_CODECS = {"libx264", "libx265", "libvpx-vp9", "h264_nvenc", "hevc_nvenc"}
_ALLOWED_AUDIO_CODECS = {"aac", "libopus", "libmp3lame", "pcm_s16le"}
_ALLOWED_PRESETS = {
    "ultrafast", "superfast", "veryfast", "faster",
    "fast", "medium", "slow", "slower", "veryslow",
}
_BITRATE_RE = __import__("re").compile(r"^\d+[kKmM]?$")

# SCRUM-50: uploaded/generated files may only come from these directories.
_ALLOWED_INPUT_DIRS = [settings.UPLOAD_DIR, settings.GENERATED_DIR]


def _validate_input_path(path: str) -> str:
    """Reject paths outside UPLOAD_DIR/GENERATED_DIR (path traversal / arbitrary read)."""
    real = os.path.realpath(path)
    if not any(real.startswith(os.path.realpath(d) + os.sep) for d in _ALLOWED_INPUT_DIRS):
        raise HTTPException(status_code=400, detail="Invalid input path")
    return real


def _validate_render_options(request: "RenderRequest") -> None:
    """Reject any option value that is not on the FFmpeg argument whitelist."""
    import re

    if request.output_format not in _ALLOWED_OUTPUT_FORMATS:
        raise HTTPException(status_code=400, detail=f"Unsupported output format '{request.output_format}'")
    if request.video_codec not in _ALLOWED_VIDEO_CODECS:
        raise HTTPException(status_code=400, detail=f"Unsupported video codec '{request.video_codec}'")
    if request.audio_codec not in _ALLOWED_AUDIO_CODECS:
        raise HTTPException(status_code=400, detail=f"Unsupported audio codec '{request.audio_codec}'")
    if request.preset not in _ALLOWED_PRESETS:
        raise HTTPException(status_code=400, detail=f"Unsupported preset '{request.preset}'")
    for label, value in (("video_bitrate", request.video_bitrate), ("audio_bitrate", request.audio_bitrate)):
        if not _BITRATE_RE.match(value or ""):
            raise HTTPException(status_code=400, detail=f"Invalid {label} '{value}'")


class RenderRequest(BaseModel):
    """Request to render/export a video project."""

    input_path: str = Field(..., description="Path to the source video file")
    output_format: str = Field(default="mp4", description="Output format: mp4, webm, mov")
    resolution: str = Field(default="1920x1080", description="Output resolution WxH")
    fps: int = Field(default=30, ge=1, le=120, description="Output frame rate")
    video_codec: str = Field(default="libx264", description="Video codec")
    audio_codec: str = Field(default="aac", description="Audio codec")
    video_bitrate: str = Field(default="5M", description="Video bitrate")
    audio_bitrate: str = Field(default="192k", description="Audio bitrate")
    preset: str = Field(
        default="medium",
        description="Encoding preset: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow",
    )
    # Trim parameters
    start_time: float | None = Field(default=None, description="Start time in seconds")
    end_time: float | None = Field(default=None, description="End time in seconds")


class RenderResponse(BaseModel):
    output_path: str
    duration: float
    file_size_mb: float


@router.post("/render", response_model=RenderResponse)
async def render_video(request: RenderRequest) -> RenderResponse:
    """Render/export a video using FFmpeg.

    Applies the specified encoding settings and optional trimming.
    """
    # SCRUM-50: validate BEFORE touching the filesystem or building the command
    input_path = _validate_input_path(request.input_path)
    _validate_render_options(request)

    if not os.path.exists(input_path):
        raise HTTPException(status_code=404, detail="Input file not found.")

    output_filename = f"export_{uuid.uuid4().hex[:8]}.{request.output_format}"
    output_path = os.path.join(settings.GENERATED_DIR, output_filename)

    width, height = request.resolution.split("x")

    cmd = ["ffmpeg", "-y"]

    # Input trimming
    if request.start_time is not None:
        cmd.extend(["-ss", str(request.start_time)])
    cmd.extend(["-i", input_path])
    if request.end_time is not None:
        if request.start_time is not None:
            duration = request.end_time - request.start_time
            cmd.extend(["-t", str(duration)])
        else:
            cmd.extend(["-to", str(request.end_time)])

    # Video settings
    cmd.extend([
        "-vf", f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
        "-c:v", request.video_codec,
        "-b:v", request.video_bitrate,
        "-r", str(request.fps),
        "-preset", request.preset,
    ])

    # Audio settings
    cmd.extend([
        "-c:a", request.audio_codec,
        "-b:a", request.audio_bitrate,
    ])

    cmd.append(output_path)

    logger.info("Starting render: %s", " ".join(cmd))

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr_bytes = await proc.communicate()

    if proc.returncode != 0:
        stderr = stderr_bytes.decode("utf-8", errors="replace")
        logger.error("FFmpeg render failed: %s", stderr[-500:])
        raise HTTPException(status_code=500, detail="Video rendering failed.")

    # Get file info
    file_size = os.path.getsize(output_path) / (1024 * 1024)

    # Get duration via ffprobe
    duration = 0.0
    try:
        probe = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "quiet", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", output_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await probe.communicate()
        duration = float(stdout.decode().strip())
    except Exception:
        pass

    logger.info("Render complete: %s (%.1f MB, %.1fs)", output_path, file_size, duration)

    return RenderResponse(
        output_path=output_path,
        duration=round(duration, 3),
        file_size_mb=round(file_size, 2),
    )
