import claudeIcon from "./icons/claude.svg?raw";
import codexIcon from "./icons/codex.svg?raw";
import opencodeIcon from "./icons/opencode.svg?raw";
import piIcon from "./icons/pi.svg?raw";

export type Harness = "codex" | "claude" | "opencode" | "pi";

export const DEFAULT_HARNESS: Harness = "codex";

interface PermissionChoice {
  id: string;
  label: string;
  hint?: string;
}

const CLAUDE_PERMISSION_MODES: PermissionChoice[] = [
  { id: "", label: "Server default (settings.json)" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "auto", label: "Auto" },
  { id: "plan", label: "Plan only" },
  {
    id: "bypassPermissions",
    label: "Bypass permissions",
    hint: "Runs anything without asking.",
  },
];

const OPENCODE_PERMISSION_MODES: PermissionChoice[] = [
  { id: "", label: "Server default (opencode.json)" },
  {
    id: "auto",
    label: "Auto-approve (--auto)",
    hint: "Approves anything not explicitly denied.",
  },
];

export interface HarnessInfo {
  id: Harness;
  label: string;
  badge: string;

  icon: string;
  iconColour: string;
  agentName: string;
  command: string;
  binLabel: string;
  sessionsLabel: string;
  permissionModes: PermissionChoice[];

  cannotDeleteReason?: string;
  cannotRewindReason?: string;
}

export const HARNESSES: HarnessInfo[] = [
  {
    id: "codex",
    label: "codex",
    badge: "Codex",
    icon: codexIcon,
    iconColour: "var(--icon-codex)",
    agentName: "Codex",
    command: "codex exec",
    binLabel: "Codex binary",
    sessionsLabel: "~/.codex/sessions",
    // Nothing to choose: codex takes its sandbox and approval policy from the
    // server's own `config.toml`. Workspace trust is written there by the
    // turn itself, see the trust section in `turn.sh`.
    permissionModes: [],
  },
  {
    id: "claude",
    label: "claude",
    badge: "Claude",
    icon: claudeIcon,
    iconColour: "var(--icon-claude)",
    agentName: "Claude",
    command: "claude -p",
    binLabel: "Claude Code binary",
    sessionsLabel: "~/.claude/projects",
    permissionModes: CLAUDE_PERMISSION_MODES,
  },
  {
    id: "opencode",
    label: "opencode",
    badge: "opencode",
    icon: opencodeIcon,
    iconColour: "var(--icon-opencode)",
    agentName: "opencode",
    command: "opencode run",
    binLabel: "opencode binary",
    sessionsLabel: "opencode's SQLite database",
    permissionModes: OPENCODE_PERMISSION_MODES,
    cannotRewindReason: "not supported for opencode",
  },
  {
    id: "pi",
    label: "pi",
    badge: "pi",
    icon: piIcon,
    iconColour: "var(--icon-pi)",
    agentName: "pi",
    command: "pi -a --mode json",
    binLabel: "pi binary",
    sessionsLabel: "~/.pi/agent/sessions",
    // pi ships no permission popups, so there is nothing to choose. Its
    // workspace trust decision is answered by the `-a` every turn passes,
    // see the trust section in `turn.sh`.
    permissionModes: [],
  },
];

export function harnessById(id: string | null | undefined): HarnessInfo {
  return HARNESSES.find((h) => h.id === id) ?? HARNESSES[0];
}

export function isHarness(value: unknown): value is Harness {
  return HARNESSES.some((h) => h.id === value);
}
