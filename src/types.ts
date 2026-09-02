import type { Harness } from "./harness";

export interface SshSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  codexBin: string;
  claudeBin: string;
  opencodeBin: string;
  piBin: string;
  defaultCwd: string;
}

interface KnownHost {
  algorithm: string;
  fingerprint: string;
  openssh: string;
}

export interface NewChatDefaults {
  harness: Harness;
  model: string;
  effort: string;
  cwd: string;

  permissionMode: string;
}

export type ThemeChoice = "system" | "light" | "dark";

export type ChatFontSize = 8 | 9 | 10 | 12 | 15 | 17;

export interface PersistedState {
  settings: SshSettings | null;
  knownHosts: Record<string, KnownHost>;
  lastHarness: Harness;
  agentDefaults: Partial<Record<Harness, NewChatDefaults>>;

  transcriptFilters: Record<string, string[]>;
  theme: ThemeChoice;
  chatFontSize: ChatFontSize;
  sendOnEnter: boolean;
  maintenanceMode: boolean;

  draftPromptsPath: string;
}

export interface DraftPromptFile {
  id: string;
  text: string;
  readOnly: boolean;
}

export interface HostKeyPrompt {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  openssh: string;
  mismatch: boolean;
  previousFingerprint: string | null;
}

export interface HostCapabilities {
  codexVersion: string | null;
  claudeVersion: string | null;
  opencodeVersion: string | null;

  tmux: boolean;
  sessionsDir: string;
  sessionsDirExists: boolean;
  projectsDir: string;
  projectsDirExists: boolean;
  opencodeDb: string;
  opencodeDbExists: boolean;
  piVersion: string | null;
  piSessionsDir: string;
  piSessionsDirExists: boolean;
}

export type ConnectOutcome =
  | { status: "connected"; capabilities: HostCapabilities }
  | { status: "hostKeyUnverified"; prompt: HostKeyPrompt };

export interface ConnectionInfo {
  host: string;
  port: number;
  username: string;
  codexBin: string;
  claudeBin: string;
  opencodeBin: string;
  piBin: string;
  capabilities: HostCapabilities;
}

export interface UsageStats {
  usedKb: number;
  totalKb: number;
}

export interface HostStats {
  memory: UsageStats | null;

  cpu: number | null;

  cores: number[];
  disk: UsageStats | null;
}

export interface PiModel {
  id: string;
  thinking: boolean;
}

export interface ClaudeModel {
  id: string;
  label: string;
  efforts: string[];
}

export type TurnState = "unknown" | "running" | "succeeded" | "failed";

export interface SessionSummary {
  id: string;
  harness: Harness;
  path: string;
  cwd: string;
  preview: string;

  title: string | null;

  createdAtIso: string | null;
  modifiedAt: number | null;
  cliVersion: string | null;
  turnState: TurnState;

  turnAt: number | null;
  turnExitCode: number | null;
  turnKey: string | null;

  closedAt: number | null;

  readAt: number | null;
  label: string | null;
}

export interface SessionList {
  sessions: SessionSummary[];
  favorites: NewChatDefaults[] | null;
}

export interface RolloutSlice {
  lines: string;

  lineCount: number;

  truncated: boolean;
}

export interface RemoteFile {
  base64: string;
  size: number;
}

export interface DownloadedFile {
  localPath: string;
  name: string;
  size: number;
}

export interface DownloadProgress {
  received: number;
  total: number;
  active: boolean;
}

export interface RemoteFileSize {
  size: number;
  tooBig: boolean;
}

export interface PrettySessionFile {
  path: string;
  size: number;
}

export interface StartedTurn {
  key: string;

  host: string;
}

export interface TurnPoll {
  running: boolean;

  exitCode: number | null;

  threadId: string | null;
  rolloutPath: string | null;
  lines: string;
  lineCount: number;

  stderr: string;

  truncated: boolean;
}

export type UserInputContent =
  | { type: "text"; text: string }
  | { type: string; [k: string]: unknown };

export interface EmbeddedImage {
  mime: string;
  data: string;
}

export interface RawToolCallItem {
  type: "rawToolCall";
  id: string;
  tool: string;
  namespace: string | null;
  input: string;
  output: string;

  status: string;

  durationMs?: number;

  rawType: string;

  summary?: string;

  explored?: boolean;
  images?: EmbeddedImage[];
}

interface ContextEntryItem {
  type: "contextEntry";
  id: string;
  label: string;
  origin: string;
  text: string;

  entryType?: string;
}

export type Delivery = "pending" | "sent" | "confirmed" | "answered";

export type ThreadItem =
  | {
      type: "userMessage";
      id: string;
      content: UserInputContent[];
      images?: EmbeddedImage[];
      delivery?: Delivery;
    }
  | { type: "agentMessage"; id: string; text: string; images?: EmbeddedImage[] }
  | { type: "reasoning"; id: string; summary: string[] }
  | RawToolCallItem
  | ContextEntryItem
  | { type: string; id: string; [k: string]: unknown };
