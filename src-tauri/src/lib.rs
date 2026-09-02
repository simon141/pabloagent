mod diag;
mod download;
mod remote;
mod ssh;
mod store;
mod watch;

pub mod testing {
    pub use crate::diag::Diagnostics;
    pub use crate::download::{Download, Header, Progress};
    pub use crate::remote::{
        delete_favorite_command, delete_session_command, download_remote_file_command,
        favorite_name, list_sessions_command, mark_session_read_command, parse_favorites,
        parse_pretty_session, parse_sessions, parse_turn_poll, poll_turn_command,
        pretty_session_command, read_rollout_command, refused_because_busy, rewind_session_command,
        save_favorite_command, set_pi_session_name_command, set_session_closed_command,
        start_turn_command, stop_turn_command, Harness, SessionSummary, TurnPoll, TurnRequest,
        TurnState, SCRIPT,
    };
    pub use crate::ssh::{connect_full, ByteSink, ConnectOutcome, Connection, HostKeyPrompt};
    pub use crate::store::{KnownHost, NewChatDefaults, SshSettings};
}

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use diag::Diagnostics;
use remote::{HostCapabilities, TurnPoll, TurnRequest};
use ssh::{ConnectOutcome, Connection, HostKeyPrompt};
use store::{KnownHost, NewChatDefaults, PersistedState, SshSettings};

pub struct AppState {
    connection: Mutex<Option<Connection>>,
    diagnostics: Diagnostics,
    watch: watch::TurnWatch,
    download: download::Progress,
    saved_file: std::sync::Mutex<Option<std::path::PathBuf>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            connection: Mutex::new(None),
            diagnostics: Diagnostics::new(),
            watch: watch::TurnWatch::default(),
            download: download::Progress::default(),
            saved_file: std::sync::Mutex::new(None),
        }
    }

    async fn connected(
        &self,
        what: &str,
    ) -> Result<tokio::sync::MutexGuard<'_, Option<Connection>>, String> {
        let guard = self.connection.lock().await;
        if guard.is_none() {
            return Err(format!(
                "Not connected, so {what} cannot run.\n\nRecent activity:\n{}",
                self.diagnostics.tail(20)
            ));
        }
        Ok(guard)
    }
}

#[tauri::command]
fn load_state(app: AppHandle) -> PersistedState {
    store::load(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: SshSettings) -> Result<(), String> {
    let mut state = store::load(&app);
    state.settings = Some(settings);
    store::save(&app, &state)
}

#[tauri::command]
async fn clear_settings(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    *state.connection.lock().await = None;
    state.diagnostics.clear();
    let mut persisted = store::load(&app);
    persisted.settings = None;
    persisted.known_hosts.clear();
    store::save(&app, &persisted)
}

#[tauri::command]
fn save_new_chat_defaults(app: AppHandle, defaults: NewChatDefaults) -> Result<(), String> {
    let mut persisted = store::load(&app);
    persisted.last_harness = defaults.harness.clone();
    persisted
        .agent_defaults
        .insert(defaults.harness.clone(), defaults);
    store::save(&app, &persisted)
}

// Favorites live on the host so every Pablo instance shares them. Both
// commands return the host's list so the frontend never drifts from it.
#[tauri::command]
async fn save_favorite(
    state: State<'_, AppState>,
    favorite: NewChatDefaults,
) -> Result<Vec<NewChatDefaults>, String> {
    let command = remote::save_favorite_command(&favorite)?;
    let mut guard = state.connected("saving a favorite").await?;
    let connection = guard.as_mut().expect("checked");
    let output = connection.run_ok("save favorite", &command).await?;
    state.diagnostics.push("remote", "saved a favorite");
    Ok(remote::parse_favorites(&output))
}

#[tauri::command]
async fn delete_favorite(
    state: State<'_, AppState>,
    favorite: NewChatDefaults,
) -> Result<Vec<NewChatDefaults>, String> {
    let command = remote::delete_favorite_command(&favorite)?;
    let mut guard = state.connected("deleting a favorite").await?;
    let connection = guard.as_mut().expect("checked");
    let output = connection.run_ok("delete favorite", &command).await?;
    state.diagnostics.push("remote", "deleted a favorite");
    Ok(remote::parse_favorites(&output))
}

#[tauri::command]
fn save_transcript_filters(
    app: AppHandle,
    harness: String,
    hidden: Vec<String>,
) -> Result<(), String> {
    if harness.trim().is_empty() {
        return Ok(());
    }
    let mut persisted = store::load(&app);
    persisted.transcript_filters.insert(harness, hidden);
    store::save(&app, &persisted)
}

#[tauri::command]
fn save_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let mut persisted = store::load(&app);
    persisted.theme = theme;
    store::save(&app, &persisted)
}

