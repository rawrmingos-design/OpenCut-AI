"""SCRUM-78: bounded lifecycle for LLM-backed streaming jobs.

The existing generic JobQueue is used by media/background jobs. This module
keeps the HTTP-streamed LLM path separate and explicit: one job ID per
request, bounded admission, cancellation, state frames, a central timeout,
and per-endpoint timings.
"""

import asyncio
import logging
import time
import uuid
from collections.abc import AsyncGenerator, Awaitable, Callable, Coroutine
from typing import Any, cast

from app.config import settings

logger = logging.getLogger(__name__)

TERMINAL_STATES = {"completed", "failed", "cancelled"}
ACTIVE_STATES = {"queued", "running", "finalizing"}
JOB_TTL_SECONDS = 3600


class LLMJob:
    """In-process state record for one streamed LLM operation."""

    __slots__ = (
        "job_id",
        "endpoint",
        "state",
        "queue_position",
        "queued_at",
        "started_at",
        "finished_at",
        "error",
        "cancel_requested",
    )

    def __init__(self, endpoint: str) -> None:
        self.job_id = uuid.uuid4().hex[:12]
        self.endpoint = endpoint
        self.state = "queued"
        self.queue_position = 0
        self.queued_at = time.monotonic()
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.error: str | None = None
        self.cancel_requested = False

    def snapshot(self) -> dict[str, Any]:
        """Return a JSON-safe status object for ping and polling clients."""
        now = time.monotonic()
        wait_ms = int(((self.started_at or now) - self.queued_at) * 1000)
        run_ms = (
            int(((self.finished_at or now) - self.started_at) * 1000)
            if self.started_at
            else 0
        )
        return {
            "jobId": self.job_id,
            "endpoint": self.endpoint,
            "state": self.state,
            "queuePosition": self.queue_position if self.state == "queued" else 0,
            "waitMs": max(0, wait_ms),
            "runMs": max(0, run_ms),
            "error": self.error,
        }


class _EndpointMetrics:
    __slots__ = (
        "submitted",
        "completed",
        "failed",
        "cancelled",
        "queue_wait_ms_total",
        "inference_ms_total",
    )

    def __init__(self) -> None:
        self.submitted = 0
        self.completed = 0
        self.failed = 0
        self.cancelled = 0
        self.queue_wait_ms_total = 0
        self.inference_ms_total = 0


class _JobCancelled(Exception):
    """Internal sentinel converted to a terminal cancelled frame."""


