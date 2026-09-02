import { invoke } from "@tauri-apps/api/core";
import type { Harness } from "./harness";
import type {
  ChatFontSize,
  ClaudeModel,
  ConnectionInfo,
  ConnectOutcome,
  DownloadedFile,
  DownloadProgress,
  DraftPromptFile,
  HostKeyPrompt,
  HostStats,
  NewChatDefaults,
  PersistedState,
  PiModel,
  PrettySessionFile,
  RemoteFile,
  RemoteFileSize,
  RolloutSlice,
  SessionList,
  SshSettings,
  StartedTurn,
  ThemeChoice,
  TurnPoll,
} from "./types";

export const loadState = () => invoke<PersistedState>("load_state");
export const saveSettings = (settings: SshSettings) =>
  invoke<void>("save_settings", { settings });
export const clearSettings = () => invoke<void>("clear_settings");
export const saveNewChatDefaults = (defaults: NewChatDefaults) =>
  invoke<void>("save_new_chat_defaults", { defaults });

export const saveFavorite = (favorite: NewChatDefaults) =>
  invoke<NewChatDefaults[]>("save_favorite", { favorite });

export const deleteFavorite = (favorite: NewChatDefaults) =>
  invoke<NewChatDefaults[]>("delete_favorite", { favorite });

export const saveTranscriptFilters = (harness: Harness, hidden: string[]) =>
  invoke<void>("save_transcript_filters", { harness, hidden });

export const saveTheme = (theme: ThemeChoice) =>
  invoke<void>("save_theme", { theme });

export const saveChatFontSize = (size: ChatFontSize) =>
  invoke<void>("save_chat_font_size", { size });

export const saveSendOnEnter = (on: boolean) =>
  invoke<void>("save_send_on_enter", { on });

export const saveMaintenanceMode = (on: boolean) =>
  invoke<void>("save_maintenance_mode", { on });

export const saveDraftPromptsPath = (path: string) =>
  invoke<void>("save_draft_prompts_path", { path });

export const saveDraftPrompt = (dir: string, name: string, text: string) =>
  invoke<void>("save_draft_prompt", { dir, name, text });

export const listDraftPrompts = (dir: string) =>
  invoke<DraftPromptFile[]>("list_draft_prompts", { dir });

export const deleteDraftPrompt = (dir: string, id: string) =>
  invoke<void>("delete_draft_prompt", { dir, id });

export const connect = (settings: SshSettings) =>
  invoke<ConnectOutcome>("connect", { settings });
export const acceptHostKey = (prompt: HostKeyPrompt) =>
  invoke<void>("accept_host_key", { prompt });
export const isConnected = () => invoke<boolean>("is_connected");
export const connectionInfo = () =>
  invoke<ConnectionInfo | null>("connection_info");

export const hostStats = () => invoke<HostStats>("host_stats");

export const listClaudeModels = () =>
  invoke<ClaudeModel[]>("list_claude_models");

export const listPiModels = () => invoke<PiModel[]>("list_pi_models");

export const listSessions = (full: boolean) =>
  invoke<SessionList>("list_sessions", { full });

export const readRollout = (path: string, fromLine: number, harness: Harness) =>
  invoke<RolloutSlice>("read_rollout", { path, fromLine, harness });

export const deleteSession = (
  path: string,
  harness: Harness,
  threadId: string,
) => invoke<void>("delete_session", { path, harness, threadId });

export const rewindSession = (
  path: string,
  harness: Harness,
  keepLines: number,
  expectedLines: number,
  threadId: string,
) =>
  invoke<void>("rewind_session", {
    path,
    harness,
    keepLines,
    expectedLines,
    threadId,
  });

export const markSessionRead = (
  harness: Harness,
  threadId: string,
  at: number,
) => invoke<void>("mark_session_read", { harness, threadId, at });

export const setSessionClosed = (
  harness: Harness,
  threadId: string,
  closed: boolean,
) => invoke<void>("set_session_closed", { harness, threadId, closed });

export const setSessionLabel = (
  harness: Harness,
  threadId: string,
  label: string,
) => invoke<void>("set_session_label", { harness, threadId, label });

// pi is the only harness with a name of its own, written by the CLI into the
// session record; every other harness has the sidecar label above.
export const setPiSessionName = (
  path: string,
  threadId: string,
  name: string,
) => invoke<void>("set_pi_session_name", { path, threadId, name });

export const readRemoteFile = (path: string) =>
  invoke<RemoteFile>("read_remote_file", { path });

export const downloadRemoteFile = (path: string) =>
  invoke<DownloadedFile>("download_remote_file", {
    path,
    token: downloadToken(),
  });

const downloadToken = (): string =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from({ length: 32 }, () =>
        Math.floor(Math.random() * 16).toString(16),
      ).join("");

export const saveDownload = (src: string, dest: string) =>
  invoke<void>("save_download", { src, dest });

export const openSavedFile = () => invoke<void>("open_saved_file");

export const downloadProgress = () =>
  invoke<DownloadProgress>("download_progress");

export const cancelDownload = () => invoke<void>("cancel_download");

export const remoteFileSize = (path: string) =>
  invoke<RemoteFileSize>("remote_file_size", { path });

export const prettySessionFile = (path: string) =>
  invoke<PrettySessionFile>("pretty_session_file", { path });

export interface StartTurnOptions {
  prompt: string;
  harness: Harness;

  threadId: string;
  cwd: string;

  model: string;
  effort: string;

  permissionMode: string;
}

export const startTurn = (request: StartTurnOptions) =>
  invoke<StartedTurn>("start_turn", { request });

export const pollTurn = (key: string, fromLine: number) =>
  invoke<TurnPoll>("poll_turn", { key, fromLine });

export const watchTurn = (key: string) => invoke<void>("watch_turn", { key });

export const resetWatch = () => invoke<void>("reset_watch");

export const stopTurn = (key: string) => invoke<void>("stop_turn", { key });

export const getDiagnostics = () => invoke<string[]>("get_diagnostics");
export const clearDiagnostics = () => invoke<void>("clear_diagnostics");
export const logClient = (source: string, message: string) =>
  invoke<void>("log_client", { entry: { source, message } }).catch(() => {
    /* logging must never break the UI */
  });
