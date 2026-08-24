"""SCRUM-71 regression tests for trim-window validation on /api/export/render.

Runs against a live stack (ai-backend on :8420). Negative cases use a path
inside the allowed dirs (validation runs before existence checks); the
positive case renders a real fixture copied into the ai_generated volume.
"""
import math
import os
import pathlib
import subprocess

import httpx
import pytest
from dotenv import load_dotenv

load_dotenv(pathlib.Path(__file__).resolve().parents[3] / ".env")
AI_BACKEND_URL = os.getenv("OPENCUTAI_API_URL", "http://localhost:8420")
HEADERS = {"X-API-Key": os.getenv("OPENCUTAI_API_KEY", "")}

CONTAINER = "opencut-ai-ai-backend-1"
FIXTURE = "/tmp/scrum71-fixture.mp4"


def _make_fixture(seconds: float) -> str:
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "lavfi",
            "-i", f"testsrc=duration={seconds}:size=320x240:rate=30",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
            "-shortest", "-pix_fmt", "yuv420p", FIXTURE,
        ],
        check=True,
        capture_output=True,
    )
    return FIXTURE


def _copy_into_container_volume() -> str:
    """Copy the fixture into the backend's GENERATED_DIR volume and return
    the in-container path used as input_path."""
    subprocess.run(
        ["docker", "cp", FIXTURE, f"{CONTAINER}:/app/generated/scrum71-fixture.mp4"],
        check=True,
        capture_output=True,
    )
    return "/app/generated/scrum71-fixture.mp4"


@pytest.mark.asyncio
async def test_rejects_end_without_start():
    async with httpx.AsyncClient(base_url=AI_BACKEND_URL, headers=HEADERS) as client:
        resp = await client.post(
            "/api/export/render",
            json={"input_path": "/app/generated/whatever.mp4", "end_time": 3},
            timeout=15,
        )
    assert resp.status_code == 400
    assert "together" in resp.text


@pytest.mark.asyncio
async def test_rejects_negative_start():
    async with httpx.AsyncClient(base_url=AI_BACKEND_URL, headers=HEADERS) as client:
        resp = await client.post(
            "/api/export/render",
            json={
                "input_path": "/app/generated/whatever.mp4",
                "start_time": -2,
                "end_time": 3,
            },
            timeout=15,
        )
    assert resp.status_code == 400
    assert "Invalid trim window" in resp.text


@pytest.mark.asyncio
async def test_rejects_inverted_window():
    async with httpx.AsyncClient(base_url=AI_BACKEND_URL, headers=HEADERS) as client:
        resp = await client.post(
            "/api/export/render",
            json={
                "input_path": "/app/generated/whatever.mp4",
                "start_time": 4,
                "end_time": 2,
            },
            timeout=15,
        )
    assert resp.status_code == 400
    assert "Invalid trim window" in resp.text


@pytest.mark.asyncio
async def test_rejects_end_beyond_source_duration():
    _make_fixture(6)
    src = _copy_into_container_volume()
    async with httpx.AsyncClient(base_url=AI_BACKEND_URL, headers=HEADERS) as client:
        resp = await client.post(
            "/api/export/render",
            json={"input_path": src, "start_time": 1, "end_time": 999},
            timeout=60,
        )
    assert resp.status_code == 400
    assert "exceeds input duration" in resp.text


@pytest.mark.asyncio
async def test_ranged_render_duration_matches_request():
    """The acceptance test: output duration ~= requested range ±0.5s."""
    _make_fixture(10)
    src = _copy_into_container_volume()
    async with httpx.AsyncClient(base_url=AI_BACKEND_URL, headers=HEADERS) as client:
        resp = await client.post(
            "/api/export/render",
            json={
                "input_path": src,
                "start_time": 2,
                "end_time": 7,
                "resolution": "320x240",
                "fps": 30,
                "preset": "ultrafast",
            },
            timeout=180,
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert math.isclose(body["duration"], 5.0, abs_tol=0.5), body