class LLMPipeline:
    """Run LLM jobs with one bounded semaphore and explicit lifecycle state."""

    def __init__(self, concurrency: int | None = None) -> None:
        self.concurrency = max(1, concurrency or settings.LLM_QUEUE_CONCURRENCY)
        self._semaphore = asyncio.Semaphore(self.concurrency)
        self._jobs: dict[str, LLMJob] = {}
        self._work_tasks: dict[str, asyncio.Task[Any]] = {}
        self._metrics: dict[str, _EndpointMetrics] = {}

    # ── Registry ───────────────────────────────────────────────────────

    def _metrics_for(self, endpoint: str) -> _EndpointMetrics:
        if endpoint not in self._metrics:
            self._metrics[endpoint] = _EndpointMetrics()
        return self._metrics[endpoint]

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        job = self._jobs.get(job_id)
        return job.snapshot() if job else None

    def is_cancelled(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        return bool(job and (job.cancel_requested or job.state == "cancelled"))

    def queue_depth(self) -> int:
        return sum(job.state == "queued" for job in self._jobs.values())

    def _finish_cancelled(self, job: LLMJob, metrics: _EndpointMetrics, reason: str) -> None:
        """Set cancelled once; explicit cancel and disconnect can race."""
        if job.state in TERMINAL_STATES:
            return
        job.state = "cancelled"
        job.finished_at = time.monotonic()
        job.error = job.error or reason
        metrics.cancelled += 1
        end = job.started_at or job.finished_at
        metrics.queue_wait_ms_total += max(0, int((end - job.queued_at) * 1000))

    async def cancel_job(self, job_id: str) -> dict[str, Any]:
        """Cancel a queued/running job and abort its upstream work task."""
        job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if job.state in TERMINAL_STATES:
            return job.snapshot()

        job.cancel_requested = True
        task = self._work_tasks.get(job_id)
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

        self._finish_cancelled(job, self._metrics_for(job.endpoint), "Cancelled by client")
        return job.snapshot()

    def metrics_snapshot(self) -> dict[str, Any]:
        endpoints: dict[str, dict[str, Any]] = {}
        for endpoint, metrics in self._metrics.items():
            active = sum(
                job.endpoint == endpoint and job.state in ACTIVE_STATES
                for job in self._jobs.values()
            )
            endpoints[endpoint] = {
                "submitted": metrics.submitted,
                "completed": metrics.completed,
                "failed": metrics.failed,
                "cancelled": metrics.cancelled,
                "avgQueueWaitMs": (
                    int(metrics.queue_wait_ms_total / metrics.submitted)
                    if metrics.submitted
                    else 0
                ),
                "avgInferenceMs": (
                    int(metrics.inference_ms_total / metrics.completed)
                    if metrics.completed
                    else 0
                ),
                "activeNow": active,
            }
        return {
            "concurrency": self.concurrency,
            "queueDepth": self.queue_depth(),
            "endpoints": endpoints,
        }

    # ── Execution ──────────────────────────────────────────────────────

    async def run_streamed(
        self,
        endpoint: str,
        work: Callable[[], Coroutine[Any, Any, Any]] | Callable[[], Awaitable[Any]],
        *,
        error_detail: str = "Operation failed.",
        poll_interval: float = 5.0,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Yield lifecycle, keepalive, result, and error frames for one job."""
        job = LLMJob(endpoint)
        self._jobs[job.job_id] = job
        metrics = self._metrics_for(endpoint)
        metrics.submitted += 1
        work_task: asyncio.Task[Any] | None = None
        acquired = False

        try:
            yield {"job": job.snapshot()}

            # Admission control. A queued job periodically publishes its
            # position so clients can distinguish waiting from a hung request.
            while True:
                if self.is_cancelled(job.job_id):
                    raise _JobCancelled()
                try:
                    await asyncio.wait_for(
                        self._semaphore.acquire(), timeout=poll_interval
                    )
                    acquired = True
                    break
                except asyncio.TimeoutError:
                    waiting = sorted(
                        (candidate for candidate in self._jobs.values() if candidate.state == "queued"),
                        key=lambda candidate: candidate.queued_at,
                    )
                    job.queue_position = waiting.index(job) + 1 if job in waiting else 1
                    yield {"job": job.snapshot(), "ping": True}

            if self.is_cancelled(job.job_id):
                raise _JobCancelled()

            job.state = "running"
            job.started_at = time.monotonic()
            job.queue_position = 0
            yield {"job": job.snapshot()}

            created: asyncio.Future[Any] = asyncio.ensure_future(work())
            work_task = cast("asyncio.Task[Any]", created)
            self._work_tasks[job.job_id] = work_task
            deadline = time.monotonic() + settings.LLM_JOB_TIMEOUT

            while not work_task.done():
                if self.is_cancelled(job.job_id):
                    work_task.cancel()
                    await asyncio.gather(work_task, return_exceptions=True)
                    raise _JobCancelled()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    work_task.cancel()
                    await asyncio.gather(work_task, return_exceptions=True)
                    raise TimeoutError(
                        f"Job exceeded {settings.LLM_JOB_TIMEOUT}s server-side budget"
                    )
                try:
                    await asyncio.wait_for(
                        asyncio.shield(work_task),
                        timeout=min(poll_interval, remaining),
                    )
                except asyncio.TimeoutError:
                    yield {"ping": True, "job": job.snapshot()}
                except asyncio.CancelledError:
                    if self.is_cancelled(job.job_id):
                        raise _JobCancelled() from None
                    raise

            if self.is_cancelled(job.job_id):
                raise _JobCancelled()
            result = work_task.result()

            job.state = "finalizing"
            yield {"job": job.snapshot()}
            await asyncio.sleep(0)

            job.finished_at = time.monotonic()
            job.state = "completed"
            metrics.completed += 1
            metrics.queue_wait_ms_total += max(
                0, int((job.started_at - job.queued_at) * 1000)
            )
            metrics.inference_ms_total += max(
                0, int((job.finished_at - job.started_at) * 1000)
            )
            yield {"result": result}

        except _JobCancelled:
            if work_task and not work_task.done():
                work_task.cancel()
                await asyncio.gather(work_task, return_exceptions=True)
            self._finish_cancelled(job, metrics, "Cancelled by client")
            yield {"error": job.error or "Cancelled by client", "job": job.snapshot()}

        except asyncio.CancelledError:
            # Starlette closes the async generator on a disconnected client.
            # The finally block below performs the same upstream cancellation
            # and terminal bookkeeping without swallowing task cancellation.
            raise

        except TimeoutError as exc:
            job.state = "failed"
            job.finished_at = time.monotonic()
            job.error = str(exc)
            metrics.failed += 1
            logger.warning("LLM job %s timed out: %s", job.job_id, exc)
            yield {"error": str(exc) or error_detail, "job": job.snapshot()}

        except Exception as exc:
            job.state = "failed"
            job.finished_at = time.monotonic()
            job.error = str(exc)[:300] or error_detail
            metrics.failed += 1
            logger.exception("LLM job %s failed", job.job_id)
            yield {"error": job.error, "job": job.snapshot()}

        finally:
            if work_task and not work_task.done():
                work_task.cancel()
                await asyncio.gather(work_task, return_exceptions=True)
            self._work_tasks.pop(job.job_id, None)
            if acquired:
                self._semaphore.release()
            if job.state not in TERMINAL_STATES:
                self._finish_cancelled(job, metrics, "Client disconnected")
            self._cleanup()

    def _cleanup(self) -> None:
        now = time.monotonic()
        stale = [
            job_id
            for job_id, job in self._jobs.items()
            if job.state in TERMINAL_STATES
            and job.finished_at is not None
            and now - job.finished_at > JOB_TTL_SECONDS
        ]
        for job_id in stale:
            self._jobs.pop(job_id, None)

        if len(self._jobs) > 500:
            terminal = sorted(
                (
                    (job_id, job)
                    for job_id, job in self._jobs.items()
                    if job.state in TERMINAL_STATES
                ),
                key=lambda item: item[1].finished_at or 0,
            )
            for job_id, _ in terminal[: len(self._jobs) - 500]:
                self._jobs.pop(job_id, None)


# Shared pipeline for every route migrated through streamed_llm_response.
llm_pipeline = LLMPipeline()
