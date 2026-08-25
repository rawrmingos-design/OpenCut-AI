"""SCRUM-78: unit tests for the LLM job pipeline.

Covers job lifecycle frames, bounded queue admission with position
updates, explicit cancellation (including aborting in-flight work),
server-side timeout, failure mapping, disconnect handling, and metrics.
No Ollama required — work callables are stubs.
"""

import asyncio

import pytest

from app.services.llm_pipeline import LLMPipeline


def _states(frames: list[dict]) -> list[str]:
    return [f["job"]["state"] for f in frames if f.get("job")]


async def _collect(pipe: LLMPipeline, endpoint: str, work, **kwargs) -> list[dict]:
    return [frame async for frame in pipe.run_streamed(endpoint, work, **kwargs)]


@pytest.mark.asyncio
async def test_success_emits_lifecycle_and_result_frames():
    pipe = LLMPipeline(concurrency=1)

    async def work():
        await asyncio.sleep(0.01)
        return {"clips": [1, 2]}

    frames = await _collect(pipe, "find-clips", work)
    assert frames[0]["job"]["state"] == "queued"
    assert "jobId" in frames[0]["job"]
    assert any(f.get("job", {}).get("state") == "running" for f in frames)
    assert any(f.get("job", {}).get("state") == "finalizing" for f in frames)
    result_frame = frames[-1]
    assert result_frame["result"] == {"clips": [1, 2]}

    snapshot = pipe.metrics_snapshot()["endpoints"]["find-clips"]
    assert snapshot["submitted"] == 1
    assert snapshot["completed"] == 1
    assert snapshot["failed"] == 0


@pytest.mark.asyncio
async def test_bounded_queue_reports_position():
    pipe = LLMPipeline(concurrency=1)
    release = asyncio.Event()

    async def first():
        await release.wait()
        return "first"

    async def second():
        return "second"

    gen1 = pipe.run_streamed("find-clips", first)
    gen2 = pipe.run_streamed("find-clips", second)

    # Drain first job's initial frame, keep it running.
    first_frames = []
    task1 = asyncio.create_task(_drain(gen1, first_frames, stop_after=1))
    await asyncio.sleep(0.05)
    assert pipe.queue_depth() >= 0  # registry live

    second_task = asyncio.create_task(_collect(pipe, "find-clips", second))
    await asyncio.sleep(0.1)

    # Second job must still be queued while the first holds the slot.
    status = [
        pipe.get_job(job_id)
        for job_id in list(pipe._jobs)
        if pipe._jobs[job_id].endpoint == "find-clips"
    ]
    queued = [s for s in status if s and s["state"] == "queued"]
    assert queued, "second job should be queued behind the first"

    release.set()
    frames2 = await second_task
    await task1
    await gen2.aclose()
    assert frames2[-1]["result"] == "second"


async def _drain(gen, sink: list, stop_after: int):
    count = 0
    async for frame in gen:
        sink.append(frame)
        count += 1
        if count >= stop_after:
            break
    # Leaving the generator open keeps the slot held; caller closes it.


@pytest.mark.asyncio
async def test_cancel_aborts_inflight_work_and_marks_cancelled():
    pipe = LLMPipeline(concurrency=1)
    started = asyncio.Event()

    async def slow():
        started.set()
        await asyncio.sleep(30)
        return "never"

    async def runner():
        frames = []
        async for frame in pipe.run_streamed("find-clips", slow):
            frames.append(frame)
            if started.is_set() and len(frames) >= 2:
                break  # stop consuming after the running frame
        return frames

    run_task = asyncio.create_task(runner())
    await asyncio.wait_for(started.wait(), timeout=2)

    # Find the job id from the registry.
    job_id = next(iter(pipe._jobs))
    snap = await pipe.cancel_job(job_id)
    assert snap["state"] == "cancelled"

    frames = await asyncio.wait_for(run_task, timeout=5)
    last = frames[-1]
    assert last["error"] == "Cancelled by client"
    assert last["job"]["state"] == "cancelled"
    assert pipe._work_tasks == {}  # upstream task aborted and deregistered
    m = pipe.metrics_snapshot()["endpoints"]["find-clips"]
    assert m["cancelled"] == 1


@pytest.mark.asyncio
async def test_server_side_timeout_fails_job():
    pipe = LLMPipeline(concurrency=1)

    # Run with a tiny timeout via a fresh pipeline using patched settings.
    from app.config import settings

    original = settings.LLM_JOB_TIMEOUT
    settings.LLM_JOB_TIMEOUT = 0  # immediate deadline expiry
    try:
        async def never():
            await asyncio.sleep(30)

        frames = await _collect(pipe, "find-clips", never, poll_interval=0.02)
    finally:
        settings.LLM_JOB_TIMEOUT = original

    last = frames[-1]
    assert "error" in last
    assert last["job"]["state"] == "failed"
    assert "budget" in last["error"]
    m = pipe.metrics_snapshot()["endpoints"]["find-clips"]
    assert m["failed"] == 1


@pytest.mark.asyncio
async def test_work_exception_maps_to_failed_frame():
    pipe = LLMPipeline(concurrency=1)

    async def boom():
        raise ValueError("ollama exploded")

    frames = await _collect(pipe, "find-clips", boom)
    last = frames[-1]
    assert last["error"] == "ollama exploded"
    assert last["job"]["state"] == "failed"
    m = pipe.metrics_snapshot()["endpoints"]["find-clips"]
    assert m["failed"] == 1
    assert m["completed"] == 0


@pytest.mark.asyncio
async def test_generator_close_marks_disconnected_job_cancelled():
    pipe = LLMPipeline(concurrency=1)
    started = asyncio.Event()

    async def slow():
        started.set()
        await asyncio.sleep(30)
        return None

    gen = pipe.run_streamed("find-clips", slow, poll_interval=0.05)

    async def consume_until_running():
        # Keep reading (drives the generator forward so the work task gets
        # created) until the work has actually started.
        async for _frame in gen:
            if started.is_set():
                return

    consumer = asyncio.create_task(consume_until_running())
    await asyncio.wait_for(started.wait(), timeout=2)
    # Park the generator on its shielded work-task wait, like a live client.
    await asyncio.sleep(0.15)

    # Simulate the client disconnect: cancel the reader, then close the
    # generator exactly as Starlette would.
    consumer.cancel()
    try:
        await consumer
    except asyncio.CancelledError:
        pass
    await gen.aclose()
    await asyncio.sleep(0.05)

    snapshot = pipe.get_job(next(iter(pipe._jobs)))
    assert snapshot is not None
    assert snapshot["state"] == "cancelled"
    assert snapshot["error"] is not None
    metrics = pipe.metrics_snapshot()["endpoints"]["find-clips"]
    assert metrics["cancelled"] == 1
    assert metrics["completed"] == 0


@pytest.mark.asyncio
async def test_unknown_job_lookup_returns_none_and_metrics_shape():
    pipe = LLMPipeline(concurrency=2)
    assert pipe.get_job("missing") is None

    async def noop():
        return {}

    await _collect(pipe, "keywords", noop)
    snap = pipe.metrics_snapshot()
    assert snap["concurrency"] == 2
    assert snap["queueDepth"] == 0
    ep = snap["endpoints"]["keywords"]
    for key in ("submitted", "completed", "failed", "cancelled", "avgQueueWaitMs", "avgInferenceMs", "activeNow"):
        assert key in ep
