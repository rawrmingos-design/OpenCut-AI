use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Deserialize)]
pub struct ClipSpec {
	pub src: String,
	pub in_point: f64,
	pub out_point: f64,
	#[serde(default = "default_volume")]
	pub volume: f64,
}

fn default_volume() -> f64 { 1.0 }

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

fn default_codec() -> String { "h264".into() }
fn default_bitrate() -> u32 { 8000 }
fn default_true() -> bool { true }

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
	cancelled: Arc<AtomicBool>,
	child_pid: Arc<Mutex<Option<u32>>>,
}

fn detect_hw_encoder(ffmpeg_path: &str, codec_base: &str) -> String {
	let candidates: &[&str] = match codec_base {
		"hevc" => &["hevc_nvenc", "hevc_qsv", "hevc_amf", "libx265"],
		"vp9" => &["vp9_qsv", "libvpx-vp9"],
		_ => &["h264_nvenc", "h264_qsv", "h264_amf", "libx264"],
	};

	for enc in candidates {
		let probe = Command::new(ffmpeg_path)
			.args([
				"-hide_banner", "-loglevel", "error", "-f", "lavfi",
				"-i", "color=c=black:s=128x72:d=0.2:r=2",
				"-c:v", enc, "-frames:v", "1", "-f", "null", "-",
			])
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.status();
		if matches!(probe, Ok(s) if s.success()) {
			return (*enc).to_string();
		}
	}

	match codec_base {
		"hevc" => "libx265",
		"vp9" => "libvpx-vp9",
		_ => "libx264",
	}.to_string()
}

fn run_render(
	app: AppHandle,
	request: RenderRequest,
	cancelled: Arc<AtomicBool>,
	pid_slot: Arc<Mutex<Option<u32>>>,
) -> Result<(), String> {
	let ffmpeg = ffmpeg_path(&app);
	let encoder = detect_hw_encoder(&ffmpeg, &request.codec);

	let n = request.clips.len();
	if n == 0 { return Err("No clips to render".into()); }
	cancelled.store(false, Ordering::SeqCst);

	let mut args: Vec<String> = Vec::new();
	let mut filter_parts: Vec<String> = Vec::new();
	let mut video_labels = String::new();
	let mut audio_labels = String::new();

	for (i, clip) in request.clips.iter().enumerate() {
		args.extend([
			"-ss".into(), format!("{:.6}", clip.in_point),
			"-to".into(), format!("{:.6}", clip.out_point),
			"-i".into(), clip.src.clone(),
		]);
		filter_parts.push(format!(
			"[{i}:v]scale={w}:{h}:flags=lanczos,setsar=1,fps={fps}[v{i}]",
			w = request.width, h = request.height, fps = request.fps,
		));
		if request.has_audio {
			filter_parts.push(format!(
				"[{i}:a]aresample=async=1,volume={vol:.4}[a{i}]",
				vol = clip.volume,
			));
		}
		video_labels.push_str(&format!("[v{i}]"));
		audio_labels.push_str(&format!("[a{i}]"));
	}

	let mut filter = filter_parts.join(";");
	if n > 1 {
		filter.push_str(&format!("{video_labels}{audio_labels}concat=n={n}:v=1:a=1"));
		if request.has_audio { filter.push_str("[vcat][acat]"); }
		else { filter.push_str("[vcat]"); }
	}
	args.extend(["-filter_complex".into(), filter]);

	if n > 1 && request.has_audio {
		args.extend(["-map".into(), "[vcat]".into(), "-map".into(), "[acat]".into()]);
	} else if n > 1 {
		args.extend(["-map".into(), "[vcat]".into()]);
	} else if request.has_audio {
		args.extend(["-map".into(), "[v0]".into(), "-map".into(), "[a0]".into()]);
	} else {
		args.extend(["-map".into(), "[v0]".into()]);
	}
	if !request.has_audio { args.push("-an".into()); }

	let total_frames: u64 = request.clips.iter()
		.map(|c| ((c.out_point - c.in_point) * request.fps as f64).ceil() as u64)
		.sum();

	args.extend([
		"-c:v".into(), encoder, "-b:v".into(), format!("{}k", request.bitrate_kbps),
	]);
	if request.has_audio {
		args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
	}
	args.extend([
		"-movflags".into(), "+faststart".into(), "-y".into(),
		"-progress".into(), "pipe:1".into(), "-loglevel".into(), "error".into(),
		request.out_path.clone(),
	]);

	let mut child = Command::new(&ffmpeg)
		.args(&args)
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
		.map_err(|e| format!("Failed to start FFmpeg: {e}"))?;

	*pid_slot.lock().unwrap() = Some(child.id());

	let stdout = child.stdout.take().expect("piped stdout");
	let stderr = child.stderr.take().expect("piped stderr");

	let err_thread = std::thread::spawn(move || {
		let mut buf = String::new();
		for line in BufReader::new(stderr).lines().flatten() {
			buf.push_str(&line); buf.push('\n');
		}
		buf
	});

	let reader = BufReader::new(stdout);
	let mut current_frame: u64 = 0;
	let mut current_fps: f64 = 0.0;

	for line in reader.lines() {
		if cancelled.load(Ordering::SeqCst) {
			let _ = child.kill();
			let _ = child.wait();
			*pid_slot.lock().unwrap() = None;
			let _ = app.emit("render-progress", RenderProgress {
				frame: current_frame, total_frames,
				percent: current_frame as f64 / total_frames.max(1) as f64,
				fps: current_fps, done: false, error: Some("cancelled".into()),
			});
			return Err("cancelled".into());
		}

		let Ok(line) = line else { break };
		if let Some(v) = line.strip_prefix("frame=") {
			current_frame = v.trim().parse().unwrap_or(current_frame);
		} else if let Some(v) = line.strip_prefix("fps=") {
			current_fps = v.trim().parse().unwrap_or(current_fps);
		} else if line == "progress=continue" || line == "progress=end" {
			let percent = (current_frame as f64 / total_frames.max(1) as f64).min(1.0);
			let _ = app.emit("render-progress", RenderProgress {
				frame: current_frame, total_frames, percent, fps: current_fps,
				done: line == "progress=end", error: None,
			});
		}
	}

	let status = child.wait().map_err(|e| e.to_string())?;
	*pid_slot.lock().unwrap() = None;
	let stderr_out = err_thread.join().unwrap_or_default();

	if !status.success() {
		let mut lines = stderr_out.lines().rev().take(6).collect::<Vec<_>>();
		lines.reverse();
		let tail = lines.join("\n");
		return Err(format!("FFmpeg failed (code {:?}): {}", status.code(), tail));
	}

	Ok(())
}

