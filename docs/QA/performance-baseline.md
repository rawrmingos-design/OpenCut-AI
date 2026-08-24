# Performance Baseline (SCRUM-49)

> Sumber: `scripts/perf/profile.mjs` → hasil JSON di `docs/QA/perf-baseline.json`.
> Jalankan ulang kapan saja:
>
> ```bash
> OPENCUTAI_API_KEY=... node scripts/perf/profile.mjs
> ```
>
> Harness mengukur **startup**, **preview**, dan **render** lalu menulis hasil ke
> `docs/QA/perf-baseline.json` (di-commit sebagai baseline yang dapat dibandingkan).

## Target & Hasil (baseline pertama, VPS Docker stack)

| Metrik | Target | Baseline | Status |
|--------|--------|----------|--------|
| Startup (load event) | <3000 ms (SCRUM-49 deskripsi) | **852 ms** | ✅ PASS |
| First Contentful Paint | <1800 ms | 880 ms | ✅ |
| Largest Contentful Paint | <2500 ms | 2560 ms | ⚠️ borderline |
| Long tasks saat hidrasi | informasi | 14 | — |
| Preview rAF (proxy) | ≥30 FPS native; headless = sanity only | 8 FPS (software renderer) | ℹ️ artifact headless |
| JS heap awal | <150 MB | 9.4 MB | ✅ |
| Render 5s 1080p (libx264 ultrafast) | informasi | 3941 ms cold / 3046 ms warm (~0.7x realtime) | — |

## Interpretasi

1. **Startup aman.** Load event 852ms dengan LCP 2.56s di server production via
   internet lokal; target tiket (<3s startup) terpenuhi dengan margin besar.
   LCP borderline karena hero image/landing; optimasi lanjutan (priority hints,
   image sizing) bisa dikerjakan kalau LCP mau dipangkas di bawah 2s.
2. **FPS headless bukan angka nyata.** Chromium headless tanpa GPU (swiftshader)
   membatasi rAF ~8fps. Angka ini hanya sanity check bahwa main thread tidak
   blocked; pengukuran FPS editor canvas yang sebenarnya harus dilakukan pada
   hardware Windows matrix (lihat SCRUM-48, bagian performa).
3. **Render pipeline sehat.** Encode software libx264 ultrafast 5s@1080p
   selesai dalam ~3–4 detik di CPU shared VPS (0.6–0.8x realtime). Warm run
   23% lebih cepat dari cold — indikasi cache FFmpeg/page cache bekerja.
   NVENC di mesin Windows akan jauh lebih cepat (cek test matrix).

## Cara reproduksi

```bash
# butuh: playwright-core (PLAYWRIGHT_CORE_PATH), chromium binary,
# docker CLI, ai-backend live, OPENCUTAI_API_KEY
node scripts/perf/profile.mjs --url https://opencut.imhaf.online
```

Exit code 0 = semua target terpenuhi; JSON baseline otomatis ditimpa.

## Tindak lanjut (tidak memblokir tiket ini)

- Ukur ulang FPS preview di mesin fisik (bukan headless) saat eksekusi SCRUM-48.
- Pertimbangkan trace CDP (`Tracing.start`) bila ingin flame chart per-route.
