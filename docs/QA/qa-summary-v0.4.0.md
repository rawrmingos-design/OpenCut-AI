# QA & Hardening Summary (v0.4.0)

> **Ticket:** SCRUM-63 (Umbrella for QA, Performance, Security)
> **Date:** 2026-08-24
> **Build Status:** PASSED 

## 1. Security Review (SCRUM-50)
- **Path Traversal Mitigation**: Diterapkan pada `/api/export/render`. File input direalisasikan jalurnya (`os.path.realpath`) dan ditolak jika berada di luar `UPLOAD_DIR` atau `GENERATED_DIR`.
- **FFmpeg Argument Injection Mitigation**: Parameter `output_format`, `video_codec`, `audio_codec`, dan `preset` diverifikasi dengan strict allowlist. Parameter bitrate divalidasi dengan strict Regex.
- **E2E Security Testing**: `test_export_security.py` menembakkan payload injection dan path-traversal. Semua serangan dimentahkan dengan HTTP 400. (PASS)

## 2. Error Handling Hardening (SCRUM-51 & SCRUM-47)
- **Global React ErrorBoundary**: Diterapkan di `error.tsx` dan `global-error.tsx`. 
- **Crash Reporting (Opt-In)**: API `/api/crash-report` berfungsi untuk menerima telemetri client-side hanya bila user setuju (Zustand state).
- **Rust Native Crash**: Ditangkap via `std::panic::set_hook` di Tauri, ditulis ke `crash.log` lokal tanpa menabrak batas dependensi di frontend. 

## 3. Performance Profiling (SCRUM-49)
- **Harness**: `scripts/perf/profile.mjs` dibuat dan masuk ke repository.
- **Startup**: `< 3 detik` (Target). Hasil aktual: **852ms** base load, FCP **880ms**, LCP **2.56s**. (PASS)
- **Backend Encoding**: 1080p 5-detik fixture di-encode ke H.264 ultrafast dalam ~3 detik via proxy API (`0.7x` realtime pada CPU virtual server). (PASS)

## 4. Test Matrix Definition (SCRUM-48)
- File `docs/QA/windows-test-matrix.md` telah disetujui. Matrix menyertakan pengujian P0 (Windows 11 Mid, GPU NVENC) hingga P1 (Windows 10 Low, No GPU) dan check parameter QA untuk setiap rilis.

## 5. Automated CI & Health Status
- **Playwright/Pytest**: 7/7 backend integration tests passed via Docker backend.
- **Health Checks**: 
  - Backend API (`:8420/health`) → HTTP 200
  - Frontend Proxy (`:3200/api/health`) → HTTP 200
  - Production Endpoint (`https://opencut.imhaf.online/`) → HTTP 200
- **Docker Build CI**: Selalu hijau (exit 0) pada Actions run `tauri-build.yml` terbaru.

---
**Verdict:** `v0.4.0` backend dan render UI siap untuk produksi dan peluncuran Desktop release. QA Umbrella selesai.