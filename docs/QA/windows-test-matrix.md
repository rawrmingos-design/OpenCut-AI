# Windows Test Matrix (SCRUM-48)

> Manual + semi-automated QA matrix untuk build Windows (Tauri `.exe` / NSIS installer).
> Eksekusi: jalankan setiap baris checklist pada **setiap** mesin di matriks hardware.
> Hasil dicatat di tabel "Run Log" per rilis.

## 1. Hardware / OS Matrix

| ID | OS | Spec Tier | CPU | RAM | GPU | Storage | Prioritas |
|----|----|-----------|-----|-----|-----|---------|-----------|
| W10-LOW | Windows 10 22H2 | Low | 4-core (mis. i5-7400 / Ryzen 3 1200) | 8 GB | Intel UHD 630 (no NVENC) | HDD 7200rpm, ≥20GB free | P1 |
| W10-MID | Windows 10 22H2 | Mid | 6-core (i5-10400 / Ryzen 5 3600) | 16 GB | GTX 1650 (NVENC) | SATA SSD | P1 |
| W11-MID | Windows 11 23H2 | Mid | 6-core (i5-12400 / Ryzen 5 5600) | 16 GB | RTX 3050 (NVENC) | NVMe SSD | P0 |
| W11-HIGH | Windows 11 24H2 | High | 8+ core (i7-13700 / Ryzen 7 7700) | 32 GB | RTX 4070 (AV1 encode) | NVMe Gen4 | P2 |
| VM-W11 | Windows 11 (VM) | Smoke | 4 vCPU | 8 GB | VirtIO/swiftshader | — | P3 smoke only |

Aturan minimum:
- **P0** wajib lulus sebelum release. **P1** wajib lulus sebelum minor release.
- VM hanya untuk smoke test instalasi & launch; hasil render tidak dijadikan acuan performa.

## 2. Instalasi & First-run (semua mesin)

- [ ] Installer NSIS jalan tanpa SmartScreen block pada signed build
- [ ] Path install default `C:\Users\<user>\AppData\Local\OpenCutAI` benar
- [ ] Path install custom dengan **spasi** (`C:\Program Files\OpenCut AI`) aman
- [ ] First launch membuat struktur data lokal (IndexedDB/OPFS) tanpa error
- [ ] Onboarding tampil sekali; skip tidak memunculkan error boundary
- [ ] Uninstall bersih: tidak ada sisa di `AppData\Roaming`, kecuali user data yang diminta dipertahankan

## 3. Checklist per Epic

### E1 · Media Import & Timeline
- [ ] Import file via dialog native (path dengan spasi + unicode `é`,`ñ`)
- [ ] Import file dari path panjang (>260 char) — Win32 long path
- [ ] Drag-drop dari Explorer ke timeline
- [ ] Proxy generation otomatis untuk video 4K (tier low: proxy wajib, bukan asli)
- [ ] Thumbnail/filmstrip tergenerate untuk mp4/mov/webm

### E2 · Playback
- [ ] Play/pause/seek halus di tier low (proxy 540p)
- [ ] Frame-accurate seek pada clip 30fps dan 60fps
- [ ] Audio sink tidak drift >100ms selama playback 5 menit
- [ ] Multi-track playback (2 video overlay + 1 audio)

### E3 · AI Features (backend lokal/VPS)
- [ ] Status `/health` mendeteksi backend (whisper/tts/image online)
- [ ] Transcribe audio 1 menit < 60s di tier mid (faster-whisper base)
- [ ] Transcribe offline gagal graceful (toast error, tidak crash)
- [ ] TTS generate + insert ke timeline
- [ ] Background removal pada gambar 1080p selesai tanpa OOM di tier low (8GB)

### E4 · Export & Render Queue (SCRUM-24/25/33/35)
- [ ] Export single project → status preparing→rendering→finalizing→done
- [ ] Enqueue 3 export berbeda format (mp4/webm/mov) → diproses berurutan
- [ ] Cancel job berstatus rendering → state `cancelled`, FFmpeg process mati (cek Task Manager)
- [ ] Retry job `failed` → berjalan ulang dari awal
- [ ] Clear finished menghapus list tanpa mengganggu job aktif
- [ ] **Temp cleanup**: setelah export/cancel/fail, folder temp render kosong (`%TEMP%\opencut-render-*`)
- [ ] Output file playable (VLC/Windows Media Player) dan duration sesuai timeline

### E5 · Crash Reporting & Resilience (SCRUM-47/51)
- [ ] Opt-in crash reporting default **OFF** pada first run
- [ ] Saat ON: trigger error JS (dev build) → POST `/api/crash-report` terkirim
- [ ] Rust panic (dev build) menulis `crash.log` lokal
- [ ] ErrorBoundary menampilkan fallback UI, tombol reload bekerja
- [ ] Kill backend saat transcribe → UI tidak freeze, muncul error toast

### E6 · PWA / Offline (web build)
- [ ] Service worker cache UI: second load jalan offline (DevTools → Offline)
- [ ] Export tetap berfungsi offline (native FFmpeg lokal)
- [ ] Update SW: versi baru terdeteksi setelah reload

## 4. Performa Sanity (bukan benchmark penuh — lihat SCRUM-49)

| Metric | Low | Mid | High |
|--------|-----|-----|------|
| Cold start → editor siap | <15s | <8s | <5s |
| RAM idle editor | <1.5GB | <1.2GB | <1.2GB |
| Export 1-menit 1080p (software) | <4 min | <2 min | <1 min |
| Export 1-menit 1080p (NVENC) | n/a | <45s | <25s |

Gagal threshold = bug perf, catat ke SCRUM-49.

## 5. Run Log Template (per release)

| Date | Build | Matrix ID | Epic | Result (PASS/FAIL) | Notes/Bug |
|------|-------|-----------|------|--------------------|-----------|
| | | | | | |

## 6. Known Windows Quirks to Watch

- WebView2 version drift antar mesin — selalu cek `edge://version`
- NVENC session limit (consumer GPU = 5 concurrent) — queue membatasi 1 render
- Antivirus/Defender dapat memperlambat first-write OPFS secara signifikan
- Long path butuh registry `LongPathsEnabled=1`; installer NSIS default meng-handle
