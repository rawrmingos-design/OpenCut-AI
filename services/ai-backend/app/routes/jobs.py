"""SCRUM-78: job status / cancel / metrics routes for streamed LLM jobs."""

import logging

from fastapi import APIRouter, HTTPException

from app.services.llm_pipeline import llm_pipeline

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/llm-jobs", tags=["llm-jobs"])


@router.get("/metrics")
async def llm_metrics() -> dict:
    """Queue wait / inference duration / cancellation / failure metrics."""
    return llm_pipeline.metrics_snapshot()


@router.get("/{job_id}")
async def get_job(job_id: str) -> dict:
    """Poll a job's lifecycle state (queued/running/finalizing/terminal)."""
    snapshot = llm_pipeline.get_job(job_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Unknown job id.")
    return snapshot


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: str) -> dict:
    """Cancel a queued or running job; aborts its in-flight task."""
    try:
        return await llm_pipeline.cancel_job(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown job id.") from None
