"""SCRUM-50 security regression tests for /api/export/render.

Runs against a live stack (ai-backend on :8420). Only exercises REJECTION
paths — no media files required.
"""
import os
import pytest
import httpx

AI_BACKEND_URL = os.getenv("OPENCUTAI_API_URL", "http://localhost:8420")


@pytest.mark.asyncio
async def test_render_rejects_path_outside_allowed_dirs():
    """input_path outside UPLOAD_DIR/GENERATED_DIR must be rejected (arbitrary read)."""
    async with httpx.AsyncClient(base_url=AI_BACKEND_URL) as client:
        resp = await client.post(
            "/api/export/render",
            json={"input_path": "/etc/passwd"},
            timeout=10,
        )
    assert resp.status_code == 400
    assert "Invalid input path" in resp.text


@pytest.mark.asyncio
async def test_render_rejects_traversal_path():
    """Encoded traversal must be rejected even if it resolves inside."""
    async with httpx.AsyncClient(base_url=AI_BACKEND_URL) as client:
        resp = await client.post(
            "/api/export/render",
            json={"input_path": "/tmp/../etc/shadow"},
            timeout=10,
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_render_rejects_ffmpeg_argument_injection_in_codec():
    """Codec field is interpolated into the command line — only allowlisted values pass."""
    async with httpx.AsyncClient(base_url=AI_BACKEND_URL) as client:
        # Use a plausible in-bounds input path; option validation runs BEFORE
        # existence check so no file needs to exist.
        resp = await client.post(
            "/api/export/render",
            json={
                "input_path": "/app/uploads/x.mp4",
                "video_codec": "libx264 -f hls -hls_segment_filename /pwned_%d.ts",
            },
            timeout=10,
        )
    assert resp.status_code == 400
    assert "Unsupported video codec" in resp.text


@pytest.mark.asyncio
async def test_render_rejects_invalid_bitrate():
    async with httpx.AsyncClient(base_url=AI_BACKEND_URL) as client:
        resp = await client.post(
            "/api/export/render",
            json={
                "input_path": "/app/uploads/x.mp4",
                "video_bitrate": "5M -preset ultrafast",
            },
            timeout=10,
        )
    assert resp.status_code == 400
    assert "Invalid video_bitrate" in resp.text


@pytest.mark.asyncio
async def test_render_accepts_valid_options_but_missing_file_is_404():
    """Whitelisted options + in-bounds path but nonexistent file -> 404 (not 400)."""
    async with httpx.AsyncClient(base_url=AI_BACKEND_URL) as client:
        resp = await client.post(
            "/api/export/render",
            json={
                "input_path": "/app/uploads/does-not-exist.mp4",
                "output_format": "mp4",
                "video_codec": "libx264",
                "audio_codec": "aac",
                "preset": "medium",
                "video_bitrate": "5M",
                "audio_bitrate": "192k",
            },
            timeout=15,
        )
    assert resp.status_code == 404
