import os
import struct
import tempfile
import pytest
import httpx

AI_BACKEND_URL = os.getenv("OPENCUTAI_API_URL", "http://localhost:8420")

@pytest.fixture
def dummy_wav():
    """Generates a small valid WAV file for testing."""
    fd, path = tempfile.mkstemp(suffix=".wav")
    with os.fdopen(fd, "wb") as f:
        sample_rate = 16000
        num_samples = sample_rate // 2 # 0.5 sec
        data_size = num_samples * 2
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + data_size))
        f.write(b"WAVE")
        f.write(b"fmt ")
        f.write(struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16))
        f.write(b"data")
        f.write(struct.pack("<I", data_size))
        f.write(b"\x00" * data_size)
    yield path
    os.remove(path)

@pytest.fixture
def over_limit_wav():
    """Generates a dummy file that exceeds the default upload limit (typically > 200MB, we fake it with content-length)."""
    fd, path = tempfile.mkstemp(suffix=".wav")
    with os.fdopen(fd, "wb") as f:
        f.write(b"RIFF")
    yield path
    os.remove(path)

@pytest.mark.asyncio
async def test_transcribe_proxy_success(dummy_wav):
    """Test successful proxying of transcription to whisper-service."""
    async with httpx.AsyncClient(base_url=AI_BACKEND_URL) as client:
        with open(dummy_wav, "rb") as f:
            files = {"file": ("test.wav", f, "audio/wav")}
            # Also testing language parameter
            data = {"language": "en"}
            resp = await client.post("/api/transcribe", files=files, data=data, timeout=30)
            
        assert resp.status_code == 200
        result = resp.json()
        assert "text" in result
        assert "segments" in result
        assert result["language"] == "en"

@pytest.mark.asyncio
async def test_transcribe_proxy_unsupported_file():
    """Test proxy rejection of unsupported file types."""
    fd, path = tempfile.mkstemp(suffix=".pdf")
    with os.fdopen(fd, "wb") as f:
        f.write(b"fake pdf")
        
    async with httpx.AsyncClient(base_url=AI_BACKEND_URL) as client:
        with open(path, "rb") as f:
            files = {"file": ("test.pdf", f, "application/pdf")}
            resp = await client.post("/api/transcribe", files=files, timeout=5)
            
    os.remove(path)
    # whisper-service strictly checks extension
    assert resp.status_code == 400
    assert "Unsupported file type" in resp.text