#[tauri::command]
fn save_chat_font_size(app: AppHandle, size: u8) -> Result<(), String> {
    let mut persisted = store::load(&app);
    persisted.chat_font_size = size;
    store::save(&app, &persisted)
}

#[tauri::command]
fn save_send_on_enter(app: AppHandle, on: bool) -> Result<(), String> {
    let mut persisted = store::load(&app);
    persisted.send_on_enter = on;
    store::save(&app, &persisted)
}

#[tauri::command]
fn save_maintenance_mode(app: AppHandle, on: bool) -> Result<(), String> {
    let mut persisted = store::load(&app);
    persisted.maintenance_mode = on;
    store::save(&app, &persisted)
}

#[tauri::command]
fn save_draft_prompts_path(app: AppHandle, path: String) -> Result<(), String> {
    let mut persisted = store::load(&app);
    persisted.draft_prompts_path = path;
    store::save(&app, &persisted)
}

#[tauri::command]
async fn save_draft_prompt(
    state: State<'_, AppState>,
    dir: String,
    name: String,
    text: String,
) -> Result<(), String> {
    let command = remote::save_draft_prompt_command(&dir, &name, &text)?;
    let mut guard = state.connected("saving a draft prompt").await?;
    let connection = guard.as_mut().expect("checked");
    let output = connection.run_ok("save draft prompt", &command).await?;
    if remote::draft_save_conflict(&output) {
        return Err(format!(
            "A draft named '{name}' already exists — choose another name."
        ));
    }
    state
        .diagnostics
        .push("remote", format!("saved draft prompt {name}"));
    Ok(())
}

#[tauri::command]
async fn list_draft_prompts(
    state: State<'_, AppState>,
    dir: String,
) -> Result<Vec<remote::DraftFile>, String> {
    let command = remote::list_draft_prompts_command(&dir)?;
    let mut guard = state.connected("listing draft prompts").await?;
    let connection = guard.as_mut().expect("checked");
    let output = connection.run_ok("list draft prompts", &command).await?;
    let drafts = remote::parse_draft_prompts(&output);
    state
        .diagnostics
        .push("remote", format!("draft prompts: {} rows", drafts.len()));
    Ok(drafts)
}

#[tauri::command]
async fn delete_draft_prompt(
    state: State<'_, AppState>,
    dir: String,
    id: String,
) -> Result<(), String> {
    let command = remote::delete_draft_prompt_command(&dir, &id)?;
    let mut guard = state.connected("deleting a draft prompt").await?;
    let connection = guard.as_mut().expect("checked");
    connection.run_ok("delete draft prompt", &command).await?;
    state
        .diagnostics
        .push("remote", format!("deleted draft prompt {id}"));
    Ok(())
}

#[tauri::command]
async fn mark_session_read(
    state: State<'_, AppState>,
    harness: Option<remote::Harness>,
    thread_id: String,
    at: i64,
) -> Result<(), String> {
    let command = remote::mark_session_read_command(harness.unwrap_or_default(), &thread_id, at)?;
    let mut guard = state.connected("marking a session read").await?;
    let connection = guard.as_mut().expect("checked");
    connection.run_ok("mark session read", &command).await?;
    Ok(())
}

#[tauri::command]
async fn set_session_closed(
    state: State<'_, AppState>,
    harness: Option<remote::Harness>,
    thread_id: String,
    closed: bool,
) -> Result<(), String> {
    let command =
        remote::set_session_closed_command(harness.unwrap_or_default(), &thread_id, closed)?;
    let verb = if closed { "closing" } else { "reopening" };
    let mut guard = state.connected(&format!("{verb} a session")).await?;
    let connection = guard.as_mut().expect("checked");
    connection.run_ok("set session closed", &command).await?;
    let done = if closed { "closed" } else { "reopened" };
    state
        .diagnostics
        .push("remote", format!("{done} session {thread_id}"));
    Ok(())
}

