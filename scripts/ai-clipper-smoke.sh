#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${1:-/home/fahmi/smoke-fixture.mp4}"
BACKEND="${BACKEND_URL:-http://127.0.0.1:8420}"

[[ -f "$FIXTURE" ]] || { echo "fixture not found: $FIXTURE" >&2; exit 2; }

curl --fail-with-body --silent --show-error "$BACKEND/health" >/tmp/ai-clipper-backend-health.json
curl --fail-with-body --silent --show-error \
  -F "file=@${FIXTURE}" -F "language=en" \
  "$BACKEND/api/transcribe" >/tmp/ai-clipper-transcription.json

curl --fail-with-body --silent --show-error \
  -F "file=@${FIXTURE}" \
  -F 'transcript_text=Hello and welcome to this AI Clipper smoke test. We are testing clip suggestions and export.' \
  "$BACKEND/api/engagement/score-video" >/tmp/ai-clipper-score.json

printf 'backend: '; python3 -c 'import json; print(json.load(open("/tmp/ai-clipper-backend-health.json"))["available"])'
printf 'transcription: '; python3 -c 'import json; d=json.load(open("/tmp/ai-clipper-transcription.json")); print(d.get("duration"), "seconds", len(d.get("segments", [])), "segments")'
printf 'score: '; python3 -c 'import json; d=json.load(open("/tmp/ai-clipper-score.json")); d=d.get("result",d); print(d.get("composite"), d.get("grade"))'
printf 'smoke outputs: /tmp/ai-clipper-{backend-health,transcription,score}.json\n'

echo "AI Clipper API smoke checks passed"
