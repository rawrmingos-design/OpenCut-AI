use crate::{RenderRequest, RenderState, RenderProgress, detect_hw_encoder, ffmpeg_path, kill_pid, run_render};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn probe_hw_encoder(app: AppHandle, codec: String) -> String {
	detect_hw_encoder(&ffmpeg_path(&app), &codec)
}

#[tauri::command]
pub fn cancel_render(state: State<'_, RenderState>) {
	state.cancelled.store(true, Ordering::SeqCst);
	if let Some(pid) = *state.child_pid.lock().unwrap() {
		kill_pid(pid);
	}
}

#[tauri::command]
pub async fn render_video_native(
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