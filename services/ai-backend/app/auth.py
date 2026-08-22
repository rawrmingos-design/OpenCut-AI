"""Authentication dependency for AI Backend."""

from fastapi import Security, HTTPException, status
from fastapi.security.api_key import APIKeyHeader
from app.config import settings

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

def get_api_key(key: str = Security(api_key_header)) -> str:
    """Validate the API key from the request header."""
    if not getattr(settings, "API_KEY", None):
        return "unauthenticated"
    if key == settings.API_KEY:
        return key
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Could not validate API key")
