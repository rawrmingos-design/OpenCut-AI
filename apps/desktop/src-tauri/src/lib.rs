use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Deserialize)]
pub struct ClipSpec {
    pub src: String,
    pub in_point: f64,
    pub out_point: f64,
    #[serde(default = "default_volume")]
    pub volume: f64,
}

fn default_volume() -> f64 {
    1.0
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenderRequest {
    pub clips: Vec<ClipSpec>,
    pub out_path: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    #[serde(default = "default_codec")]
    pub codec: String,
    #[serde(default = "default_bitrate")]
    pub bitrate_kbps: u32,
    #[serde(default = "default_true")]
    pub has_audio: bool,
}

fn default_codec() -> String {
    "h264".into()
}

fn default_bitrate() -> u32 {
    8000
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
pub struct RenderProgress {
    pub frame: u64,
    pub total_frames: u64,
    pub percent: f64,
    pub fps: f64,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct RenderState {
    pub(crate) cancelled: Arc<AtomicBool>,
    pub(crate) child_pid: Arc<Mutex<Option<u32>>>,
}

pub mod commands;

pub(crate) fn detect_hw_encoder(ffmpeg_path: &str, codec_base: &str) -> String {
    let candidates: &[&str] = match codec_base {
        "hevc" => &["hevc_nvenc", "hevc_qsv", "hevc_amf", "libx265"],
        "vp9" => &["vp9_qsv", "libvpx-vp9"],
        _ => &["h264_nvenc", "h264_qsv", "h264_amf", "libx264"],
    };

    for enc in candidates {
        let probe = Command::new(ffmpeg_path)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=128x72:d=0.2:r=2",
                "-c:v",
                enc,
                "-frames:v",
                "1",
                "-f",
                "null",
                "-",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if matches!(probe, Ok(status) if status.success()) {
            return (*enc).to_string();
        }
    }

    match codec_base {
        "hevc" => "libx265",
        "vp9" => "libvpx-vp9",
        _ => "libx264",
    }
    .to_string()
}

pub(crate) fn run_render(
    app: AppHandle,
    request: RenderRequest,
    cancelled: Arc<AtomicBool>,
    pid_slot: Arc<Mutex<Option<u32>>>,
) -> Result<(), String> {
    let ffmpeg = ffmpeg_path(&app);
    let encoder = detect_hw_encoder(&ffmpeg, &request.codec);

    let clip_count = request.clips.len();
    if clip_count == 0 {
        return Err("No clips to render".into());
    }
    cancelled.store(false, Ordering::SeqCst);

    let mut args: Vec<String> = Vec::new();
    let mut filter_parts: Vec<String> = Vec::new();
    let mut video_labels = String::new();
    let mut audio_labels = String::new();

    for (index, clip) in request.clips.iter().enumerate() {
        args.extend([
            "-ss".into(),
            format!("{:.6}", clip.in_point),
            "-to".into(),
            format!("{:.6}", clip.out_point),
            "-i".into(),
            clip.src.clone(),
        ]);
        filter_parts.push(format!(
            "[{index}:v]scale={width}:{height}:flags=lanczos,setsar=1,fps={fps}[v{index}]",
            width = request.width,
            height = request.height,
            fps = request.fps,
        ));
        if request.has_audio {
            filter_parts.push(format!(
                "[{index}:a]aresample=async=1,volume={volume:.4}[a{index}]",
                volume = clip.volume,
            ));
        }
        video_labels.push_str(&format!("[v{index}]"));
        audio_labels.push_str(&format!("[a{index}]"));
    }

    let mut filter = filter_parts.join(";");
    if clip_count > 1 {
        filter.push_str(&format!(
            "{video_labels}{audio_labels}concat=n={clip_count}:v=1:a=1"
        ));
        if request.has_audio {
            filter.push_str("[vcat][acat]");
        } else {
            filter.push_str("[vcat]");
        }
    }
    args.extend(["-filter_complex".into(), filter]);

    if clip_count > 1 && request.has_audio {
        args.extend([
            "-map".into(),
            "[vcat]".into(),
            "-map".into(),
            "[acat]".into(),
        ]);
    } else if clip_count > 1 {
        args.extend(["-map".into(), "[vcat]".into()]);
    } else if request.has_audio {
        args.extend([
            "-map".into(),
            "[v0]".into(),
            "-map".into(),
            "[a0]".into(),
        ]);
    } else {
        args.extend(["-map".into(), "[v0]".into()]);
    }
    if !request.has_audio {
        args.push("-an".into());
    }

    let total_frames: u64 = request
        .clips
        .iter()
        .map(|clip| ((clip.out_point - clip.in_point) * request.fps as f64).ceil() as u64)
        .sum();

    args.extend([
        "-c:v".into(),
        encoder,
        "-b:v".into(),
        format!("{}k", request.bitrate_kbps),
    ]);
    if request.has_audio {
        args.extend([
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
        ]);
    }
    args.extend([
        "-movflags".into(),
        "+faststart".into(),
        "-y".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-loglevel".into(),
        "error".into(),
        request.out_path.clone(),
    ]);

    let mut child = Command::new(&ffmpeg)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to start FFmpeg: {error}"))?;

    *pid_slot.lock().unwrap() = Some(child.id());

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let error_thread = std::thread::spawn(move || {
        let mut output = String::new();
        for line in BufReader::new(stderr).lines().flatten() {
            output.push_str(&line);
            output.push('\n');
        }
        output
    });

    let reader = BufReader::new(stdout);
    let mut current_frame = 0_u64;
    let mut current_fps = 0.0_f64;

    for line in reader.lines() {
        if cancelled.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            *pid_slot.lock().unwrap() = None;
            let _ = app.emit(
                "render-progress",
                RenderProgress {
                    frame: current_frame,
                    total_frames,
                    percent: current_frame as f64 / total_frames.max(1) as f64,
                    fps: current_fps,
                    done: false,
                    error: Some("cancelled".into()),
                },
            );
            return Err("cancelled".into());
        }

        let Ok(line) = line else { break };
        if let Some(value) = line.strip_prefix("frame=") {
            current_frame = value.trim().parse().unwrap_or(current_frame);
        } else if let Some(value) = line.strip_prefix("fps=") {
            current_fps = value.trim().parse().unwrap_or(current_fps);
        } else if line == "progress=continue" || line == "progress=end" {
            let percent = (current_frame as f64 / total_frames.max(1) as f64).min(1.0);
            let _ = app.emit(
                "render-progress",
                RenderProgress {
                    frame: current_frame,
                    total_frames,
                    percent,
                    fps: current_fps,
                    done: line == "progress=end",
                    error: None,
                },
            );
        }
    }

    let status = child.wait().map_err(|error| error.to_string())?;
    *pid_slot.lock().unwrap() = None;
    let stderr_output = error_thread.join().unwrap_or_default();

    if !status.success() {
        let mut lines = stderr_output.lines().rev().take(6).collect::<Vec<_>>();
        lines.reverse();
        return Err(format!(
            "FFmpeg failed (code {:?}): {}",
            status.code(),
            lines.join("\n")
        ));
    }

    Ok(())
}

pub(crate) fn ffmpeg_path(app: &AppHandle) -> String {
    app.path()
        .resource_dir()
        .ok()
        .map(|directory| {
            directory
                .join("binaries/ffmpeg")
                .with_extension(if cfg!(target_os = "windows") {
                    "exe"
                } else {
                    ""
                })
                .to_string_lossy()
                .into_owned()
        })
        .unwrap_or_else(|| "ffmpeg".into())
}

pub(crate) fn kill_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    #[cfg(not(target_os = "windows"))]
    let _ = Command::new("kill")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install a panic hook so Rust-side panics are persisted to a crash log
    // instead of vanishing silently (SCRUM-47 hardening). Std-only on purpose:
    // no chrono/dirs deps; timestamp = unix seconds, path resolved manually.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let msg = info.to_string();
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".into());
        let line = format!("[{ts}] PANIC at {loc}: {msg}\n");
        // Best-effort append; never panic inside the panic hook.
        let base = if cfg!(target_os = "windows") {
            std::env::var("APPDATA").ok().map(std::path::PathBuf::from)
        } else {
            std::env::var("XDG_DATA_HOME")
                .ok()
                .map(std::path::PathBuf::from)
                .or_else(|| {
                    std::env::var("HOME")
                        .ok()
                        .map(|h| std::path::PathBuf::from(h).join(".local/share"))
                })
        };
        if let Some(dir) = base.map(|b| b.join("com.opencutai.desktop")) {
            let _ = std::fs::create_dir_all(&dir);
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("crash.log"))
            {
                let _ = f.write_all(line.as_bytes());
            }
        }
        eprint!("{line}");
        default_hook(info);
    }));

    tauri::Builder::default()
        .manage(RenderState::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(if cfg!(debug_assertions) {
                        log::LevelFilter::Debug
                    } else {
                        log::LevelFilter::Info
                    })
                    .build(),
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::probe_hw_encoder,
            commands::render_video_native,
            commands::cancel_render,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn falls_back_to_cpu_encoder_name() {
        assert_eq!(
            match "h264" {
                "hevc" => "libx265",
                "vp9" => "libvpx-vp9",
                _ => "libx264",
            },
            "libx264"
        );
    }
}