#[tauri::command]
async fn set_session_label(
    state: State<'_, AppState>,
    harness: Option<remote::Harness>,
    thread_id: String,
    label: String,
) -> Result<(), String> {
    let command =
        remote::set_session_label_command(harness.unwrap_or_default(), &thread_id, &label)?;
    let mut guard = state.connected("labelling a session").await?;
    let connection = guard.as_mut().expect("checked");
    connection.run_ok("set session label", &command).await?;
    state
        .diagnostics
        .push("remote", format!("labelled session {thread_id}"));
    Ok(())
}

#[tauri::command]
async fn set_pi_session_name(
    state: State<'_, AppState>,
    path: String,
    thread_id: String,
    name: String,
) -> Result<(), String> {
    let mut guard = state.connected("naming a session").await?;
    let connection = guard.as_mut().expect("checked");
    let command = remote::set_pi_session_name_command(
        &connection.settings().pi_bin,
        &path,
        &thread_id,
        &name,
    )?;
    let output = connection.run_ok("set pi session name", &command).await?;
    if let Some(turn) = remote::refused_because_busy(&output) {
        state.diagnostics.push(
            "remote",
            format!("refused to name session {path}: turn {turn} is running"),
        );
        return Err(remote::busy_session_message("renamed", turn));
    }
    state
        .diagnostics
        .push("remote", format!("named pi session {thread_id}"));
    Ok(())
}

#[tauri::command]
async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: SshSettings,
) -> Result<ConnectOutcome, String> {
    *state.connection.lock().await = None;

    let persisted = store::load(&app);
    let known = persisted
        .known_hosts
        .get(&store::host_key(&settings.host, settings.port))
        .cloned();

    state.diagnostics.push(
        "connect",
        format!(
            "connect requested for {}@{}:{} (trusted key on file: {})",
            settings.username,
            settings.host,
            settings.port,
            known.is_some()
        ),
    );

    let (connection, outcome) =
        ssh::connect_full(settings, known, state.diagnostics.clone()).await?;

    if let Some(connection) = connection {
        *state.connection.lock().await = Some(connection);
    }
    Ok(outcome)
}

#[tauri::command]
fn accept_host_key(app: AppHandle, prompt: HostKeyPrompt) -> Result<(), String> {
    let mut persisted = store::load(&app);
    persisted.known_hosts.insert(
        store::host_key(&prompt.host, prompt.port),
        KnownHost {
            algorithm: prompt.algorithm,
            fingerprint: prompt.fingerprint,
            openssh: prompt.openssh,
        },
    );
    store::save(&app, &persisted)
}

#[tauri::command]
async fn is_connected(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state
        .connection
        .lock()
        .await
        .as_ref()
        .is_some_and(Connection::is_live))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionInfo {
    host: String,
    port: u16,
    username: String,
    codex_bin: String,
    claude_bin: String,
    opencode_bin: String,
    pi_bin: String,
    capabilities: HostCapabilities,
}

#[tauri::command]
async fn connection_info(state: State<'_, AppState>) -> Result<Option<ConnectionInfo>, String> {
    let guard = state.connection.lock().await;
    Ok(guard.as_ref().map(|c| {
        let s = c.settings();
        ConnectionInfo {
            host: s.host.clone(),
            port: s.port,
            username: s.username.clone(),
            codex_bin: s.codex_bin.clone(),
            claude_bin: s.claude_bin.clone(),
            opencode_bin: s.opencode_bin.clone(),
            pi_bin: s.pi_bin.clone(),
            capabilities: c.capabilities().clone(),
        }
    }))
}

#[tauri::command]
async fn host_stats(state: State<'_, AppState>) -> Result<remote::HostStats, String> {
    let mut guard = state.connected("host stats").await?;
    let connection = guard.as_mut().expect("checked");
    let output = connection
        .run_ok("read host stats", &remote::host_stats_command())
        .await?;
    Ok(remote::parse_host_stats(&output))
}

#[tauri::command]
async fn list_pi_models(state: State<'_, AppState>) -> Result<Vec<remote::PiModel>, String> {
    let mut guard = state.connected("listing Pi models").await?;
    let connection = guard.as_mut().expect("checked");
    let command = remote::list_pi_models_command(&connection.settings().pi_bin);
    let output = connection.run_ok("list Pi models", &command).await?;
    let models = remote::parse_pi_models(&output);
    if models.is_empty() {
        return Err("Pi returned no readable models from `--list-models`.".to_string());
    }
    state
        .diagnostics
        .push("remote", format!("Pi model list: {} rows", models.len()));
    Ok(models)
}

