"""Streaming utilities for LLM-backed endpoints.

Two helpers live here:

- ``streamed_llm_job`` (SCRUM-78): wraps a long-running LLM operation in the
  shared ``llm_pipeline`` — every request gets a job ID, explicit state
  frames (queued → running → finalizing), bounded queue admission, a
  server-side wall-clock timeout, cancellation on client disconnect, and
  per-endpoint metrics. Frame order:
      {"job": {...state...}}   lifecycle transitions (and queued pings)
      {"ping": true}           keepalive while inference is in flight
      {"result": {...}}        final output (success)
      {"error": "..."}         failure / timeout / cancellation

- ``streamed_llm_response``: legacy plain keepalive stream (pings + result).
  The NDJSON contract is unchanged; routes migrate one by one.

Usage in routes:
    from app.services.stream_utils import streamed_llm_job

    @router.post("/my-endpoint")
    async def my_endpoint(request: MyRequest):
        async def _run():
            data = await llm_backend.generate_json(prompt=...)
            return {"result": data}

        return streamed_llm_job("my-endpoint", _run)
"""

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi.responses import StreamingResponse

from app.services.llm_pipeline import llm_pipeline

logger = logging.getLogger(__name__)

KEEPALIVE_INTERVAL = 5  # seconds between pings


def _ndjson_headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }


def streamed_llm_job(
    endpoint: str,
    work: Callable[[], Awaitable[Any]],
    *,
    error_detail: str = "Operation failed.",
) -> StreamingResponse:
    """Run ``work`` under the shared LLM pipeline and stream job frames.

    A client disconnect closes this generator; Starlette throws
    ``GeneratorExit`` into it, so the ``finally`` block below converts the
    close into a cancelled terminal state and aborts upstream work.
    """

    async def _stream():
        agen = llm_pipeline.run_streamed(endpoint, work, error_detail=error_detail)
        try:
            async for frame in agen:
                yield json.dumps(frame) + "\n"
        finally:
            # Early close (client disconnect) must land a terminal state and
            # free the concurrency slot.
            await agen.aclose()

    return StreamingResponse(
        _stream(),
        media_type="application/x-ndjson",
        headers=_ndjson_headers(),
    )


def streamed_llm_response(
    work: Callable[[], Awaitable[Any]],
    error_status: int = 500,
    error_detail: str = "Operation failed.",
) -> StreamingResponse:
    """Legacy keepalive-only stream (no job tracking). Unchanged contract."""

    async def _stream():
        task = asyncio.create_task(work())
        try:
            while not task.done():
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout=KEEPALIVE_INTERVAL)
                    # Task completed
                    break
                except (asyncio.TimeoutError, TimeoutError):
                    # Still running — send keepalive
                    yield json.dumps({"ping": True}) + "\n"

            result = task.result()
            yield json.dumps({"result": result}) + "\n"

        except Exception as exc:
            logger.exception("Streamed LLM operation failed")
            if not task.done():
                task.cancel()
            yield json.dumps({"error": str(exc) or error_detail}) + "\n"

    return StreamingResponse(
        _stream(),
        media_type="application/x-ndjson",
        headers=_ndjson_headers(),
    )
