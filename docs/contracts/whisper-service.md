# Whisper Service API Contract (SCRUM-34)

## Service Overview
**Service Name**: `whisper-service`
**Port**: `8421` (internal Docker network)
**Proxy Route**: `ai-backend:8420/api/transcribe` -> `whisper-service:8421/transcribe`
**Engine**: `faster-whisper`
**Hardware**: CPU (with optional GPU acceleration depending on `WHISPER_DEVICE`)

## Endpoints

### 1. `GET /health`
Verifies service health and current model loaded in memory.
**Response**:
```json
{
  "status": "ok",
  "service": "whisper",
  "model": {
    "loaded": true,
    "model_size": "base",
    "device": "cpu",
    "compute_type": "int8"
  }
}
```

### 2. `GET /models`
Lists available model sizes and device support.

### 3. `POST /transcribe`
The primary route. Uploads are strictly proxied from `ai-backend` to avoid duplicate disk writes.
**Content-Type**: `multipart/form-data`
**Payload**:
- `file`: Audio or video file (WAV, MP3, MP4, MKV, etc.). Max 256MB on proxy side.
- `language` (optional): Two-letter ISO language code (e.g., "en", "id"). Defaults to auto-detect.

**Response**:
`TranscriptionResult` (JSON)
```json
{
  "text": "Full transcribed string joined",
  "language": "en",
  "duration": 14.5,
  "segments": [
    {
      "id": 0,
      "text": "Hello world.",
      "start": 0.0,
      "end": 1.5,
      "avg_logprob": -0.23,
      "no_speech_prob": 0.01,
      "words": [
        {
          "word": "Hello",
          "start": 0.0,
          "end": 0.7,
          "probability": 0.99
        },
        {
          "word": "world.",
          "start": 0.8,
          "end": 1.5,
          "probability": 0.98
        }
      ]
    }
  ]
}
```

## Error Handling
- `400 Bad Request`: Unsupported file type.
- `413 Payload Too Large`: Enforced by `ai-backend` before proxying.
- `503 Service Unavailable`: If `ai-backend` cannot reach `whisper-service:8421`.