#[tauri::command]
async fn list_claude_models(
    state: State<'_, AppState>,
) -> Result<Vec<remote::ClaudeModel>, String> {
    let mut guard = state.connected("listing Claude models").await?;
    let connection = guard.as_mut().expect("checked");
    let command = remote::list_claude_models_command(&connection.settings().claude_bin);
    let output = connection.run_ok("list Claude models", &command).await?;
    let models = remote::parse_claude_models(&output);
    if models.is_empty() {
        return Err("Claude returned no readable models from its SDK catalog.".to_string());
    }
    state.diagnostics.push(
        "remote",
        format!("Claude model list: {} rows", models.len()),
    );
    Ok(models)
}

// Favorites ride along only on a full refresh: the poll keeps its payload
// and the picker's favorites do not change under the reader between taps.
#[tauri::command]
async fn list_sessions(
    state: State<'_, AppState>,
    full: bool,
) -> Result<remote::SessionList, String> {
    let mut guard = state.connected("the session list").await?;
    let connection = guard.as_mut().expect("checked");
    let opencode_bin = connection.settings().opencode_bin.clone();
    let output = connection
        .run_ok(
            "list sessions",
            &remote::list_sessions_command(&opencode_bin, full),
        )
        .await?;
    let sessions = remote::parse_sessions(&output);
    state
        .diagnostics
        .push("remote", format!("session list: {} rows", sessions.len()));
    Ok(remote::SessionList {
        sessions,
        favorites: full.then(|| remote::parse_favorites(&output)),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RolloutSlice {
    lines: String,
    line_count: u64,
    truncated: bool,
}

#[tauri::command]
async fn read_rollout(
    state: State<'_, AppState>,
    path: String,
    from_line: u64,
    harness: Option<remote::Harness>,
) -> Result<RolloutSlice, String> {
    let mut guard = state.connected("reading a session").await?;
    let connection = guard.as_mut().expect("checked");
    let opencode_bin = connection.settings().opencode_bin.clone();
    let command =
        remote::read_rollout_command(harness.unwrap_or_default(), &path, from_line, &opencode_bin)?;
    let lines = connection.run_ok("read rollout", &command).await?;
    // A rollout being appended to as it is read can end mid-line. Only whole
    // lines are counted, so the next read starts at one the frontend could
    // actually parse.
    let line_count = lines
        .split_inclusive('\n')
        .filter(|l| l.ends_with('\n'))
        .count() as u64;
    // `head -c` cuts silently, so a full page is the only sign there was more.
    // A file of exactly one page costs a single empty follow-up read.
    let truncated = lines.len() as u64 >= remote::SESSION_READ_BYTE_CAP;
    Ok(RolloutSlice {
        lines,
        line_count,
        truncated,
    })
}

#[tauri::command]
async fn delete_session(
    state: State<'_, AppState>,
    path: String,
    harness: Option<remote::Harness>,
    thread_id: Option<String>,
) -> Result<(), String> {
    let command = remote::delete_session_command(
        harness.unwrap_or_default(),
        &path,
        thread_id.as_deref().unwrap_or_default(),
    )?;
    let mut guard = state.connected("deleting a session").await?;
    let connection = guard.as_mut().expect("checked");
    let output = connection.run_ok("delete session", &command).await?;
    if let Some(turn) = remote::refused_because_busy(&output) {
        state.diagnostics.push(
            "remote",
            format!("refused to delete session {path}: turn {turn} is running"),
        );
        return Err(remote::busy_session_message("deleted", turn));
    }
    state
        .diagnostics
        .push("remote", format!("deleted session {path}"));
    Ok(())
}

#[tauri::command]
async fn rewind_session(
    state: State<'_, AppState>,
    path: String,
    harness: Option<remote::Harness>,
    keep_lines: u64,
    expected_lines: u64,
    thread_id: Option<String>,
) -> Result<(), String> {
    let command = remote::rewind_session_command(
        harness.unwrap_or_default(),
        &path,
        keep_lines,
        expected_lines,
        thread_id.as_deref().unwrap_or_default(),
    )?;
    let mut guard = state.connected("rewinding a session").await?;
    let connection = guard.as_mut().expect("checked");
    let output = connection.run_ok("rewind session", &command).await?;
    if let Some(turn) = remote::refused_because_busy(&output) {
        state.diagnostics.push(
            "remote",
            format!("refused to rewind session {path}: turn {turn} is running"),
        );
        return Err(remote::busy_session_message("rewound", turn));
    }
    state.diagnostics.push(
        "remote",
        format!("rewound session {path} to {keep_lines} lines"),
    );
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFile {
    base64: String,
    size: u64,
}

#[tauri::command]
async fn read_remote_file(state: State<'_, AppState>, path: String) -> Result<RemoteFile, String> {
    let command = remote::read_remote_file_command(&path)?;
    let mut guard = state.connected("reading a file").await?;
    let connection = guard.as_mut().expect("checked");
    let output = connection.run_ok("read remote file", &command).await?;
    drop(guard);

    if let Some(size) = output.lines().find_map(|l| l.strip_prefix("PT_TOOBIG\t")) {
        return Err(format!(
            "{path} is {} bytes — larger than the {} this app will fetch for an image",
            size.trim(),
            remote::REMOTE_FILE_MAX_BYTES
        ));
    }
    let size = output
        .lines()
        .find_map(|l| l.strip_prefix("PT_SIZE\t"))
        .and_then(|s| s.trim().parse::<u64>().ok())
        .ok_or_else(|| format!("The server did not report a size for {path}"))?;
    // Everything after the size line is the base64, emitted without newlines.
    let base64 = output
        .split_once('\n')
        .map(|(_, rest)| rest.trim().to_string())
        .unwrap_or_default();
    if base64.is_empty() {
        return Err(format!("{path} is empty"));
    }
    state.diagnostics.push(
        "remote",
        format!("read {size} bytes of {path} for an inline image"),
    );
    Ok(RemoteFile { base64, size })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadedFile {
    local_path: String,
    name: String,
    size: u64,
}

#[tauri::command]
async fn download_remote_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    token: String,
) -> Result<DownloadedFile, String> {
    let command = remote::download_remote_file_command(&path)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve the app cache dir: {e}"))?;
    let dir = download::dir(&cache)?;
    download::prune(&dir);
    let name = download::local_name(&path);
    let dest = download::token_dir(&dir, &token)?.join(&name);

    if !state.download.begin() {
        return Err("Another download is already running.".to_string());
    }
    // Every exit from here on has to release the slot, so the work is wrapped
    // rather than returned from directly.
    let result = download_into(&state, &command, &path, dest).await;
    state.download.end();
    let (local_path, size) = result?;

    state.diagnostics.push(
        "remote",
        format!("downloaded {path} ({size} bytes) to {local_path}"),
    );
    Ok(DownloadedFile {
        local_path,
        name,
        size,
    })
}

async fn download_into(
    state: &AppState,
    command: &str,
    remote_path: &str,
    dest: std::path::PathBuf,
) -> Result<(String, u64), String> {
    let mut sink = download::Download::create(dest, &state.download)?;
    let mut guard = state.connected("downloading a file").await?;
    let connection = guard.as_mut().expect("checked");
    let outcome = connection
        .run_streamed("download remote file", command, &mut sink)
        .await;
    drop(guard);

    let out = match outcome {
        Ok(out) => out,
        Err(e) => {
            sink.discard();
            return Err(e);
        }
    };
    match out.exit_code {
        Some(0) => {}
        Some(code) => {
            let stderr = out.stderr.trim().to_string();
            sink.discard();
            return Err(format!(
                "The server could not read {remote_path} (exit {code}).\n{stderr}"
            ));
        }
        None => {
            sink.discard();
            return Err(format!(
                "The transfer of {remote_path} ended without an exit status. SSH did not \
                 confirm that the command completed, so the partial file has been thrown away.\n{}",
                out.stderr.trim()
            ));
        }
    }

    // A refusal arrives as the header with nothing behind it, so it is read
    // here rather than written to disk.
    match sink.header() {
        Some(download::Header::Bytes(total)) => {
            let total = *total;
            let written = sink.written();
            if written != total {
                sink.discard();
                return Err(format!(
                    "{remote_path} is {total} bytes but only {written} arrived, so the \
                     copy is incomplete and has been thrown away."
                ));
            }
            let local = sink.finish()?;
            Ok((local.to_string_lossy().into_owned(), total))
        }
        Some(download::Header::NotAFile) => {
            sink.discard();
            Err(format!("{remote_path} is not a file on the server."))
        }
        Some(download::Header::TooBig(size)) => {
            let size = *size;
            sink.discard();
            Err(format!(
                "{remote_path} is {size} bytes — larger than the {} this app will \
                 download in one go.",
                remote::REMOTE_DOWNLOAD_MAX_BYTES
            ))
        }
        None => {
            sink.discard();
            Err(format!(
                "The server said nothing about {remote_path}.\n\n{}",
                out.stderr.trim()
            ))
        }
    }
}

#[tauri::command]
fn save_download(
    app: AppHandle,
    state: State<'_, AppState>,
    src: String,
    dest: String,
) -> Result<(), String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve the app cache dir: {e}"))?;
    let downloads = download::dir(&cache)?
        .canonicalize()
        .map_err(|e| format!("cannot resolve the download directory: {e}"))?;
    let src = std::path::Path::new(&src)
        .canonicalize()
        .map_err(|_| "The downloaded file is no longer on this device.".to_string())?;
    // One level down: every download lives in its own `downloads/<token>/`.
    if src.parent().and_then(std::path::Path::parent) != Some(downloads.as_path()) {
        return Err("Only a downloaded file can be saved this way.".to_string());
    }
    std::fs::copy(&src, &dest).map_err(|e| format!("Could not write {dest}: {e}"))?;
    *state.saved_file.lock().expect("saved_file lock") = Some(std::path::PathBuf::from(&dest));
    Ok(())
}

#[tauri::command]
fn open_saved_file(state: State<'_, AppState>) -> Result<(), String> {
    let path = state
        .saved_file
        .lock()
        .expect("saved_file lock")
        .clone()
        .ok_or_else(|| "Nothing has been saved yet.".to_string())?;
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|e| format!("Could not open {}: {e}", path.display()))
}

#[tauri::command]
fn download_progress(state: State<'_, AppState>) -> download::ProgressReport {
    state.download.report()
}

#[tauri::command]
fn cancel_download(state: State<'_, AppState>) {
    state.download.cancel();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFileSize {
    size: u64,
    too_big: bool,
}

#[tauri::command]
async fn remote_file_size(
    state: State<'_, AppState>,
    path: String,
) -> Result<RemoteFileSize, String> {
    let command = remote::remote_file_size_command(&path)?;
    let mut guard = state.connected("checking a file's size").await?;
    let connection = guard.as_mut().expect("checked");
    let output = connection.run_ok("remote file size", &command).await?;
    drop(guard);

    let line = output.lines().next().unwrap_or_default();
    match download::parse_header(line)? {
        download::Header::Bytes(size) => Ok(RemoteFileSize {
            size,
            too_big: false,
        }),
        download::Header::TooBig(size) => Ok(RemoteFileSize {
            size,
            too_big: true,
        }),
        download::Header::NotAFile => Err(format!("{path} is not a file on the server.")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrettySessionFile {
    path: String,
    size: u64,
}

#[tauri::command]
async fn pretty_session_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<PrettySessionFile, String> {
    let command = remote::pretty_session_command(&path)?;
    let mut guard = state.connected("formatting a session file").await?;
    let connection = guard.as_mut().expect("checked");
    let output = connection.run_ok("pretty session file", &command).await?;
    drop(guard);

    let (pretty, size) = remote::parse_pretty_session(&output, &path)?;
    state.diagnostics.push(
        "remote",
        format!("formatted {path} as {pretty} ({size} bytes)"),
    );
    Ok(PrettySessionFile { path: pretty, size })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedTurn {
    key: String,
    host: String,
}

#[tauri::command]
async fn start_turn(
    state: State<'_, AppState>,
    mut request: TurnRequest,
) -> Result<StartedTurn, String> {
    let mut guard = state.connected("starting a turn").await?;
    let connection = guard.as_mut().expect("checked");
    let key = uuid::Uuid::new_v4().simple().to_string();
    // claude and pi take the new session's id up front, so it is chosen here
    // rather than read back afterwards. A resumed turn already has one and
    // keeps it.
    if request.session_id.trim().is_empty() {
        request.session_id = uuid::Uuid::new_v4().to_string();
    }
    let settings = connection.settings();
    let command = remote::start_turn_command(
        &key,
        &request,
        &settings.codex_bin,
        &settings.claude_bin,
        &settings.opencode_bin,
        &settings.pi_bin,
    );

    state.diagnostics.push(
        "turn",
        format!(
            "starting {} turn {key}: {} chars of prompt, thread={}, model={}, effort={}, cwd={}",
            request.harness.tag(),
            request.prompt.len(),
            if request.thread_id.is_empty() {
                "new"
            } else {
                &request.thread_id
            },
            request.model,
            request.effort,
            request.cwd
        ),
    );

    let output = connection.run_ok("start turn", &command).await?;
    let host = output
        .lines()
        .find_map(|l| l.strip_prefix("PT_STARTED\t"))
        .unwrap_or("unknown")
        .trim()
        .to_string();
    Ok(StartedTurn { key, host })
}

#[tauri::command]
async fn poll_turn(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    from_line: u64,
) -> Result<TurnPoll, String> {
    let mut guard = state.connected("following a turn").await?;
    let connection = guard.as_mut().expect("checked");
    let output = connection
        .run_ok("poll turn", &remote::poll_turn_command(&key, from_line))
        .await?;
    drop(guard);
    let poll = remote::parse_turn_poll(&output)?;
    if !poll.running {
        // Whichever side sees the end retires the watch; `turn_ended` also
        // decides whether it is worth a notification.
        watch::turn_ended(&app, &key);
    }
    Ok(poll)
}

#[tauri::command]
async fn stop_turn(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let mut guard = state.connected("stopping a turn").await?;
    let connection = guard.as_mut().expect("checked");
    connection
        .run_ok("stop turn", &remote::stop_turn_command(&key))
        .await?;
    state
        .diagnostics
        .push("turn", format!("stopped turn {key}"));
    Ok(())
}

#[tauri::command]
fn get_diagnostics(state: State<'_, AppState>) -> Vec<String> {
    state.diagnostics.snapshot()
}

#[tauri::command]
fn clear_diagnostics(state: State<'_, AppState>) {
    state.diagnostics.clear();
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub source: String,
    pub message: String,
}

#[tauri::command]
fn log_client(state: State<'_, AppState>, entry: LogEntry) {
    state.diagnostics.push(&entry.source, entry.message);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(AppState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_settings,
            clear_settings,
            save_new_chat_defaults,
            save_favorite,
            delete_favorite,
            save_transcript_filters,
            save_theme,
            save_chat_font_size,
            save_send_on_enter,
            save_maintenance_mode,
            save_draft_prompts_path,
            save_draft_prompt,
            list_draft_prompts,
            delete_draft_prompt,
            mark_session_read,
            set_session_closed,
            set_session_label,
            set_pi_session_name,
            connect,
            accept_host_key,
            is_connected,
            connection_info,
            host_stats,
            list_claude_models,
            list_pi_models,
            list_sessions,
            read_rollout,
            delete_session,
            rewind_session,
            read_remote_file,
            download_remote_file,
            save_download,
            open_saved_file,
            download_progress,
            cancel_download,
            remote_file_size,
            pretty_session_file,
            start_turn,
            poll_turn,
            stop_turn,
            watch::watch_turn,
            watch::reset_watch,
            get_diagnostics,
            clear_diagnostics,
            log_client,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Suspend/resume is what hands the followed turn between the webview's
        // poll loop and the native watcher, the webview's JavaScript is
        // paused with the activity and cannot see either edge.
        .run(|app, event| {
            #[cfg(mobile)]
            match event {
                // The tray may still hold a "finished its turn" row from a
                // process Android killed before its resume could clear it.
                // `Ready` rather than `setup`: the clear goes through the
                // event loop, which is running by the time this arrives.
                tauri::RunEvent::Ready => watch::clear_finished_notification(app),
                tauri::RunEvent::WindowEvent { event, .. } => match event {
                    tauri::WindowEvent::Suspended => watch::on_suspended(app),
                    tauri::WindowEvent::Resumed => watch::on_resumed(app),
                    _ => {}
                },
                _ => {}
            }
            #[cfg(desktop)]
            let _ = (app, event);
        });
}