#[tauri::command(rename = "probe_hw_encoder")]
pub fn cmd_probe_hw_encoder(app: AppHandle, codec: String) -> String {
	detect_hw_encoder(&ffmpeg_path(&app), &codec)
}

#[tauri::command(rename = "cancel_render")]
pub fn cmd_cancel_render(state: State<'_, RenderState>) {
	state.cancelled.store(true, Ordering::SeqCst);
	if let Some(pid) = *state.child_pid.lock().unwrap() {
		kill_pid(pid);
	}
}

#[tauri::command(rename = "render_video_native")]
pub async fn cmd_render_video_native(
	app: AppHandle,
	request: RenderRequest,
	state: State<'_, RenderState>,
) -> Result<(), String> {
	let cancelled = state.cancelled.clone();
	let pid_slot = state.child_pid.clone();
	drop(state);

	match tauri::async_runtime::spawn_blocking(move || {
		run_render(app, request, cancelled, pid_slot)
	}).await {
		Ok(result) => result,
		Err(e) => Err(format!("render task panicked: {e}")),
	}
}

fn ffmpeg_path(app: &AppHandle) -> String {
	app.path().resource_dir().ok()
		.map(|d| d.join("binaries/ffmpeg").with_extension(if cfg!(target_os = "windows") { "exe" } else { "" }).to_string_lossy().into_owned())
		.unwrap_or_else(|| "ffmpeg".into())
}

fn kill_pid(pid: u32) {
	#[cfg(target_os = "windows")]
	let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
	#[cfg(not(target_os = "windows"))]
	let _ = Command::new("kill").arg(pid.to_string()).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	tauri::Builder::default()
		.manage(RenderState::default())
		.plugin(tauri_plugin_fs::init())
		.plugin(tauri_plugin_os::init())
		.plugin(tauri_plugin_dialog::init())
		.setup(|app| {
			if cfg!(debug_assertions) {
				app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
			}
			Ok(())
		})
		.invoke_handler(tauri::generate_handler![
			cmd_probe_hw_encoder,
			cmd_render_video_native,
			cmd_cancel_render,
		])
		.run(tauri::generate_context!())
		.expect("error while running tauri application");
}
