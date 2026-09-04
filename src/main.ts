import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ask as askDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import * as api from "./api";
import {
  type ContextUsage,
  type CostFigure,
  contextLevel,
  contextUsage,
  formatCost,
  formatPercent,
  formatTokens,
  type TokenBreakdown,
} from "./context";
import {
  type DraftPrompt,
  formatDraft,
  parseDraft,
  parseTextDraft,
} from "./drafts";
import {
  allFiltersFor,
  categoriesOf,
  categoryOf,
  defaultHidden,
  entryFilterFor,
  entryTypeOf,
  filtersFor,
  isHidden,
  knownHidden,
} from "./filters";
import {
  DEFAULT_HARNESS,
  HARNESSES,
  type Harness,
  type HarnessInfo,
  harnessById,
  isHarness,
} from "./harness";
import {
  claudeModelChoices,
  type ModelChoice,
  modelById,
  modelsFor,
  piModelChoices,
} from "./models";
import { piSessionName } from "./pi-rollout";
import { anchorMenu, type MenuAnchor, softKeyboard } from "./platform";
import {
  type CodexRateLimits,
  type CodexRateLimitWindow,
  parseSessionLines,
  renderSession,
  type SessionEntry,
  sessionFacts,
  wholeLineBytes,
} from "./session";
import { Transcript } from "./transcript";
import type {
  ChatFontSize,
  Delivery,
  DownloadProgress,
  DraftPromptFile,
  HostCapabilities,
  HostKeyPrompt,
  HostStats,
  NewChatDefaults,
  RolloutSlice,
  SessionSummary,
  SshSettings,
  ThemeChoice,
  ThreadItem,
  TurnPoll,
  TurnState,
  UsageStats,
} from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const show = (el: HTMLElement, visible: boolean) => {
  const was = !el.hidden;
  el.hidden = !visible;
  if (visible === was || !isLayer(el)) return;
  if (visible) enterLayer(el);
  else leaveLayer(el);
};

const sleep = (ms: number) =>
  new Promise<void>((r) => window.setTimeout(r, ms));

interface SessionFileRead {
  bytes: number;
  lines: number;
}

interface ChatState {
  harness: Harness;
  threadId: string | null;
  rolloutPath: string | null;
  entries: SessionEntry[];

  cursor: number;

  file: SessionFileRead;
  model: string;
  effort: string;
  cwd: string;
  permissionMode: string;
  turnKey: string | null;
  turnActive: boolean;
  title: string | null;
  label: string | null;
}

const chat: ChatState = {
  harness: DEFAULT_HARNESS,
  threadId: null,
  rolloutPath: null,
  entries: [],
  cursor: 1,
  file: { bytes: 0, lines: 0 },
  model: "",
  effort: "",
  cwd: "",
  permissionMode: "",
  turnKey: null,
  turnActive: false,
  title: null,
  label: null,
};

let chatGeneration = 0;
let sessionsRefreshPromise: Promise<void> | null = null;
let sessionsRefreshIsFull = false;
let sessionsGeneration = 0;
let settings: SshSettings | null = null;
let sessions: SessionSummary[] = [];
let pendingHostKey: HostKeyPrompt | null = null;
let transcript: Transcript;

let transcriptFilters: Record<string, string[]> = {};
let theme: ThemeChoice = "system";
let chatFontSize: ChatFontSize = 15;
let sendOnEnter = false;
let maintenanceMode = false;
let draftPromptsPath = "";
let capabilities: HostCapabilities | null = null;
let favorites: NewChatDefaults[] = [];
let favoritesCollapsed = false;

function availableHarnesses(): HarnessInfo[] {
  if (!capabilities) return HARNESSES;
  const version: Record<Harness, string | null | undefined> = {
    codex: capabilities.codexVersion,
    claude: capabilities.claudeVersion,
    opencode: capabilities.opencodeVersion,
    pi: capabilities.piVersion,
  };
  const present = HARNESSES.filter((h) => version[h.id]);
  // A host with no harness at all cannot connect, so this only covers a probe
  // that came back unreadable.
  return present.length ? present : HARNESSES;
}

let toastTimer: number | undefined;
function toast(message: string): void {
  const el = $("toast");
  el.textContent = message;
  show(el, true);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => show(el, false), 1800);
}

function overlay(text: string | null): void {
  const el = $("overlay");
  if (text === null) {
    show(el, false);
    return;
  }
  $("overlay-text").textContent = text;
  show(el, true);
}

type ScreenName = "connect" | "sessions" | "chat";
const SCREENS: ScreenName[] = ["connect", "sessions", "chat"];

function goto(screen: ScreenName): void {
  for (const name of SCREENS) {
    $(`screen-${name}`).classList.toggle("active", name === screen);
  }
  if (screen === "chat") transcript.scrollToBottom(true);
}

function isScreen(screen: ScreenName): boolean {
  return $(`screen-${screen}`).classList.contains("active");
}

// MainActivity offers every back press to the page through `__pabloBack` and
// closes the app only when the page dismissed nothing. Escape runs the same
// rule on desktop.
function navigateBack(): boolean {
  if (transcript.closeMenu()) return true;

  if (popupMenu) {
    closePopupMenu();
    return true;
  }

  // Before the modals: a dialog opened from this menu closes it on the way.
  if (!$("chat-menu").hidden) {
    closeChatMenu();
    return true;
  }

  // Listed rather than left to the generic rule below because each needs more
  // than being hidden: the host key prompt and the confirm dialog have to be
  // answered, the new-chat dialog clears any pending forward, and the file
  // chooser stops the transfer it may be running.
  if (!$("modal-hostkey").hidden) {
    rejectHostKey();
    return true;
  }
  if (!$("modal-confirm").hidden) {
    closeConfirm(false);
    return true;
  }
  if (!$("modal-newchat").hidden) {
    closeNewChatModal();
    return true;
  }
  if (!$("modal-openfile").hidden) {
    closeFileChooser();
    return true;
  }
  // Anything else is found in the DOM, so a modal added later is dismissible
  // without being listed here.
  const layer = document.querySelector<HTMLElement>(
    ".modal:not([hidden]), .drawer:not([hidden])",
  );
  if (layer) {
    show(layer, false);
    return true;
  }

  // The blocking spinner has no cancel, so back is swallowed rather than
  // pulling the screen out from under a running operation.
  if (!$("overlay").hidden) return true;

  if (isScreen("chat")) {
    openSessionsView();
    return true;
  }
  return false;
}

// Anything typed into a field belongs to the field, and an open layer owns
// the keyboard until it closes.
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function hasOpenLayer(): boolean {
  return (
    document.querySelector(
      ".bubble-menu, .image-viewer, .modal:not([hidden]), .drawer:not([hidden])",
    ) !== null ||
    !$("chat-menu").hidden ||
    !$("overlay").hidden
  );
}

function handleShortcut(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;

  // Ctrl+N is the one combination the app claims, and only on the picker.
  if (
    (e.ctrlKey || e.metaKey) &&
    !e.altKey &&
    !e.shiftKey &&
    e.key.toLowerCase() === "n"
  ) {
    if (!isScreen("sessions") || hasOpenLayer()) return;
    e.preventDefault();
    void openNewChatModal();
    return;
  }

  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingTarget(e.target) || hasOpenLayer()) return;

  if (isScreen("sessions")) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Or the list scrolls as well as moving the selection.
      e.preventDefault();
      moveSessionSelection(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter") {
      // A focused control answers its own Enter: refresh and new-chat sit one
      // Tab from the list, and a row is the only button here that means open.
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active.closest("button, a") &&
        !active.closest(".session-row")
      ) {
        return;
      }
      const s = selectedSession();
      if (!s) return;
      e.preventDefault();
      enterSession(s);
      return;
    }
    if (e.key === "Delete" && selectedSession()) {
      e.preventDefault();
      void deleteSelectedSession();
    }
    return;
  }

  if (isScreen("chat")) {
    if (e.key === "Delete") {
      e.preventDefault();
      deleteOpenSession();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      openSessionsView();
    }
  }
}

// One keyboard rule for every layer, hung off `show`: opening moves focus in,
// closing hands it back, arrows walk the buttons, Enter presses the one in
// front, Tab cannot leave.
const LAYERS = [
  ".image-viewer",
  ".bubble-menu",
  ".modal:not([hidden])",
  ".chat-menu:not([hidden])",
  ".drawer:not([hidden])",
];

const isLayer = (el: HTMLElement) =>
  el.classList.contains("modal") ||
  el.classList.contains("drawer") ||
  el.classList.contains("chat-menu") ||
  el.classList.contains("bubble-menu");

function topLayer(): HTMLElement | null {
  for (const selector of LAYERS) {
    const open = document.querySelectorAll<HTMLElement>(selector);
    // Two of a kind share a z-index, so the later one in the DOM is on top.
    if (open.length) return open[open.length - 1];
  }
  return null;
}

function isMenu(layer: HTMLElement): boolean {
  return (
    layer.classList.contains("bubble-menu") ||
    layer.classList.contains("chat-menu") ||
    layer.classList.contains("drawer")
  );
}

const onScreen = (el: HTMLElement) => el.getClientRects().length > 0;

function layerButtons(layer: HTMLElement): HTMLElement[] {
  return [
    ...layer.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
  ].filter(onScreen);
}

function layerFocusables(layer: HTMLElement): HTMLElement[] {
  return [
    ...layer.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])," +
        ' textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter(onScreen);
}

function layerDefault(layer: HTMLElement): HTMLElement | null {
  const marked = layer.querySelector<HTMLElement>("[data-autofocus]");
  if (marked) return marked;
  const field = [
    ...layer.querySelectorAll<HTMLElement>(
      "input:not([type=checkbox]):not([type=radio]), select, textarea",
    ),
  ].find(onScreen);
  if (field) return field;
  return (
    layer.querySelector<HTMLElement>(".modal-actions .primary") ??
    layerButtons(layer)[0] ??
    null
  );
}

const layerReturn = new WeakMap<HTMLElement, HTMLElement>();

function enterLayer(layer: HTMLElement): void {
  const from = document.activeElement;
  if (from instanceof HTMLElement && from !== document.body)
    layerReturn.set(layer, from);
  const target = isMenu(layer)
    ? (layer.querySelector<HTMLElement>('[tabindex="-1"]') ?? layer)
    : layerDefault(layer);
  target?.focus({ preventScroll: true });
}

function leaveLayer(layer: HTMLElement): void {
  const back = layerReturn.get(layer);
  layerReturn.delete(layer);
  if (!back) return;
  // A frame later, not now: a button pressed with Enter is clicked by the
  // browser *after* the handlers that closed this layer have run, and focus
  // moved inside that window catches the keypress.
  requestAnimationFrame(() => {
    // Unless another layer has taken focus meanwhile, it owns the keyboard,
    // not the one that left. This layer's own controls do not count: hiding
    // the focused button does not move `activeElement` off it.
    const active = document.activeElement;
    const taken =
      active instanceof HTMLElement &&
      active !== document.body &&
      !layer.contains(active) &&
      onScreen(active);
    if (taken) return;
    // The opener can be gone by now, picker rows are rebuilt by the poll,
    // and the drawer closes under the dialogs it opens, in which case the
    // screen underneath takes the keyboard rather than nothing at all.
    if (back.isConnected && onScreen(back)) back.focus({ preventScroll: true });
    else refocusScreen();
  });
}

function refocusScreen(): void {
  // Only the picker has somewhere to stand: the chat's shortcuts are read off
  // the document.
  if (isScreen("sessions") && selectedSessionKey)
    selectSession(selectedSessionKey);
}

function fieldOwnsKeys(el: HTMLElement | null): boolean {
  if (!isTypingTarget(el)) return false;
  return !(el instanceof HTMLInputElement && el.type === "checkbox");
}

function handleLayerKeys(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const layer = topLayer();
  if (!layer) return;
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const inside = active !== null && layer.contains(active);

  // Tab cycles within the layer instead of walking off it onto the screen
  // underneath, which is not reachable while the layer is up.
  if (e.key === "Tab") {
    const stops = layerFocusables(layer);
    if (!stops.length) return;
    const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
    if (inside && active !== edge) return;
    e.preventDefault();
    (e.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
    return;
  }

  if (fieldOwnsKeys(active)) return;

  const buttons = layerButtons(layer);
  if (buttons.length === 0) return;
  const at = buttons.findIndex(
    (b) => b === active || (active !== null && b.contains(active)),
  );

  if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)) {
    // All four: the action rows are horizontal, the menus and the Open file
    // choices vertical, and guessing wrong is worse than accepting both.
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
    e.preventDefault();
    // From nothing (a menu just opened) forward starts at the first button
    // and back at the last, the rule the session list follows.
    const next =
      at === -1
        ? forward
          ? 0
          : buttons.length - 1
        : (at + (forward ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
    return;
  }

  if (e.key === "Enter") {
    // A focused button answers for itself. This is only for the Enter that
    // arrives with focus somewhere that cannot use it, and never in a menu,
    // where there is no default choice to press.
    if (at !== -1 || isMenu(layer)) return;
    const fallback = layerDefault(layer);
    if (!(fallback instanceof HTMLButtonElement)) return;
    e.preventDefault();
    fallback.click();
  }
}

function showError(panelId: string, title: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const panel = $(panelId);
  const full = `${title}\n\n${message}`;
  // The panel is shared with `showNotice`, which leaves its own class behind.
  panel.classList.remove("notice");
  panel.textContent = `${full}\n\n(tap to copy)`;
  show(panel, true);
  void api.logClient("ui", `${title}: ${message}`);
  panel.onclick = () => {
    void writeText(full).then(
      () => toast("Copied error"),
      () => toast("Copy failed"),
    );
  };
}

function showNotice(panelId: string, text: string): void {
  const panel = $(panelId);
  panel.classList.add("notice");
  panel.textContent = text;
  panel.onclick = null;
  show(panel, true);
}

function hideError(panelId: string): void {
  show($(panelId), false);
}

function showConnectError(title: string, err: unknown): void {
  showError("connect-error", title, err);
  const body = $("screen-connect").querySelector<HTMLElement>(".scroll-body");
  if (!body) return;
  const toBottom = (): void => {
    body.scrollTop = body.scrollHeight;
  };
  toBottom();
  requestAnimationFrame(toBottom);
}

function showAlert(title: string, body: string): void {
  $("alert-title").textContent = title;
  $("alert-body").textContent = body;
  show($("modal-alert"), true);
}

function askConfirm(
  title: string,
  body: string,
  confirmLabel = "OK",
): Promise<boolean> {
  // A question already on screen is abandoned rather than stacked.
  closeConfirm(false);
  $("confirm-title").textContent = title;
  $("confirm-body").textContent = body;
  const ok = $<HTMLButtonElement>("confirm-ok");
  ok.textContent = confirmLabel;
  ok.classList.toggle("danger", confirmLabel !== "OK");
  // No focus call: `show` puts it on the primary answer, which is this button.
  show($("modal-confirm"), true);
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve;
  });
}

let confirmResolve: ((ok: boolean) => void) | null = null;

function closeConfirm(answer: boolean): void {
  const resolve = confirmResolve;
  confirmResolve = null;
  show($("modal-confirm"), false);
  resolve?.(answer);
}

// Android resizes the visual viewport when the soft keyboard opens. Driving
// --app-height from visualViewport keeps the composer pinned above the IME
// instead of being covered by it.

const INSET_EDGES = ["top", "right", "bottom", "left"] as const;
type InsetEdge = (typeof INSET_EDGES)[number];

function installSystemInsets(): void {
  const apply = (insets: Partial<Record<InsetEdge, number>>) => {
    const root = document.documentElement.style;
    for (const edge of INSET_EDGES) {
      const value = insets?.[edge];
      // A bridge that answered with something unusable must not collapse the
      // padding it was meant to set.
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        root.setProperty(`--inset-${edge}`, `${value}px`);
      }
    }
  };

  // Pushed on every change from here on: rotation, a bar appearing, the IME.
  window.__pabloInsets = apply;
  // Asked for once as well, because the first dispatch happened before this
  // page existed to be told.
  const reported = window.PabloSystemBars?.insets?.();
  if (!reported) return;
  try {
    apply(JSON.parse(reported));
  } catch {
    // Leave the env() defaults standing.
  }
}

function installViewportHandling(): void {
  const applyHeight = () => {
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty("--app-height", `${height}px`);
  };

  applyHeight();
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      applyHeight();
      // Keep the newest message visible as the keyboard animates in.
      if (isScreen("chat")) {
        transcript.scrollToBottom(true);
      }
    });
    window.visualViewport.addEventListener("scroll", applyHeight);
  }
  window.addEventListener("resize", applyHeight);
  window.addEventListener("orientationchange", () =>
    setTimeout(applyHeight, 250),
  );
}

function readConnectForm(): SshSettings {
  return {
    host: $<HTMLInputElement>("in-host").value.trim(),
    port: Number($<HTMLInputElement>("in-port").value) || 22,
    username: $<HTMLInputElement>("in-user").value.trim(),
    password: $<HTMLInputElement>("in-pass").value,
    codexBin: $<HTMLInputElement>("in-codex").value.trim() || "codex",
    claudeBin: $<HTMLInputElement>("in-claude").value.trim() || "claude",
    opencodeBin: $<HTMLInputElement>("in-opencode").value.trim() || "opencode",
    piBin: $<HTMLInputElement>("in-pi").value.trim() || "pi",
    defaultCwd: $<HTMLInputElement>("in-cwd").value.trim(),
  };
}

function fillConnectForm(s: SshSettings | null): void {
  $<HTMLInputElement>("in-host").value = s?.host ?? "";
  $<HTMLInputElement>("in-port").value = String(s?.port ?? 22);
  $<HTMLInputElement>("in-user").value = s?.username ?? "";
  $<HTMLInputElement>("in-pass").value = s?.password ?? "";
  $<HTMLInputElement>("in-codex").value = s?.codexBin ?? "codex";
  $<HTMLInputElement>("in-claude").value = s?.claudeBin ?? "claude";
  $<HTMLInputElement>("in-opencode").value = s?.opencodeBin ?? "opencode";
  $<HTMLInputElement>("in-pi").value = s?.piBin ?? "pi";
  $<HTMLInputElement>("in-cwd").value = s?.defaultCwd ?? "";
}

async function doConnect(next: SshSettings): Promise<void> {
  hideError("connect-error");
  // Whatever the old connection was still reading is about to describe a
  // different machine's sessions, and so do the favorites on screen.
  sessionsGeneration += 1;
  setFavorites([]);
  overlay("Connecting…");
  try {
    const outcome = await api.connect(next);
    if (outcome.status === "hostKeyUnverified") {
      overlay(null);
      pendingHostKey = outcome.prompt;
      openHostKeyModal(outcome.prompt);
      return;
    }
    settings = next;
    capabilities = outcome.capabilities;
    resetModelCatalogs();
    try {
      await api.saveSettings(next);
    } catch (err) {
      overlay(null);
      goto("connect");
      showConnectError("Connected, but could not save the settings", err);
      return;
    }
    // A host whose CLI has never run has no sessions directory at all, which
    // would otherwise look like an empty list for no stated reason.
    if (!outcome.capabilities.sessionsDirExists) {
      void api.logClient(
        "connect",
        `no codex sessions directory at ${outcome.capabilities.sessionsDir} yet`,
      );
    }
    if (!outcome.capabilities.projectsDirExists) {
      void api.logClient(
        "connect",
        `no claude projects directory at ${outcome.capabilities.projectsDir} yet`,
      );
    }
    if (!outcome.capabilities.opencodeDbExists) {
      void api.logClient(
        "connect",
        `no opencode database at ${outcome.capabilities.opencodeDb} yet`,
      );
    }
    if (!outcome.capabilities.piSessionsDirExists) {
      void api.logClient(
        "connect",
        `no pi sessions directory at ${outcome.capabilities.piSessionsDir} yet`,
      );
    }
    void api.logClient(
      "connect",
      `harnesses available: ${availableHarnesses()
        .map((h) => h.id)
        .join(", ")}`,
    );
    overlay("Loading sessions…");
    await refreshSessions(true);
    overlay(null);
    goto("sessions");
  } catch (err) {
    overlay(null);
    goto("connect");
    showConnectError("Could not connect", err);
  }
}

async function ensureConnected(): Promise<boolean> {
  try {
    if (await api.isConnected()) return true;
  } catch {
    /* fall through and try to connect */
  }
  if (!settings?.host || !settings.username || !settings.password) return false;
  try {
    const outcome = await api.connect(settings);
    if (outcome.status === "connected") capabilities = outcome.capabilities;
    return outcome.status === "connected";
  } catch (err) {
    void api.logClient("ui", `reconnect failed: ${err}`);
    return false;
  }
}

function openHostKeyModal(prompt: HostKeyPrompt): void {
  $("hk-host").textContent = `${prompt.host}:${prompt.port}`;
  $("hk-alg").textContent = prompt.algorithm;
  $("hk-fp").textContent = prompt.fingerprint;
  $("hk-full").textContent = prompt.openssh;

  const warning = $("hostkey-warning");
  if (prompt.mismatch) {
    warning.textContent =
      `WARNING: this host previously presented a different key ` +
      `(${prompt.previousFingerprint ?? "unknown"}). This can mean the server ` +
      `was rebuilt — or that someone is intercepting the connection. Only ` +
      `accept if you know why the key changed.`;
    show(warning, true);
  } else {
    show(warning, false);
  }
  show($("modal-hostkey"), true);
}

function rejectHostKey(): void {
  pendingHostKey = null;
  show($("modal-hostkey"), false);
  showConnectError(
    "Host key rejected",
    "The connection was abandoned because the server's host key was not accepted.",
  );
}

function relativeTime(unixSeconds: number | null | undefined): string | null {
  if (
    unixSeconds == null ||
    !Number.isFinite(unixSeconds) ||
    unixSeconds <= 0
  ) {
    return null;
  }
  // Codex reports seconds; tolerate milliseconds in case a field ever changes.
  const seconds = unixSeconds > 1e11 ? unixSeconds / 1000 : unixSeconds;
  const delta = Date.now() / 1000 - seconds;

  // Server clocks running ahead would otherwise read as "in the future".
  if (delta < 45) return "just now";

  const plural = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  const minutes = delta / 60;
  if (minutes < 60) return plural(Math.round(minutes), "min");
  const hours = minutes / 60;
  if (hours < 24) return plural(Math.round(hours), "hour");
  const days = hours / 24;
  if (days < 2) return "yesterday";
  if (days < 7) return plural(Math.round(days), "day");
  const weeks = days / 7;
  if (weeks < 5) return plural(Math.round(weeks), "week");
  const months = days / 30.44;
  if (months < 12) return plural(Math.round(months), "month");
  return plural(Math.round(days / 365.25), "year");
}

const COMPACT_AGE_UNITS: [number, string][] = [
  [31_557_600, "y"],
  [2_629_800, "mo"],
  [604_800, "w"],
  [86_400, "d"],
  [3_600, "h"],
  [60, "m"],
];

function compactAge(unixSeconds: number | null | undefined): string | null {
  if (
    unixSeconds == null ||
    !Number.isFinite(unixSeconds) ||
    unixSeconds <= 0
  ) {
    return null;
  }
  const elapsed = Date.now() / 1000 - unixSeconds;
  for (const [size, unit] of COMPACT_AGE_UNITS) {
    if (elapsed >= size) return `${Math.floor(elapsed / size)}${unit} ago`;
  }
  return "just now";
}

function relativeLabel(at: number, format: string | undefined): string | null {
  if (format === "short") return shortWhen(at);
  if (format === "compact") return compactAge(at);
  return relativeTime(at);
}

function relativeSpan(
  unixSeconds: number | null | undefined,
  label = "",
  className = "",
): HTMLElement | null {
  const rel = relativeTime(unixSeconds);
  if (rel === null) return null;
  const span = document.createElement("span");
  if (className) span.className = className;
  span.dataset.relAt = String(unixSeconds);
  span.dataset.relLabel = label;
  span.textContent = `${label}${rel}`;
  return span;
}

function refreshRelativeLabels(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-rel-at]")) {
    const at = Number(el.dataset.relAt);
    const text = relativeLabel(at, el.dataset.relFormat);
    if (text !== null) el.textContent = `${el.dataset.relLabel ?? ""}${text}`;
  }
}

function shortWhen(unixSeconds: number | null | undefined): string | null {
  if (
    unixSeconds == null ||
    !Number.isFinite(unixSeconds) ||
    unixSeconds <= 0
  ) {
    return null;
  }
  const seconds = unixSeconds > 1e11 ? unixSeconds / 1000 : unixSeconds;
  const then = new Date(seconds * 1000);
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days =
    Math.floor((midnight.getTime() - then.getTime()) / 86_400_000) + 1;
  if (days <= 0) {
    return then.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (days === 1) return "Yesterday";
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: "short" });
  return then.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

function sessionGroupLabel(unixSeconds: number | null | undefined): string {
  if (
    unixSeconds == null ||
    !Number.isFinite(unixSeconds) ||
    unixSeconds <= 0
  ) {
    return "Undated";
  }
  const seconds = unixSeconds > 1e11 ? unixSeconds / 1000 : unixSeconds;
  const then = new Date(seconds * 1000);
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days =
    Math.floor((midnight.getTime() - then.getTime()) / 86_400_000) + 1;
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Earlier this week";
  if (days < 31) return "This month";
  return "Older";
}

function sessionLabel(s: SessionSummary, max = 42): string {
  return (
    truncateLabel(s.label || s.title || s.preview, max) ?? "(no prompt yet)"
  );
}

function sessionTitle(s: SessionSummary, max = 42): string {
  return truncateLabel(s.title || s.preview, max) ?? "(no prompt yet)";
}

function truncateLabel(text: string | null, max = 42): string | null {
  const raw = (text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  return raw.length <= max ? raw : `${raw.slice(0, max)}…`;
}

function inCurrentOrder(fresh: SessionSummary[]): SessionSummary[] {
  const key = (s: SessionSummary) => `${s.harness}:${s.id}`;
  const incoming = new Map(fresh.map((s) => [key(s), s]));
  const kept: SessionSummary[] = [];
  for (const s of sessions) {
    const updated = incoming.get(key(s));
    if (!updated) continue;
    kept.push(updated);
    incoming.delete(key(s));
  }
  // Anything left is new since the last full refresh. `fresh` is newest-first
  // already, and the top is where a new row belongs on a recency list.
  return [...incoming.values(), ...kept];
}

async function refreshSessionsNow(full: boolean): Promise<void> {
  // Read before the await, compared after it: a reply from a connection that
  // has since been forgotten or replaced must be dropped.
  const generation = sessionsGeneration;
  try {
    // Sorted against the very timestamp the cards display, so the list can
    // never disagree with the "Last message" chip.
    const list = await api.listSessions(full);
    const fresh = list.sessions
      .slice()
      .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
    if (generation !== sessionsGeneration) return;
    if (list.favorites) setFavorites(list.favorites);
    // A background poll updates what the rows say, never where they sit, a
    // list re-sorted every 1.5s shuffles under the reader's finger. The order
    // changes only on a full refresh.
    sessions = full ? fresh : inCurrentOrder(fresh);
    renderSessionList();
    renderChatSessionPill();
    // Cleared here rather than before the attempt, or the panel flashes every
    // 1.5s while the server is unreachable.
    hideError("sessions-error");
  } catch (err) {
    if (generation !== sessionsGeneration) return;
    if (full) {
      showError("sessions-error", "Could not refresh the session list", err);
      // The panel lives on the picker, but a full refresh can be asked for
      // from the chat's own menu.
      if (!isScreen("sessions")) toast("Could not refresh the session list");
    } else {
      // Nobody asked, so nobody is owed a diagnosis, but silence would read as
      // a list that is up to date. The rows on screen stay.
      showNotice(
        "sessions-error",
        "Session list cannot be updated right now and might be out of date.",
      );
      void api.logClient("ui", `session list poll failed: ${String(err)}`);
    }
  }
}

function refreshSessions(full = false, force = false): Promise<void> {
  if (sessionsRefreshPromise) {
    if (full && (force || !sessionsRefreshIsFull)) {
      sessionsRefreshIsFull = true;
      sessionsRefreshPromise = trackRefresh(
        sessionsRefreshPromise.then(() => refreshSessionsNow(true)),
      );
    }
    return sessionsRefreshPromise;
  }
  sessionsRefreshIsFull = full;
  sessionsRefreshPromise = trackRefresh(refreshSessionsNow(full));
  return sessionsRefreshPromise;
}

function trackRefresh(p: Promise<void>): Promise<void> {
  const tracked: Promise<void> = p.finally(() => {
    if (sessionsRefreshPromise === tracked) {
      sessionsRefreshPromise = null;
      sessionsRefreshIsFull = false;
    }
  });
  return tracked;
}

// A row shows a running turn, or a finished unread one in success or failure
// colours. A read finished turn keeps its status for assistive technology and
// adds no icon. A session this app never ran gets no icon either: its state is
// genuinely unknown, and a tick would claim a turn nobody watched succeeded.
// The box is laid out either way, so every title starts at the same place.
interface SessionMark {
  state: TurnState;
  unread: boolean;
}

const isOpenSession = (s: Pick<SessionSummary, "harness" | "id">) =>
  s.harness === chat.harness && s.id === chat.threadId;

function sessionMark(s: SessionSummary): SessionMark {
  const ours = chat.turnActive && isOpenSession(s);
  const state: TurnState = ours ? "running" : (s.turnState ?? "unknown");
  const at = s.turnAt ?? 0;
  // The read mark lives in the app's sidecar record on the server, so any
  // device having read the turn answers for all of them.
  const readAt = s.readAt ?? 0;
  const unread =
    (state === "succeeded" || state === "failed") && at > 0 && readAt < at;
  return { state, unread };
}

function sessionStatusIcon(mark: SessionMark): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "session-row-status";

  if (mark.state === "running") {
    cell.classList.add("running");
    cell.title = "Still working";
  } else if (mark.state === "succeeded" || mark.state === "failed") {
    const ok = mark.state === "succeeded";
    cell.classList.add(ok ? "ok" : "failed");
    // The dot is drawn in CSS from these two classes: the colour says which of
    // the two finished states it was, and `unread` is what fills it in.
    if (mark.unread) cell.classList.add("unread");
    cell.title = mark.unread
      ? ok
        ? "Finished while you were away — not read yet"
        : "Failed while you were away — not read yet"
      : ok
        ? "Last turn finished"
        : "Last turn failed";
  } else {
    cell.classList.add("unknown");
  }

  // The dot is decoration on a button whose label is the row's title, so the
  // state is announced here rather than left to a 14px circle.
  cell.setAttribute("role", "img");
  cell.setAttribute("aria-label", cell.title || "No turn status");
  return cell;
}

function markSessionRead(id: string | null): void {
  if (!id) return;
  const session = sessions.find(
    (s) => s.harness === chat.harness && s.id === id,
  );
  if (!session || session.turnState === "running") return;
  const at = session.turnAt ?? 0;
  if (at <= 0 || (session.readAt ?? 0) >= at) return;
  // Optimistic: the row clears now, and never-backwards on the server means
  // the race with the next list refresh cannot lose a newer mark.
  session.readAt = at;
  void api.markSessionRead(session.harness, id, at).catch((err) => {
    // A mark that failed to persist costs one stale unread icon, not worth
    // interrupting the reader for.
    void api.logClient("ui", `could not persist read mark for ${id}: ${err}`);
  });
  renderSessionList();
}

function sessionSubtitle(
  s: SessionSummary,
  mark: SessionMark,
  shown: string,
): string {
  if (mark.state === "running") return "Working…";
  const label = s.label?.trim() ?? "";
  if (label) return label;
  const preview = s.preview?.trim() ?? "";
  // Compared against what the title line actually says, not against
  // `s.title`: a session with no AI title shows its prompt up there.
  if (preview && preview !== shown.trim()) return preview;
  const cwd = s.cwd?.trim() ?? "";
  if (cwd) return cwd.split("/").filter(Boolean).pop() ?? cwd;
  return "No messages yet";
}

// Where a hardware keyboard is standing in the list, held as the session's own
// key rather than a row or an index: the poll rebuilds every row every 1.5s.
const sessionKey = (s: SessionSummary) => `${s.harness}:${s.id}`;

let selectedSessionKey: string | null = null;

function sessionRows(): HTMLButtonElement[] {
  return [
    ...$("session-list").querySelectorAll<HTMLButtonElement>(".session-row"),
  ];
}

function selectedSession(): SessionSummary | null {
  return sessions.find((s) => sessionKey(s) === selectedSessionKey) ?? null;
}

function paintSessionSelection(): void {
  for (const row of sessionRows()) {
    row.classList.toggle("selected", row.dataset.key === selectedSessionKey);
  }
}

function selectSession(key: string | null, focus = true): void {
  selectedSessionKey = key;
  paintSessionSelection();
  if (!focus || key === null) return;
  const row = sessionRows().find((r) => r.dataset.key === key);
  row?.scrollIntoView({ block: "nearest" });
  row?.focus({ preventScroll: true });
}

function moveSessionSelection(delta: number): void {
  const rows = sessionRows();
  if (rows.length === 0) return;
  const at = rows.findIndex((r) => r.dataset.key === selectedSessionKey);
  const next =
    at === -1
      ? delta > 0
        ? 0
        : rows.length - 1
      : Math.min(Math.max(at + delta, 0), rows.length - 1);
  selectSession(rows[next].dataset.key ?? null);
}

function enterSession(s: SessionSummary): void {
  if (isOpenSession(s)) {
    goto("chat");
    // Going back to the open chat is reading it too.
    markSessionRead(s.id);
    consumePendingForward();
  } else {
    void openSession(s);
  }
}

async function deleteSelectedSession(): Promise<void> {
  const s = selectedSession();
  if (!s) return;
  const reason = harnessById(s.harness).cannotDeleteReason;
  if (reason) {
    // The row's own menu says this on a disabled item; a key press has nowhere
    // to write it, and one that quietly does nothing reads as a broken key.
    showAlert("Cannot delete this session", `Deleting a session is ${reason}.`);
    return;
  }
  const rows = sessionRows();
  const at = rows.findIndex((r) => r.dataset.key === sessionKey(s));
  const neighbour =
    rows[at + 1]?.dataset.key ?? rows[at - 1]?.dataset.key ?? null;
  if (await deleteSessionFromServer(s)) selectSession(neighbour);
}

function renderSessionList(): void {
  const list = $("session-list");
  // Asked before the rows are thrown away: focus lands on <body> the moment
  // they are, and the poll must put it back, but only if it was here, or a
  // rebuild would yank it out of whatever dialog is open over this screen.
  const keepFocus = list.contains(document.activeElement);
  if (
    selectedSessionKey &&
    !sessions.some((s) => sessionKey(s) === selectedSessionKey)
  ) {
    selectedSessionKey = null;
  }
  list.innerHTML = "";

  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted small session-empty";
    empty.textContent =
      "No Codex, Claude Code, opencode or pi sessions on this server yet. Click the plus button to start a new session.";
    list.appendChild(empty);
    return;
  }

  // The list arrives ordered by recency, so one pass in order is all the
  // grouping takes.
  let group: string | null = null;

  for (const s of sessions) {
    const label = sessionGroupLabel(s.modifiedAt);
    if (label !== group) {
      group = label;
      const heading = document.createElement("div");
      heading.className = "session-group";
      heading.textContent = label;
      list.appendChild(heading);
    }

    const row = document.createElement("button");
    row.type = "button";
    row.className = "session-row";
    // On the row rather than the avatar: a custom property set here reaches
    // the avatar without a second four-way switch in CSS.
    row.dataset.harness = s.harness;
    row.dataset.key = sessionKey(s);
    if (row.dataset.key === selectedSessionKey) row.classList.add("selected");
    const isCurrent = isOpenSession(s);
    if (isCurrent) row.classList.add("current");
    if (s.closedAt !== null) row.classList.add("closed");
    const mark = sessionMark(s);
    if (mark.unread) row.classList.add("unread");
    if (mark.state === "running") row.classList.add("running");

    const avatar = document.createElement("span");
    avatar.className = "session-avatar";
    avatar.appendChild(
      paintHarnessIcon(document.createElement("span"), s.harness),
    );
    row.appendChild(avatar);

    const body = document.createElement("span");
    body.className = "session-row-body";

    const top = document.createElement("span");
    top.className = "session-row-top";
    const title = document.createElement("span");
    title.className = "session-row-title";
    title.textContent = s.title || s.preview || "(no prompt yet)";
    top.appendChild(title);
    if (s.closedAt !== null) {
      const closed = document.createElement("span");
      closed.className = "session-row-closed";
      closed.textContent = "Closed";
      top.appendChild(closed);
    }
    const when = relativeSpan(s.modifiedAt, "", "session-row-when");
    if (when) {
      when.dataset.relFormat = "short";
      when.textContent = shortWhen(s.modifiedAt) ?? "";
      top.appendChild(when);
    }
    body.appendChild(top);

    const bottom = document.createElement("span");
    bottom.className = "session-row-bottom";
    const sub = document.createElement("span");
    sub.className = "session-row-sub";
    sub.textContent = sessionSubtitle(s, mark, title.textContent ?? "");
    bottom.appendChild(sub);
    // The exit status belongs on the row that reports the failure, not only in
    // the transcript you have to open to find it.
    if (mark.state === "failed" && s.turnExitCode !== null) {
      const failed = document.createElement("span");
      failed.className = "session-row-exit";
      failed.textContent = `Exit ${s.turnExitCode}`;
      bottom.appendChild(failed);
    }
    bottom.appendChild(sessionStatusIcon(mark));
    body.appendChild(bottom);

    row.appendChild(body);

    row.addEventListener("click", () => {
      if (consumeLongPress(row)) return;
      // The tap is also where the keyboard now stands, so coming back from the
      // chat leaves the arrows where the finger left them.
      selectSession(row.dataset.key ?? null, false);
      enterSession(s);
    });
    // Tab into the list and the mark follows: two ideas of "the current row"
    // must not disagree.
    row.addEventListener("focus", () =>
      selectSession(row.dataset.key ?? null, false),
    );
    attachHoldMenu(row, (at) => openSessionMenu(s, at));
    list.appendChild(row);
  }

  if (keepFocus) {
    sessionRows()
      .find((r) => r.dataset.key === selectedSessionKey)
      ?.focus({ preventScroll: true });
  }
}

// The same hold gesture as a chat bubble's, rebuilt here because these are
// live controls whose tap already means something (a row opens, the send
// button submits), so the hold has to win without the release running the tap.
const longPressed = new WeakSet<HTMLElement>();

function consumeLongPress(el: HTMLElement): boolean {
  return longPressed.delete(el);
}

function attachHoldMenu(el: HTMLElement, open: (at: MenuAnchor) => void): void {
  let timer: number | undefined;
  let startX = 0;
  let startY = 0;
  const cancel = () => {
    window.clearTimeout(timer);
    timer = undefined;
  };

  el.addEventListener("pointerdown", (ev) => {
    if (!ev.isPrimary || ev.button !== 0) return;
    cancel();
    longPressed.delete(el);
    startX = ev.clientX;
    startY = ev.clientY;
    timer = window.setTimeout(() => {
      timer = undefined;
      longPressed.add(el);
      open({ x: startX, y: startY });
    }, 550);
  });
  el.addEventListener("pointermove", (ev) => {
    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 10) cancel();
  });
  for (const event of ["pointerup", "pointercancel", "pointerleave"] as const) {
    el.addEventListener(event, cancel);
  }
  // The click that ends a hold is the release, not a choice: swallow it so a
  // submit button cannot send and a row cannot open what the menu now covers.
  // A handler attached before the control's own sees the flag first; one
  // attached after finds it already consumed, either one stops the tap.
  el.addEventListener("click", (ev) => {
    if (!longPressed.delete(el)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  });
  el.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    cancel();
    longPressed.add(el);
    open({ x: ev.clientX, y: ev.clientY });
  });
}

let popupMenu: HTMLElement | null = null;

function closePopupMenu(): void {
  const menu = popupMenu;
  popupMenu = null;
  if (!menu) return;
  menu.remove();
  // Back to the control it was opened from, so the arrows carry on from there.
  leaveLayer(menu);
}

interface PopupAction {
  label: string;
  run: () => void;
  danger?: boolean;

  disabled?: boolean;
  sub?: string;
  hold?: (at: MenuAnchor) => void;
}

function openPopupMenu(actions: PopupAction[], at?: MenuAnchor): void {
  closePopupMenu();

  const menu = document.createElement("div");
  menu.className = "bubble-menu";
  menu.setAttribute("role", "presentation");
  const sheet = document.createElement("div");
  sheet.className = "bubble-menu-sheet";
  sheet.setAttribute("role", "menu");
  sheet.tabIndex = -1;

  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.danger
      ? "bubble-menu-item danger"
      : "bubble-menu-item";
    button.setAttribute("role", "menuitem");
    if (action.sub) {
      const title = document.createElement("span");
      title.textContent = action.label;
      const sub = document.createElement("span");
      sub.className = "bubble-menu-sub";
      sub.textContent = action.sub;
      button.append(title, sub);
    } else {
      button.textContent = action.label;
    }
    // Before the tap handler, so a completed hold swallows the release click.
    if (action.hold) attachHoldMenu(button, action.hold);
    if (action.disabled) {
      button.disabled = true;
    } else {
      button.addEventListener("click", () => {
        closePopupMenu();
        action.run();
      });
    }
    sheet.appendChild(button);
  }

  menu.appendChild(sheet);
  menu.addEventListener("click", (ev) => {
    if (ev.target === menu) closePopupMenu();
  });
  menu.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    // Swallowed, or the document's own Escape handler would also close
    // whatever the menu was opened over.
    ev.stopPropagation();
    closePopupMenu();
  });
  popupMenu = menu;
  document.body.appendChild(menu);
  anchorMenu(menu, sheet, at);
  // The sheet takes focus rather than an item; see `isMenu`.
  enterLayer(menu);
}

function openSessionMenu(s: SessionSummary, at?: MenuAnchor): void {
  const harness = harnessById(s.harness);
  // The id is the handle every other tool wants and appears nowhere else in
  // the UI.
  openPopupMenu(
    [
      {
        label: "Copy session ID",
        run: () =>
          void writeText(s.id).then(
            () => toast("Session ID copied"),
            () => toast("Copy failed"),
          ),
      },
      {
        label: "Session details…",
        run: () => openSessionDetails(detailsTargetFor(s)),
      },
      harness.cannotDeleteReason
        ? {
            label: `Delete from server — ${harness.cannotDeleteReason}`,
            run: () => {},
            danger: true,
            disabled: true,
          }
        : {
            label: "Delete from server…",
            danger: true,
            run: () => void deleteSessionFromServer(s),
          },
    ],
    at,
  );
}

function deletionTargets(s: SessionSummary): string[] {
  const targets = [s.path];
  if (s.harness === "claude" && s.path.endsWith(".jsonl")) {
    const dir = s.path.slice(0, -".jsonl".length);
    targets.push(`${dir}/ (subagent transcripts and tool results, if any)`);
    targets.push("its session-env record (if any)");
  }
  targets.push("its rewind backup (if any)");
  return targets;
}

async function deleteSessionFromServer(s: SessionSummary): Promise<boolean> {
  const targets = deletionTargets(s)
    .map((t) => `• ${t}`)
    .join("\n");
  const ok = await askConfirm(
    "Delete this session?",
    `"${sessionLabel(s)}"\n\nThis removes from the server:\n${targets}\n\n` +
      "This cannot be undone.",
    "Delete",
  );
  if (!ok) return false;
  return removeSessionFromServer(s);
}

async function removeSessionFromServer(
  s: Pick<SessionSummary, "path" | "harness" | "id">,
): Promise<boolean> {
  overlay("Deleting session…");
  try {
    await api.deleteSession(s.path, harnessById(s.harness).id, s.id);
  } catch (err) {
    overlay(null);
    showError("sessions-error", "Could not delete the session", err);
    // The panel lives on the picker, so a delete asked for from the chat's own
    // menu needs the failure said where the reader is standing.
    if (!isScreen("sessions")) toast("Could not delete the session");
    return false;
  }
  // The chat re-reads the session file to follow it, so one left pointing at
  // the deleted session would fail on its next read.
  if (isOpenSession(s)) {
    resetChat();
    renderChatSessionPill();
  }
  await refreshSessions(true);
  overlay(null);
  toast("Session deleted");
  return true;
}

function renderChatSessionPill(): void {
  const title = $("chat-session-title");
  const sub = $("chat-session-sub");
  const button = $<HTMLButtonElement>("chat-session");
  const current = sessions.find(isOpenSession);
  const labelable = chat.threadId !== null;
  const closed = Boolean(current && current.closedAt !== null);

  button.classList.toggle("closed", closed);
  $("chat-status").classList.toggle("closed", closed);

  // `chat.title` covers the gap where a brand-new session gains a harness title
  // mid-first-turn, before the picker has a row to carry it.
  // Untruncated: the pill's CSS clips to the width it has, so a cut here would
  // add an ellipsis the wide desktop header does not need.
  title.textContent =
    chat.title ||
    (current
      ? sessionTitle(current, Infinity)
      : chat.rolloutPath || chat.turnActive
        ? "New chat"
        : "No session");

  // Never disabled: a title that cannot be changed still answers a tap with the
  // reason, and a dead control is indistinguishable from a broken one.
  button.disabled = false;
  button.setAttribute(
    "aria-label",
    labelable ? "Session details" : "Session title",
  );
  sub.textContent =
    truncateLabel(chat.label, Infinity) ?? (labelable ? "Tap to label" : "");
  delete sub.dataset.relAt;
}

function openSessionsView(): void {
  const unlisted =
    chat.threadId !== null &&
    !sessions.some((s) => s.harness === chat.harness && s.id === chat.threadId);
  if (unlisted) {
    void (async () => {
      overlay("Refreshing sessions…");
      try {
        await refreshSessions(true);
      } finally {
        overlay(null);
        goto("sessions");
      }
    })();
    return;
  }
  renderSessionList();
  goto("sessions");
  // Background updates may change every field in a row, but not its position.
  void refreshSessions();
}

function setTurnActive(active: boolean, label?: string): void {
  chat.turnActive = active;
  renderChatMenuRefresh();
  renderChatMenuDelete();
  show($("typing"), active);
  show($("chat-interrupt"), active);
  $("typing-label").textContent =
    label ?? `${harnessById(chat.harness).agentName} is working…`;
  $<HTMLButtonElement>("composer-send").disabled = active;
  // Unforced: this runs on every poll, and a forced scroll would drag a
  // reader who had scrolled up back to the bottom for the whole turn.
  if (active) transcript.scrollToBottom();
}

function paintHarnessIcon(el: HTMLElement, harness: Harness): HTMLElement {
  const info = harnessById(harness);
  el.className = "harness-icon";
  el.innerHTML = info.icon;
  el.style.color = info.iconColour;
  el.setAttribute("role", "img");
  el.title = info.label;
  el.setAttribute("aria-label", info.label);
  return el;
}

function setChatStatus(harness: Harness, text: string): void {
  paintHarnessIcon($("chat-harness-icon"), harness);
  $("chat-status-text").textContent = text;
  show($("chat-status"), true);
}

function watchChatStatusHeight(): void {
  const bar = $("chat-status");
  new ResizeObserver(() => {
    const height = bar.offsetHeight;
    if (height > 0) {
      document.documentElement.style.setProperty(
        "--chat-status-h",
        `${height}px`,
      );
    }
  }).observe(bar);
}

let contextNow: ContextUsage | null = null;
let contextRateLimits: CodexRateLimits | null = null;

function updateChatStatus(): void {
  const facts = sessionFacts(chat.harness, chat.entries);
  const model = facts.model || chat.model || "server default";
  const effort = facts.effort || chat.effort;
  const cwd = facts.cwd || chat.cwd;
  const parts = [model, effort, cwd].filter(Boolean);
  updateContextIndicator(contextUsage(facts.tokens, model), facts.rateLimits);
  setChatStatus(chat.harness, parts.join(" · "));
}

function updateContextIndicator(
  usage: ContextUsage | null,
  rateLimits: CodexRateLimits | null,
): void {
  contextNow = usage;
  contextRateLimits = rateLimits;
  const pill = $("context-pill");
  pill.classList.remove("low", "mid", "high");
  if (!usage) {
    show(pill, false);
    if (!$("modal-context").hidden) show($("modal-context"), false);
    return;
  }
  if (usage.percent === null) {
    pill.textContent = `${formatTokens(usage.used)} tokens`;
    pill.title = "Context usage — the model's window is unknown";
  } else {
    pill.textContent = formatPercent(usage.percent);
    pill.classList.add(contextLevel(usage.percent));
    pill.title = `${formatPercent(usage.percent)} of the context window used`;
  }
  show(pill, true);
  // A turn in flight moves these numbers on every poll, so an open popup is
  // kept current rather than freezing at what it said when it was opened.
  if (!$("modal-context").hidden) renderContextModal(usage);
}

function renderContextModal(usage: ContextUsage): void {
  const headline = $("ctx-headline");
  const fill = $("ctx-meter-fill");
  headline.classList.remove("low", "mid", "high");
  fill.classList.remove("low", "mid", "high");

  if (usage.percent === null) {
    headline.textContent = `${formatTokens(usage.used)} tokens`;
    fill.style.width = "0%";
  } else {
    const level = contextLevel(usage.percent);
    headline.textContent = `${formatPercent(usage.percent)} used`;
    headline.classList.add(level);
    fill.classList.add(level);
    // The bar is capped even though the number is not: past 100% there is no
    // more bar to fill, and the percentage above it already says so.
    fill.style.width = `${Math.min(usage.percent, 100)}%`;
  }

  $("ctx-used").textContent = `${formatTokens(usage.used)} tokens`;
  $("ctx-left").textContent = usage.window
    ? `${formatTokens(Math.max(usage.window - usage.used, 0))} tokens`
    : "unknown";
  $("ctx-max").textContent = usage.window
    ? `${formatTokens(usage.window)} tokens`
    : "not reported";
  $("ctx-note").textContent = usage.window
    ? usage.assumed
      ? `${harnessById(chat.harness).agentName} does not record a context window,` +
        " so this is the published window for the model the session is running." +
        " The tokens are what the last request actually used."
      : "Reported by the session itself, for the last request it made."
    : `${harnessById(chat.harness).agentName} records no context window and this` +
      " build does not know one for this model, so only the tokens the last" +
      " request used can be shown.";
  renderTokenBreakdowns(usage);
  renderCodexRateLimits(contextRateLimits);
  renderSessionFile();
}

function renderSessionFile(): void {
  const rows: Array<[string, string]> = [];
  if (chat.rolloutPath && chat.file.lines > 0) {
    rows.push(["Size", formatBytes(chat.file.bytes)]);
    rows.push(["Lines", formatTokens(chat.file.lines)]);
  }
  fillKv($("ctx-file"), $("ctx-file-list"), rows);
  // Only opencode needs a note: its sessions live in SQLite, so the file
  // measured is the JSONL this app rendered out of the database.
  const note = $("ctx-file-note");
  note.textContent =
    "opencode keeps its sessions in a SQLite database, so this is the history" +
    " this app rendered out of it rather than a file opencode wrote. A running" +
    " turn's events arrive on their own stream and are not counted here.";
  show(note, chat.harness === "opencode");
}

function fillKv(
  section: HTMLElement,
  list: HTMLElement,
  rows: Array<[string, string]>,
): void {
  list.replaceChildren();
  for (const [label, value] of rows) {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    list.append(term, description);
  }
  show(section, rows.length > 0);
}

function breakdownRows(
  tokens: TokenBreakdown,
  cost: CostFigure | null,
  withTotal: boolean,
): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const add = (label: string, count: number, note = "") => {
    if (count > 0) rows.push([label, `${formatTokens(count)} tokens${note}`]);
  };
  add("Input", tokens.input);
  add("Cached input", tokens.cacheRead);
  add("Cache write", tokens.cacheWrite);
  add(
    "Output",
    tokens.output,
    tokens.reasoning > 0
      ? ` · ${formatTokens(tokens.reasoning)} reasoning`
      : "",
  );
  if (withTotal && tokens.total > 0) {
    rows.push(["Total", `${formatTokens(tokens.total)} tokens`]);
  }
  if (cost) {
    const dollars = formatCost(cost.dollars);
    rows.push(["Cost", cost.estimated ? `${dollars} est.` : dollars]);
  }
  return rows;
}

function renderTokenBreakdowns(usage: ContextUsage): void {
  fillKv(
    $("ctx-request"),
    $("ctx-request-list"),
    breakdownRows(usage.last, usage.lastCost, false),
  );
  // One request in, the two sections are the same numbers under two headings:
  // the total only earns its section once it holds more than the request.
  const worthTotalling = usage.session.total > usage.last.total;
  fillKv(
    $("ctx-session"),
    $("ctx-session-list"),
    worthTotalling ? breakdownRows(usage.session, usage.sessionCost, true) : [],
  );

  const note = $("ctx-cost-note");
  const claudeUsage = $("ctx-claude-usage-note");
  const cost = usage.sessionCost;
  if (!cost) {
    show(note, false);
    show(claudeUsage, false);
    return;
  }
  note.textContent = cost.estimated
    ? `${harnessById(chat.harness).agentName} records no cost, so this is the` +
      " published API price for the tokens above — not a bill, and not what a" +
      " subscription charges."
    : `Priced by ${harnessById(chat.harness).agentName} itself, request by request.`;
  show(note, true);
  show(claudeUsage, chat.harness === "claude" && cost.estimated);
}

function rateLimitLabel(
  window: CodexRateLimitWindow,
  fallback: string,
): string {
  const minutes = window.windowMinutes;
  if (minutes === 300) return "5-hour limit";
  if (minutes === 10080) return "Weekly limit";
  if (minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  if (minutes > 0) return `${minutes}-minute limit`;
  return fallback;
}

function rateLimitValue(window: CodexRateLimitWindow): string {
  const used = `${formatPercent(Math.max(window.usedPercent, 0))} used`;
  if (window.resetsAt === null) return used;
  const reset = new Date(window.resetsAt * 1000);
  if (Number.isNaN(reset.getTime())) return used;
  const when = reset.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${used} · resets ${when}`;
}

function renderCodexRateLimits(limits: CodexRateLimits | null): void {
  const section = $("ctx-codex-limits");
  const list = $("ctx-codex-limits-list");
  const isCodex = chat.harness === "codex";
  const draw = (rows: Array<[string, string]>): void => {
    fillKv(section, list, rows);
    show($("ctx-codex-limits-note"), rows.length > 0);
    show($("ctx-codex-usage-note"), isCodex);
    show(section, rows.length > 0 || isCodex);
  };
  if (!limits) {
    draw([]);
    return;
  }

  const rows: Array<[string, string]> = [];
  if (limits.planType) {
    const plan = limits.planType
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
    rows.push(["Plan", plan]);
  }
  if (limits.primary) {
    rows.push([
      rateLimitLabel(limits.primary, "Primary limit"),
      rateLimitValue(limits.primary),
    ]);
  }
  if (limits.secondary) {
    rows.push([
      rateLimitLabel(limits.secondary, "Secondary limit"),
      rateLimitValue(limits.secondary),
    ]);
  }
  draw(rows);
}

function openContextModal(): void {
  if (!contextNow) return;
  renderContextModal(contextNow);
  show($("modal-context"), true);
}

interface LocalEcho {
  text: string;
  rawText: string;
  seen: Set<string>;

  all: Set<string>;
  delivery: Delivery;
}

const localEchoes = new Map<string, LocalEcho>();
let echoSeq = 0;
let newSessionNotice: HTMLElement | null = null;

const rendered = new Map<string, string>();

const rolloutUserIds = new Set<string>();

const seenCategories = new Set<string>();

function applyRollout(): void {
  const items = renderSession(chat.harness, chat.entries, "s");
  // Ticks decided by position: anything the server wrote after a prompt is
  // its response, so the ticks go green. A prompt with nothing after it is
  // merely confirmed.
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as { type: string; delivery?: Delivery };
    if (item.type !== "userMessage") continue;
    item.delivery = i < items.length - 1 ? "answered" : "confirmed";
  }
  for (const item of items) {
    // Collected for every item, not only the changed ones: the set has to
    // describe the whole conversation.
    for (const category of categoriesOf(chat.harness, item as ThreadItem)) {
      seenCategories.add(category);
    }
    const key = JSON.stringify(item);
    if (rendered.get(item.id) === key) continue;
    rendered.set(item.id, key);
    transcript.upsert(item as ThreadItem);
  }
  // One arrival retires one echo: two identical prompts, exactly what Resend
  // produces, must leave two bubbles.
  const arrivals = items.filter((i) => i.type === "userMessage");
  if (localEchoes.size) {
    const claimed = new Set<string>();
    for (const [id, echo] of [...localEchoes]) {
      const match = arrivals.find(
        (a) =>
          !echo.seen.has(a.id) &&
          !claimed.has(a.id) &&
          normalise(textOf(a as ThreadItem)) === echo.text,
      );
      if (!match) continue;
      claimed.add(match.id);
      transcript.remove(id);
      localEchoes.delete(id);
    }
    // An echo the file has not confirmed can still be *answered*: any node
    // not on screen when it was sent proves the prompt landed. opencode lives
    // here for the whole turn.
    for (const [id, echo] of localEchoes) {
      if (echo.delivery === "answered") continue;
      if (!items.some((item) => !echo.all.has(item.id))) continue;
      echo.delivery = "answered";
      transcript.upsert({
        type: "userMessage",
        id,
        content: [{ type: "text", text: echo.rawText }],
        delivery: "answered",
      } as ThreadItem);
    }
  }
  for (const a of arrivals) rolloutUserIds.add(a.id);
  updateChatStatus();
}

function textOf(item: ThreadItem): string {
  const content = (item as { content?: Array<{ text?: string }> }).content;
  if (Array.isArray(content))
    return content.map((c) => c?.text ?? "").join("\n");
  return String((item as { text?: string }).text ?? "");
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

function setHarness(harness: Harness): void {
  const info = harnessById(harness);
  chat.harness = info.id;
  transcript.setAgentName(info.agentName);
  $<HTMLTextAreaElement>("composer-input").placeholder =
    `Message ${info.agentName}…`;
  // The filter set is named after what this CLI writes, so it follows the
  // harness rather than being applied once at startup.
  applyTranscriptFilters();
}

function resetChat(): void {
  chatGeneration += 1;
  composerSendSeq += 1;
  $<HTMLTextAreaElement>("composer-input").disabled = false;
  chat.threadId = null;
  chat.rolloutPath = null;
  chat.entries = [];
  chat.cursor = 1;
  chat.file = { bytes: 0, lines: 0 };
  // Whatever opens the next session sets its own cwd; a leftover one would
  // have the chat screen claim a workspace after the settings were cleared.
  chat.cwd = "";
  chat.turnKey = null;
  chat.title = null;
  chat.label = null;
  rendered.clear();
  localEchoes.clear();
  newSessionNotice = null;
  rolloutUserIds.clear();
  // The per-type checkboxes describe the open chat, so they go with it. The
  // *hidden* set is app-level and deliberately survives.
  seenCategories.clear();
  transcript.clear();
  // Or the previous session's percentage would describe a conversation no
  // longer on screen.
  updateContextIndicator(null, null);
}

function adoptAiTitle(entries: SessionEntry[]): void {
  if (chat.harness !== "claude") return;
  for (const entry of entries) {
    if (String(entry.type) !== "ai-title") continue;
    const title = typeof entry.aiTitle === "string" ? entry.aiTitle.trim() : "";
    if (!title) continue;
    chat.title = title;
    const row = sessions.find(isOpenSession);
    if (row) row.title = title;
    renderChatSessionPill();
  }
}

// The picker reads a pi name out of the tail of the file it polls; the open
// chat has the whole session in hand, so it can say for certain.
function adoptPiName(entries: SessionEntry[]): void {
  if (chat.harness !== "pi") return;
  const name = piSessionName(entries);
  if (!name || name === chat.title) return;
  chat.title = name;
  const row = sessions.find(isOpenSession);
  if (row) row.title = name;
  renderChatSessionPill();
}

const wholeLines = (text: string): string => {
  const cut = text.lastIndexOf("\n");
  return cut < 0 ? "" : text.slice(0, cut + 1);
};

async function readWholeRollout(
  path: string,
  harness: Harness,
): Promise<RolloutSlice> {
  let lines = "";
  let lineCount = 0;
  for (;;) {
    const slice = await api.readRollout(path, 1 + lineCount, harness);
    lineCount += slice.lineCount;
    if (!slice.truncated) {
      // The final page keeps its unterminated tail: it is a line a live turn
      // is still writing, and the parser already knows to leave it uncounted.
      lines += slice.lines;
      return { lines, lineCount, truncated: false };
    }
    if (slice.lineCount === 0) {
      throw new Error(
        "This session has a single line larger than the app will read (4 MB), " +
          "so it cannot be shown here.",
      );
    }
    lines += wholeLines(slice.lines);
  }
}

async function openSession(session: SessionSummary): Promise<void> {
  const generation = ++chatGeneration;
  overlay("Opening session…");
  try {
    const slice = await readWholeRollout(session.path, session.harness);
    if (chatGeneration !== generation) return;
    resetChat();
    // The harness comes from the session, never from the last dialog: a codex
    // rollout resumed with `claude -p` would fork a new session at best.
    setHarness(session.harness);
    chat.threadId = session.id;
    chat.rolloutPath = session.path;
    chat.cwd = session.cwd;
    chat.title = session.title;
    chat.label = session.label;
    chat.entries = parseSessionLines(slice.lines);
    chat.file = { bytes: wholeLineBytes(slice.lines), lines: slice.lineCount };
    chat.cursor =
      session.harness === "opencode" && session.turnKey
        ? 1
        : 1 + slice.lineCount;
    chat.turnKey = session.turnKey;
    adoptAiTitle(chat.entries);
    adoptPiName(chat.entries);
    const facts = sessionFacts(chat.harness, chat.entries);
    chat.model = facts.model;
    chat.effort = facts.effort;
    applyRollout();
    // A turn that failed while nobody was watching says so at the foot of the
    // transcript. Its stderr stays on the server, because fetching it would
    // cost a round trip on every open.
    if (session.turnState === "failed" && session.turnExitCode) {
      // `turnExitCode` is null for a turn that recorded none and 0 never
      // reaches a failed row, so a truthy code is exactly "non-zero".
      addFinishedTurnFailure(session.harness, session.turnExitCode);
    }
    renderChatSessionPill();
    setTurnActive(Boolean(session.turnKey));
    goto("chat");
    restoreComposerDraft();
    consumePendingShare();
    transcript.scrollToBottom(true);
    overlay(null);
    // Opening a session is reading it; `markSessionRead` declines one whose
    // turn is still running.
    markSessionRead(session.id);
    consumePendingForward();
    if (session.turnKey) void followTurn(session.turnKey, chatGeneration);
  } catch (err) {
    if (chatGeneration !== generation) return;
    overlay(null);
    goto("sessions");
    showError("sessions-error", `Could not open session ${session.id}`, err);
  }
}

// Rust posts the notification, because Android pauses this WebView's JavaScript
// with the activity. The frontend only names each turn it follows through
// `watchTurn` and asks for the notification permission, which a foreground app
// alone can do. Rust retires a watch when a poll sees the turn end, never on
// leaving the chat.

let notifyPermission: Promise<boolean> | null = null;

function ensureNotifyPermission(): Promise<boolean> {
  notifyPermission ??= (async () => {
    try {
      if (await isPermissionGranted()) return true;
      return (await requestPermission()) === "granted";
    } catch (err) {
      void api.logClient("ui", `notification permission check failed: ${err}`);
      return false;
    }
  })();
  return notifyPermission;
}

const POLL_INTERVAL_MS = 900;
const POLL_FAILURES_ALLOWED = 20;
const STOPPED_EXIT_CODE = 130;

function turnFailureReason(harness: Harness): string {
  const permissionHint =
    harness === "claude"
      ? "check the permission mode, or the server's own settings.json."
      : harness === "opencode"
        ? "try Auto-approve, or check the server's opencode.json — opencode " +
          "also puts its error in the transcript above."
        : harness === "pi"
          ? "pi never asks for approvals, so this is usually a provider " +
            "problem — a model the server has no credentials for, or a pi " +
            "install its node version cannot run."
          : "set approval_policy in the server's config.toml.";
  return (
    `A turn run this way has nobody to ask for an approval, so a tool call ` +
    `that would prompt is refused instead — ${permissionHint}`
  );
}

function addFinishedTurnFailure(harness: Harness, exitCode: number): void {
  const info = harnessById(harness);
  if (exitCode === STOPPED_EXIT_CODE) {
    transcript.addSystem(`${info.agentName} was stopped before it finished.`);
    return;
  }
  transcript.addError(
    `${info.agentName} exited with status ${exitCode}`,
    `That turn had already finished when this session was opened, so what it ` +
      `wrote to stderr stayed on the server. ${turnFailureReason(harness)}`,
  );
}

async function followTurn(
  key: string,
  generation = chatGeneration,
): Promise<void> {
  // Fire-and-forget: the memoised promise makes every follow after the first
  // free, and the answer arrives before the turn can finish.
  void ensureNotifyPermission();
  // Hand Rust the watch while still in the foreground, the one time its
  // foreground service may start. Awaiting makes registration happen before
  // the first poll can observe the end and retire it.
  try {
    await api.watchTurn(key);
  } catch (err) {
    // Foreground polling remains useful even when Android refuses its native
    // handoff. Record the degraded state rather than losing the remote turn.
    void api.logClient("watch", `background monitoring unavailable: ${err}`);
  }
  // A follow that ends without seeing the turn end deliberately leaves the
  // native watch registered: the turn is still running on the server, and the
  // watch is what turns its finish into a notification. Rust retires it when
  // any poll sees the turn end.
  let failures = 0;
  for (;;) {
    if (chatGeneration !== generation || chat.turnKey !== key) return;

    let poll: TurnPoll;
    try {
      poll = await api.pollTurn(key, chat.cursor);
      if (chatGeneration !== generation || chat.turnKey !== key) return;
      failures = 0;
    } catch (err) {
      if (chatGeneration !== generation || chat.turnKey !== key) return;
      failures += 1;
      void api.logClient("ui", `poll ${failures} failed: ${err}`);
      if (failures >= POLL_FAILURES_ALLOWED) {
        setTurnActive(false);
        transcript.addError(
          "Lost track of the turn",
          `The connection kept failing, so the app stopped following this turn. ` +
            `It is probably still running on the server — reopen the session to ` +
            `see where it got to.\n\n${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      setTurnActive(true, `Reconnecting… (${failures})`);
      await ensureConnected();
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (poll.threadId && poll.threadId !== chat.threadId) {
      chat.threadId = poll.threadId;
      renderChatSessionPill();
    }
    if (poll.rolloutPath) chat.rolloutPath = poll.rolloutPath;
    if (poll.lineCount > 0) {
      const fresh = parseSessionLines(poll.lines);
      chat.entries.push(...fresh);
      // What was just read is more of the session file for the three harnesses
      // whose live feed *is* that file. opencode's is the turn's own event
      // stream, so counting it would report a size for a file nothing wrote.
      if (chat.harness !== "opencode") {
        chat.file.bytes += wholeLineBytes(poll.lines);
        chat.file.lines += poll.lineCount;
      }
      chat.cursor += poll.lineCount;
      adoptAiTitle(fresh);
      adoptPiName(fresh);
      applyRollout();
      setTurnActive(true);
    }

    if (poll.truncated && poll.lineCount === 0) {
      // One feed line bigger than the server's 4 MB page: no poll can ever
      // advance past it, so stop following rather than spinning silently. The
      // turn itself is unaffected, it keeps running on the server.
      setTurnActive(false);
      transcript.addError(
        "Lost track of the turn",
        "The session file grew a single line larger than the app will read " +
          "(4 MB), so this turn cannot be followed further. It is still " +
          "running on the server.",
      );
      return;
    }

    if (!poll.running) {
      setTurnActive(false);
      chat.turnKey = null;
      // Whose turn this was, before anything below can await and let the user
      // open something else in the meantime.
      const finished = chat.threadId;
      const info = harnessById(chat.harness);
      if (poll.exitCode === null) {
        transcript.addError(
          `${info.agentName} ended without an exit status`,
          poll.stderr ||
            "The remote supervisor stopped without recording whether the turn succeeded. " +
              "Its output has been kept, but Pablo cannot report this turn as successful.",
        );
      } else if (poll.exitCode !== 0) {
        transcript.addError(
          `${info.agentName} exited with status ${poll.exitCode}`,
          poll.stderr ||
            `Nothing was written to stderr. ${turnFailureReason(chat.harness)}`,
        );
      }
      // The picker's preview, timestamps and turn status are now out of date.
      await refreshSessions();
      // A turn watched to its end has been read; one that finished while the
      // reader was elsewhere keeps its unread row. The id is checked as well
      // as the screen for a session switched away from mid-turn.
      if (
        chatGeneration === generation &&
        chat.threadId === finished &&
        isScreen("chat")
      ) {
        markSessionRead(finished);
      }
      if (pendingForwardCommitted) consumePendingForward();
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function sendPrompt(text: string): Promise<boolean> {
  if (chat.turnActive) return false;
  if (!chat.cwd) {
    transcript.addError(
      "No workspace",
      "Start a new chat, or open an existing session, before sending anything.",
    );
    return false;
  }

  const echoId = `echo-${echoSeq++}`;
  localEchoes.set(echoId, {
    text: normalise(text),
    rawText: text,
    seen: new Set(rolloutUserIds),
    // `rendered` holds every rollout node drawn so far, so its keys are the
    // "before" snapshot the response detector compares against.
    all: new Set(rendered.keys()),
    delivery: "pending",
  });
  // No ticks yet: the bubble exists, nothing has been sent.
  transcript.upsert({
    type: "userMessage",
    id: echoId,
    content: [{ type: "text", text }],
    delivery: "pending",
  } as ThreadItem);
  transcript.scrollToBottom(true);

  const generation = chatGeneration;
  const newSession = chat.threadId === null;
  const request = {
    prompt: text,
    harness: chat.harness,
    threadId: chat.threadId ?? "",
    cwd: chat.cwd,
    model: chat.model,
    effort: chat.effort,
    permissionMode: chat.permissionMode,
  };
  setTurnActive(true, `Starting ${harnessById(chat.harness).command}…`);
  try {
    const started = await api.startTurn(request);
    if (chatGeneration !== generation) {
      void refreshSessions();
      return true;
    }
    chat.turnKey = started.key;
    if (newSession) {
      newSessionNotice?.remove();
      newSessionNotice = null;
    }
    // One grey tick: the harness command is running on the server. Guarded on
    // still being `pending`, a poll can already have marked the echo answered,
    // and this must not walk that back. The later states live in
    // `applyRollout`: two grey when the file confirms the prompt, two green
    // when anything follows it.
    const echo = localEchoes.get(echoId);
    if (echo && echo.delivery === "pending") {
      echo.delivery = "sent";
      transcript.upsert({
        type: "userMessage",
        id: echoId,
        content: [{ type: "text", text }],
        delivery: "sent",
      } as ThreadItem);
    }
    // opencode's live feed is the turn's *own* event stream, a fresh file per
    // turn, not the session file the history came from, so its cursor starts
    // over here. The file-based harnesses keep counting the one session file.
    if (chat.harness === "opencode") chat.cursor = 1;
    void api.logClient("ui", `turn ${started.key} hosted by ${started.host}`);
    setTurnActive(true);
    void followTurn(started.key, generation);
    return true;
  } catch (err) {
    if (chatGeneration !== generation) return false;
    setTurnActive(false);
    transcript.remove(echoId);
    localEchoes.delete(echoId);
    transcript.addError(
      "Failed to start the turn",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

function resendPrompt(text: string): void {
  const prompt = text.trim();
  if (!prompt) return;
  if (chat.turnActive) {
    toast("Wait for this turn to finish before resending");
    return;
  }
  void sendPrompt(prompt);
}

function forwardPrompt(text: string, target: "new" | "existing"): void {
  const prompt = text.trim();
  if (!prompt) return;
  pendingForwardPrompt = prompt;
  pendingForwardToComposer = target === "new";
  pendingForwardCommitted = false;
  if (target === "new") {
    void openNewChatModal(true);
    return;
  }
  renderShareNotice();
  openSessionsView();
}

function rewindActionFor(
  item: ThreadItem,
  text: string,
): { label: string; run: () => void; disabled?: boolean } | null {
  // Rewinding to the first prompt would leave nothing behind, so the action
  // starts at the second one.
  const [firstUserId] = rolloutUserIds;
  if (
    !firstUserId ||
    firstUserId === String((item as { id?: string }).id ?? "")
  ) {
    return null;
  }
  const reason = harnessById(chat.harness).cannotRewindReason;
  if (reason) {
    return {
      label: `Rewind chat to here — ${reason}`,
      run: () => {},
      disabled: true,
    };
  }
  const positional = String((item as { id?: string }).id ?? "").match(
    /^s-(\d+)-\d+$/,
  );
  if (!positional || !chat.rolloutPath) return null;
  if (chat.turnActive) {
    return {
      label: "Rewind chat to here — wait for the turn to finish",
      run: () => {},
      disabled: true,
    };
  }
  const keepLines = Number(positional[1]);
  return {
    label: "Rewind chat to here",
    run: () => void rewindChat(keepLines, text),
  };
}

async function rewindChat(keepLines: number, prompt: string): Promise<void> {
  if (chat.turnActive) {
    toast("Wait for this turn to finish before rewinding");
    return;
  }
  // The cut is by line number, so the lines read and the entries rendered must
  // agree, they drift if a line ever failed to parse, and a cut computed from
  // a drifted index would land on somebody else's line.
  if (!chat.rolloutPath || chat.entries.length !== chat.cursor - 1) {
    toast("The session is out of step — reopen the chat and try again");
    return;
  }
  const expectedLines = chat.entries.length;
  const ok = await askConfirm(
    "Rewind the chat to here?",
    "The conversation is cut back to just before this message, which returns" +
      " to the composer to edit and send again. Everything after it is removed" +
      " from the session on the server. Files the agents changed are not" +
      " touched.",
    "Rewind",
  );
  if (!ok) return;
  overlay("Rewinding chat…");
  try {
    await api.rewindSession(
      chat.rolloutPath,
      chat.harness,
      keepLines,
      expectedLines,
      chat.threadId ?? "",
    );
    await reloadChat();
    overlay(null);
    prefillComposer(prompt);
    $<HTMLTextAreaElement>("composer-input").focus();
  } catch (err) {
    overlay(null);
    transcript.addError(
      "Could not rewind the chat",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function restartActionFor(
  item: ThreadItem,
  text: string,
): {
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
} | null {
  const [firstUserId] = rolloutUserIds;
  if (
    !firstUserId ||
    firstUserId !== String((item as { id?: string }).id ?? "") ||
    !text.trim() ||
    !chat.rolloutPath ||
    !chat.threadId
  ) {
    return null;
  }
  const reason = harnessById(chat.harness).cannotDeleteReason;
  if (reason) {
    return {
      label: `Restart this chat — ${reason}`,
      run: () => {},
      disabled: true,
      danger: true,
    };
  }
  if (chat.turnActive) {
    return {
      label: "Restart this chat — wait for the turn to finish",
      run: () => {},
      disabled: true,
      danger: true,
    };
  }
  return {
    label: "Restart this chat",
    danger: true,
    run: () => void restartChat(text),
  };
}

async function restartChat(prompt: string): Promise<void> {
  if (chat.turnActive) {
    toast("Wait for this turn to finish before restarting");
    return;
  }
  const { rolloutPath: path, harness, threadId: id } = chat;
  if (!path || !id) return;
  // A session holding only this prompt loses nothing, so it is not asked.
  if (rolloutUserIds.size >= 2) {
    const ok = await askConfirm(
      "Restart this chat?",
      "Your current session will be lost. Are you sure you want to restart this chat?",
      "Restart",
    );
    if (!ok) return;
  }
  if (!(await removeSessionFromServer({ path, harness, id }))) return;
  // Staged like a forward to the picker, so a cancelled dialog keeps the
  // prompt on offer there instead of losing it with the deleted session.
  forwardPrompt(prompt, "existing");
  void openNewChatModal();
}

async function reloadChat(): Promise<void> {
  const { harness, threadId, rolloutPath, cwd, permissionMode, title, label } =
    chat;
  if (!rolloutPath) return;
  const slice = await readWholeRollout(rolloutPath, harness);
  resetChat();
  setHarness(harness);
  chat.threadId = threadId;
  chat.rolloutPath = rolloutPath;
  chat.cwd = cwd;
  chat.permissionMode = permissionMode;
  chat.title = title;
  // The label is this app's, not the session's: re-reading the file cannot
  // recover one, so it has to survive the reset.
  chat.label = label;
  chat.entries = parseSessionLines(slice.lines);
  chat.file = { bytes: wholeLineBytes(slice.lines), lines: slice.lineCount };
  chat.cursor = 1 + slice.lineCount;
  adoptAiTitle(chat.entries);
  adoptPiName(chat.entries);
  const facts = sessionFacts(chat.harness, chat.entries);
  chat.model = facts.model;
  chat.effort = facts.effort;
  applyRollout();
  renderChatSessionPill();
  setTurnActive(false);
  transcript.scrollToBottom(true);
}

function openTappedPath(rawPath: string, line: number | null): void {
  const path = resolveRemotePath(rawPath);
  if (!path) return;
  if (fileExtensionOf(path) === null) {
    openPathInEditor(path, line);
    return;
  }
  openFileChooser(path, line);
}

function fileExtensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1);
  if (!/^[A-Za-z0-9]{1,12}$/.test(ext) || !/[A-Za-z]/.test(ext)) return null;
  return ext.toLowerCase();
}

function resolveRemotePath(rawPath: string): string | null {
  if (!settings?.host) {
    toast("Connect to a server first");
    return null;
  }
  const path = rawPath.startsWith("/") ? rawPath : joinPosix(chat.cwd, rawPath);
  if (!path.startsWith("/")) {
    toast(`No workspace known for ${rawPath}`);
    return null;
  }
  return path;
}

function openPathInEditor(rawPath: string, line: number | null): void {
  const path = resolveRemotePath(rawPath);
  if (!path || !settings) return;

  const auth = settings.username
    ? `${encodeURIComponent(settings.username)}@`
    : "";
  const host = settings.host.includes(":")
    ? `[${settings.host}]`
    : settings.host;
  const port = settings.port === 22 ? "" : `:${settings.port}`;
  // Each segment is encoded on its own so the separators survive; a `#` or `?`
  // in a filename would otherwise cut the path short at the other end.
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const url = `ssh://${auth}${host}${port}${encoded}`;

  const label = line === null ? path : `${path}:${line}`;
  const problem = openExternalUrl(url);
  if (problem) {
    toast(problem);
    return;
  }
  void api.logClient("ui", `opened ${label} in an external editor`);
}

function joinPosix(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, "");
  if (!base) return "";
  return `${base}/${name.replace(/^\.\//, "")}`;
}

function openExternalUrl(url: string): string | null {
  const bridge = (
    window as Window & { PabloOpen?: { open(u: string): string } }
  ).PabloOpen;
  if (bridge) {
    try {
      return bridge.open(url) || null;
    } catch (err) {
      return `Could not open the link: ${String(err)}`;
    }
  }
  void openUrl(url).catch((err) =>
    toast(`Could not open the link: ${String(err)}`),
  );
  return null;
}

// The copy is cache, not storage: the next download clears what the last one
// left. The bytes never enter the webview, because Rust streams them straight
// to disk, so this side handles only the dialog, progress and handover.

let openFileChoice: { path: string; line: number | null } | null = null;
let downloadRunning = false;
let downloadTimer: number | undefined;

function openFileChooser(path: string, line: number | null): void {
  openFileChoice = { path, line };
  const fileName = path.slice(path.lastIndexOf("/") + 1) || path;
  $("openfile-path").textContent =
    line === null ? fileName : `${fileName}:${line}`;
  show($("openfile-error"), false);
  show($("openfile-progress"), false);
  // A fresh open shows the choices and size; transfers hide both while active.
  setDownloadUi(false);
  setFileChoicesEnabled(true);
  $("openfile-cancel").textContent = "Cancel";
  show($("modal-openfile"), true);
  void askFileSize(path);
}

async function askFileSize(path: string): Promise<void> {
  const size = $("openfile-size");
  const text = $("openfile-size-text");
  size.classList.remove("warn");
  show($("openfile-size-spinner"), true);
  text.textContent = "Checking the size…";

  const settle = (message: string, warn: boolean): void => {
    if (openFileChoice?.path !== path) return;
    show($("openfile-size-spinner"), false);
    text.textContent = message;
    size.classList.toggle("warn", warn);
  };

  try {
    const answer = await api.remoteFileSize(path);
    if (openFileChoice?.path !== path) return;
    if (answer.tooBig) {
      // Saying so now beats letting the transfer start and be refused by the
      // same check a second later, so the controls that cannot act say why.
      $<HTMLButtonElement>("openfile-download").disabled = true;
      $<HTMLButtonElement>("openfile-save").disabled = true;
      settle(`Size: ${formatBytes(answer.size)} — too large to download`, true);
      return;
    }
    settle(`Size: ${formatBytes(answer.size)}`, false);
  } catch (err) {
    // A size that could not be read says nothing about whether the file can
    // be fetched, so this never disables anything.
    void api.logClient("ui", `could not size ${path}: ${String(err)}`);
    settle("Size: unknown", false);
  }
}

function closeFileChooser(): void {
  if (downloadRunning) {
    void api.cancelDownload();
    void api.logClient("ui", "the download was cancelled");
  }
  stopDownloadPolling();
  openFileChoice = null;
  show($("modal-openfile"), false);
}

function setFileChoicesEnabled(enabled: boolean): void {
  $<HTMLButtonElement>("openfile-editor").disabled = !enabled;
  $<HTMLButtonElement>("openfile-download").disabled = !enabled;
  $<HTMLButtonElement>("openfile-save").disabled = !enabled;
}

function setDownloadUi(active: boolean): void {
  show($("openfile-choices"), !active);
  show($("openfile-size"), !active);
}

function showDownloadFailure(fallbackTitle: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const dropped = message.startsWith("The SSH connection dropped");
  showError(
    "openfile-error",
    dropped ? "Download failed" : fallbackTitle,
    dropped ? "The SSH connection dropped. Please try again." : err,
  );
}

async function downloadAndOpen(path: string): Promise<void> {
  setFileChoicesEnabled(false);
  show($("openfile-error"), false);
  downloadRunning = true;
  startDownloadPolling();
  try {
    const file = await api.downloadRemoteFile(path);
    downloadRunning = false;
    stopDownloadPolling();
    renderDownloadProgress({
      received: file.size,
      total: file.size,
      active: false,
    });
    const problem = openLocalFile(file.localPath);
    if (problem) {
      setDownloadUi(false);
      setFileChoicesEnabled(true);
      showError(
        "openfile-error",
        `Downloaded ${file.name}, but nothing opened it`,
        problem,
      );
      return;
    }
    void api.logClient(
      "ui",
      `downloaded ${path} (${file.size} bytes) and handed it over`,
    );
    openFileChoice = null;
    show($("modal-openfile"), false);
    toast(`Opening ${file.name}`);
  } catch (err) {
    downloadRunning = false;
    stopDownloadPolling();
    show($("openfile-progress"), false);
    setDownloadUi(false);
    setFileChoicesEnabled(true);
    showDownloadFailure(`Could not download ${path}`, err);
  }
}

async function downloadAndSave(path: string): Promise<void> {
  const bridge = window.PabloOpen;
  if (bridge?.saveFile) {
    await downloadAndSaveViaActivity(path, bridge);
    return;
  }

  const dest = await askSaveDestination(path);
  if (!dest) return; // Cancelled, or said why, the choices are still live.

  show($("openfile-error"), false);
  downloadRunning = true;
  startDownloadPolling();
  try {
    const file = await api.downloadRemoteFile(path);
    downloadRunning = false;
    stopDownloadPolling();
    renderDownloadProgress({
      received: file.size,
      total: file.size,
      active: false,
    });
    await api.saveDownload(file.localPath, dest);
    void api.logClient(
      "ui",
      `downloaded ${path} (${file.size} bytes) and saved it on this device`,
    );
    // `open_saved_file` takes no path: Rust opens the file it just wrote.
    if (await askToOpenSaved(file.name)) {
      try {
        await api.openSavedFile();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
    }
    toast(`Saved ${file.name}`);
    openFileChoice = null;
    show($("modal-openfile"), false);
  } catch (err) {
    downloadRunning = false;
    stopDownloadPolling();
    show($("openfile-progress"), false);
    setDownloadUi(false);
    setFileChoicesEnabled(true);
    showDownloadFailure(`Could not save ${path}`, err);
  }
}

async function askToOpenSaved(name: string): Promise<boolean> {
  try {
    return await askDialog(
      `${name} has been saved. Would you like to open it now?`,
      {
        title: "Saved",
        kind: "info",
        okLabel: "Open",
        cancelLabel: "Not now",
      },
    );
  } catch {
    return false;
  }
}

async function askSaveDestination(remotePath: string): Promise<string | null> {
  const name = remotePath.split("/").pop() || "download";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  try {
    return await saveDialog({
      defaultPath: name,
      title: `Save ${name}`,
      // A filter naming the extension is load-bearing on Windows: without one
      // the dialog drops the extension off the suggested name, and with one it
      // also puts the extension back on a bare name the user types.
      filters: ext
        ? [{ name: `${ext.toUpperCase()} file`, extensions: [ext] }]
        : undefined,
    });
  } catch (err) {
    showError("openfile-error", "Could not open the save dialog", err);
    return null;
  }
}

async function downloadAndSaveViaActivity(
  path: string,
  bridge: { saveFile(path: string, name: string): string },
): Promise<void> {
  setFileChoicesEnabled(false);
  show($("openfile-error"), false);
  downloadRunning = true;
  startDownloadPolling();
  try {
    const file = await api.downloadRemoteFile(path);
    downloadRunning = false;
    stopDownloadPolling();
    renderDownloadProgress({
      received: file.size,
      total: file.size,
      active: false,
    });
    const problem = bridge.saveFile(file.localPath, file.name) || null;
    if (problem) {
      setDownloadUi(false);
      setFileChoicesEnabled(true);
      showError(
        "openfile-error",
        `Downloaded ${file.name}, but could not save it`,
        problem,
      );
      return;
    }
    void api.logClient(
      "ui",
      `downloaded ${path} (${file.size} bytes) to save on this device`,
    );
    openFileChoice = null;
    show($("modal-openfile"), false);
  } catch (err) {
    downloadRunning = false;
    stopDownloadPolling();
    show($("openfile-progress"), false);
    setDownloadUi(false);
    setFileChoicesEnabled(true);
    showDownloadFailure(`Could not download ${path}`, err);
  }
}

function startDownloadPolling(): void {
  setDownloadUi(true);
  renderDownloadProgress({ received: 0, total: 0, active: true });
  window.clearInterval(downloadTimer);
  // Fast enough that the bar moves, slow enough to cost nothing next to the
  // transfer it describes.
  downloadTimer = window.setInterval(() => {
    if (!downloadRunning) return;
    void api
      .downloadProgress()
      .then((p) => {
        if (downloadRunning) renderDownloadProgress(p);
      })
      .catch(() => {
        /* a progress read that failed says nothing about the transfer */
      });
  }, 250);
}

function stopDownloadPolling(): void {
  window.clearInterval(downloadTimer);
  downloadTimer = undefined;
}

function renderDownloadProgress(p: DownloadProgress): void {
  show($("openfile-progress"), true);
  const fill = $("openfile-meter");
  const text = $("openfile-progress-text");
  if (p.total <= 0) {
    // The size arrives on the transfer's first line, so for one round trip
    // "how far" has no answer yet.
    fill.style.width = "0%";
    text.textContent = "Downloading — asking the server for the file…";
    return;
  }
  const pct = Math.min(100, Math.round((p.received / p.total) * 100));
  fill.style.width = `${pct}%`;
  text.textContent = `Downloading ${formatBytes(p.received)} of ${formatBytes(p.total)} · ${pct}%`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function openLocalFile(localPath: string): string | null {
  const bridge = window.PabloOpen;
  if (bridge?.openFile) {
    try {
      return bridge.openFile(localPath) || null;
    } catch (err) {
      return `Could not open the file: ${String(err)}`;
    }
  }
  void openPath(localPath).catch((err) =>
    toast(`Could not open the file: ${String(err)}`),
  );
  return null;
}

const imageCache = new Map<string, Promise<string | null>>();

const IMAGE_CACHE_MAX = 48;

function resolveTranscriptImage(
  path: string,
  itemId: string,
  fresh: boolean,
): Promise<string | null> {
  const session = chat.threadId ?? chat.rolloutPath ?? "unnamed";
  const key = `${session}\0${itemId}\0${path}`;
  if (fresh) imageCache.delete(key);
  let hit = imageCache.get(key);
  if (!hit) {
    hit = fetchRemoteImage(path);
    imageCache.set(key, hit);
    while (imageCache.size > IMAGE_CACHE_MAX) {
      // Maps iterate in insertion order, so the first key is the oldest.
      const oldest = imageCache.keys().next().value;
      if (oldest === undefined) break;
      imageCache.delete(oldest);
    }
  }
  return hit;
}

async function fetchRemoteImage(path: string): Promise<string | null> {
  try {
    const file = await api.readRemoteFile(path);
    const mime = sniffImageMime(file.base64, path);
    if (!mime) {
      void api.logClient("image", `${path} is not an image this app can draw`);
      return null;
    }
    return `data:${mime};base64,${file.base64}`;
  } catch (err) {
    void api.logClient("image", `could not read ${path}: ${String(err)}`);
    return null;
  }
}

function sniffImageMime(base64: string, path: string): string | null {
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("Qk")) return "image/bmp";
  // `<?xml` or `<svg`, base64-encoded.
  if (base64.startsWith("PD94bWwg") || base64.startsWith("PHN2Zw"))
    return "image/svg+xml";
  const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "svg") return "image/svg+xml";
  return null;
}

async function interruptTurn(): Promise<void> {
  const key = chat.turnKey;
  if (!key) return;
  setTurnActive(true, "Stopping…");
  try {
    await api.stopTurn(key);
    setTurnActive(false);
    transcript.addSystem("Turn stopped");
    showAlert("Session stopped", "The session was stopped successfully.");
  } catch (err) {
    setTurnActive(true);
    transcript.addError("Could not stop the turn", String(err));
  }
}

// MainActivity holds text shared from another app. The page pulls once at
// startup because a share can cold-start the app, and the activity calls
// `__pabloSharedText` when one arrives while it is running. The text only ever
// pre-fills the composer, and where it lands is the user's choice: a share puts
// the session picker in front with the text quoted on it, never the last chat.

declare global {
  interface Window {
    PabloShare?: { consume(): string | null };
    __pabloSharedText?: () => void;

    __pabloBack?: () => boolean;

    PabloOpen?: {
      open(url: string): string;
      openFile(path: string): string;
      saveFile(path: string, name: string): string;
    };

    PabloSystemBars?: {
      setScheme(scheme: string): void;
      insets?(): string;
    };
    __pabloInsets?: (insets: Partial<Record<InsetEdge, number>>) => void;

    __pabloOpenFailed?: (message: string) => void;
  }
}

// The launch happens after the bridge call has returned, so a failure arrives
// this way rather than as its result.
window.__pabloOpenFailed = (message: string) => toast(message);

let pendingSharedText: string | null = null;
let pendingForwardPrompt: string | null = null;
let pendingDraftPrompt: string | null = null;
let pendingDraftDefaults: NewChatDefaults | null = null;
let pendingDraftDeleteId: string | null = null;
let pendingForwardToComposer = false;
let pendingForwardCommitted = false;

// Unsent composer text, kept per session so a draft typed in one chat never
// shows in another. Memory only: closing the app discards drafts.
const composerDrafts = new Map<string, string>();

function composerDraftKey(): string {
  return chat.threadId ? `${chat.harness}:${chat.threadId}` : "new";
}

function syncComposerDraft(value: string): void {
  const key = composerDraftKey();
  if (value) composerDrafts.set(key, value);
  else composerDrafts.delete(key);
}

function restoreComposerDraft(): void {
  const input = $<HTMLTextAreaElement>("composer-input");
  input.value = composerDrafts.get(composerDraftKey()) ?? "";
  input.dispatchEvent(new Event("input"));
}

function prefillComposer(text: string): void {
  const input = $<HTMLTextAreaElement>("composer-input");
  input.value = input.value.trim()
    ? `${input.value.trimEnd()}\n\n${text}`
    : text;
  // Fire the input listener so the textarea grows to fit what arrived.
  input.dispatchEvent(new Event("input"));
}

// Counts composer submits. `resetChat` bumps it too, so a send still waiting
// on the server when the user switches chats leaves the new chat's box alone.
let composerSendSeq = 0;

// The prompt stays in the box, disabled, until the server has the turn: a send
// that fails leaves it there to fix or retry instead of in an error bubble.
async function sendFromComposer(text: string): Promise<void> {
  const input = $<HTMLTextAreaElement>("composer-input");
  const key = composerDraftKey();
  const refocus = document.activeElement === input && !softKeyboard();
  const seq = ++composerSendSeq;
  input.disabled = true;
  const started = await sendPrompt(text);
  if (started) composerDrafts.delete(key);
  if (seq !== composerSendSeq) return;
  input.disabled = false;
  if (started) {
    input.value = "";
    input.dispatchEvent(new Event("input"));
  }
  if (refocus) input.focus();
}

function renderShareNotice(): void {
  const notice = $("share-notice");
  const pending = pendingForwardPrompt ?? pendingSharedText;
  if (pending !== null) {
    const forwarding = pendingForwardPrompt !== null;
    $("share-notice-title").textContent = forwarding
      ? "↗ Prompt ready to send"
      : "📋 Shared text — where should it go?";
    $("share-notice-text").textContent = pending;
    $("share-notice-hint").textContent = forwarding
      ? "Tap a session to send it there, or + above to start a new chat with it."
      : "Tap a session to put it in that chat's prompt, or + above to start a new chat with it.";
  }
  show(notice, pending !== null);
}

function discardPendingShare(): void {
  const had = pendingSharedText !== null || pendingForwardPrompt !== null;
  pendingSharedText = null;
  pendingForwardPrompt = null;
  pendingForwardToComposer = false;
  pendingForwardCommitted = false;
  renderShareNotice();
  if (had) toast("Shared text discarded");
}

function consumePendingShare(): void {
  if (pendingSharedText === null) return;
  prefillComposer(pendingSharedText);
  pendingSharedText = null;
  renderShareNotice();
  toast("Shared text added to the prompt");
}

function consumePendingDraft(): void {
  if (pendingDraftPrompt === null) return;
  prefillComposer(pendingDraftPrompt);
  pendingDraftPrompt = null;
  toast("Draft added to the prompt");
  // Use & remove only spends the draft once a chat actually took it.
  if (pendingDraftDeleteId !== null) {
    const id = pendingDraftDeleteId;
    pendingDraftDeleteId = null;
    void api.deleteDraftPrompt(draftPromptsPath, id).then(
      () => toast("Draft deleted"),
      () => toast("Could not delete the draft from the server"),
    );
  }
}

function consumePendingForward(): void {
  if (pendingForwardPrompt === null) return;
  if (pendingForwardToComposer) {
    const prompt = pendingForwardPrompt;
    pendingForwardPrompt = null;
    pendingForwardToComposer = false;
    pendingForwardCommitted = false;
    renderShareNotice();
    prefillComposer(prompt);
    toast("Forwarded message added to the prompt");
    return;
  }
  if (chat.turnActive) {
    pendingForwardCommitted = true;
    toast("Prompt will send when this turn finishes");
    return;
  }
  const prompt = pendingForwardPrompt;
  pendingForwardPrompt = null;
  pendingForwardCommitted = false;
  renderShareNotice();
  void sendPrompt(prompt);
}

function handleSharedText(): void {
  const text = window.PabloShare?.consume() ?? null;
  if (!text) return;
  pendingSharedText = text;
  // Held, never delivered on arrival: being the last chat opened says nothing
  // about being the chat this text is for.
  renderShareNotice();
  // The connect form is the one screen not to leave: there is no session list
  // to choose from yet, and the connect flow lands on the picker by itself.
  if (isScreen("connect")) return;
  openSessionsView();
  // The banner sits above the first row, so a list scrolled halfway down would
  // hide the only sign that the share arrived.
  $("sessions-body").scrollTop = 0;
}

function selectedHarness(): Harness {
  const value = $<HTMLSelectElement>("nc-harness").value;
  return isHarness(value) ? value : DEFAULT_HARNESS;
}

let agentDefaults: Partial<Record<Harness, NewChatDefaults>> = {};
let clearForwardOnNewChatCancel = false;
type CatalogHarness = "claude" | "pi";
type CatalogState = "idle" | "loading" | "ready" | "failed";
const modelCatalogs: Partial<Record<CatalogHarness, ModelChoice[]>> = {};
const modelCatalogStates: Record<CatalogHarness, CatalogState> = {
  claude: "idle",
  pi: "idle",
};
let modelCatalogGeneration = 0;

function resetModelCatalogs(): void {
  modelCatalogGeneration += 1;
  delete modelCatalogs.claude;
  delete modelCatalogs.pi;
  modelCatalogStates.claude = "idle";
  modelCatalogStates.pi = "idle";
}

const hasModelCatalog = (harness: Harness): harness is CatalogHarness =>
  harness === "claude" || harness === "pi";
const modelsLoading = (harness: Harness) =>
  hasModelCatalog(harness) && modelCatalogStates[harness] === "loading";
const modelsFailed = (harness: Harness) =>
  hasModelCatalog(harness) && modelCatalogStates[harness] === "failed";
const modelsUnavailable = (harness: Harness) =>
  modelsLoading(harness) || modelsFailed(harness);
const choicesFor = (harness: Harness) =>
  modelsFor(harness, hasModelCatalog(harness) ? modelCatalogs[harness] : null);
const choiceById = (harness: Harness, id?: string | null) =>
  modelById(
    harness,
    id,
    hasModelCatalog(harness) ? modelCatalogs[harness] : null,
  );

function renderModelOptions(harness: Harness, selected?: string): void {
  const select = $<HTMLSelectElement>("nc-model");
  select.innerHTML = "";
  for (const m of choicesFor(harness)) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    select.appendChild(opt);
  }
  select.value = choiceById(harness, selected)?.id ?? "";
}

function renderEffortOptions(
  harness: Harness,
  modelId: string,
  selected?: string,
): void {
  const select = $<HTMLSelectElement>("nc-effort");
  const model = choiceById(harness, modelId);
  select.innerHTML = "";
  if (!model) return;

  // The server's own effort is a valid choice, and the only one that stays right
  // when this build's model list is older than the CLI on the server.
  const options = ["", ...model.efforts];
  for (const effort of options) {
    const opt = document.createElement("option");
    opt.value = effort;
    opt.textContent = effort
      ? effort.charAt(0).toUpperCase() + effort.slice(1)
      : "Server default";
    select.appendChild(opt);
  }
  select.value =
    selected && options.includes(selected) ? selected : model.defaultEffort;
}

function renderPermissionOptions(harness: Harness, selected?: string): void {
  const info = harnessById(harness);
  const row = $("nc-permission-row");
  show(row, info.permissionModes.length > 0);
  if (!info.permissionModes.length) return;

  const select = $<HTMLSelectElement>("nc-permission");
  select.innerHTML = "";
  for (const mode of info.permissionModes) {
    const opt = document.createElement("option");
    opt.value = mode.id;
    opt.textContent = mode.label;
    select.appendChild(opt);
  }
  const known = info.permissionModes.some((m) => m.id === selected);
  select.value = known ? (selected as string) : "";
}

function renderHarnessOptions(
  harness: Harness,
  defaults?: { model?: string; effort?: string; permissionMode?: string },
): void {
  const loading = modelsLoading(harness);
  const failed = modelsFailed(harness);
  const spinner = $("nc-model-loading");
  spinner.setAttribute(
    "aria-label",
    `Loading ${harnessById(harness).label} models`,
  );
  show(spinner, loading);
  $<HTMLButtonElement>("nc-create").disabled = loading || failed;
  $<HTMLButtonElement>("nc-favorite").disabled = loading || failed;
  if (loading) {
    const model = $<HTMLSelectElement>("nc-model");
    const effort = $<HTMLSelectElement>("nc-effort");
    model.innerHTML = `<option value="">Loading ${harnessById(harness).label} models…</option>`;
    effort.innerHTML = '<option value="">Waiting for model list…</option>';
    model.disabled = true;
    effort.disabled = true;
  } else if (failed) {
    const model = $<HTMLSelectElement>("nc-model");
    const effort = $<HTMLSelectElement>("nc-effort");
    model.innerHTML = "";
    effort.innerHTML = "";
    model.disabled = true;
    effort.disabled = true;
  } else {
    $<HTMLSelectElement>("nc-model").disabled = false;
    $<HTMLSelectElement>("nc-effort").disabled = false;
    renderModelOptions(harness, defaults?.model);
    renderEffortOptions(
      harness,
      $<HTMLSelectElement>("nc-model").value,
      defaults?.effort,
    );
  }
  renderPermissionOptions(harness, defaults?.permissionMode);
  renderFavoriteToggle();
  $("nc-harness-hint").textContent = `Each turn runs \`${
    harnessById(harness).command
  }\` on the server and is read back from ${harnessById(harness).sessionsLabel}.`;
}

function activateHarnessOptions(
  harness: Harness,
  defaults?: NewChatDefaults,
): void {
  let load = false;
  if (
    hasModelCatalog(harness) &&
    (modelCatalogStates[harness] === "idle" ||
      modelCatalogStates[harness] === "failed")
  ) {
    modelCatalogStates[harness] = "loading";
    hideError("newchat-error");
    load = true;
  }
  renderHarnessOptions(harness, defaults);
  if (load && hasModelCatalog(harness)) void loadModels(harness);
}

async function loadModels(harness: CatalogHarness): Promise<void> {
  const generation = modelCatalogGeneration;
  try {
    const loaded =
      harness === "claude"
        ? claudeModelChoices(await api.listClaudeModels())
        : piModelChoices(await api.listPiModels());
    if (generation !== modelCatalogGeneration) return;
    modelCatalogs[harness] = loaded;
    modelCatalogStates[harness] = "ready";
  } catch (err) {
    if (generation !== modelCatalogGeneration) return;
    delete modelCatalogs[harness];
    modelCatalogStates[harness] = "failed";
    if (!$("modal-newchat").hidden && selectedHarness() === harness) {
      showError(
        "newchat-error",
        `Could not load ${harnessById(harness).label} models`,
        err,
      );
    }
  }
  if ($("modal-newchat").hidden) return;
  renderDialogFavorites();
  if (selectedHarness() === harness) {
    renderHarnessOptions(harness, agentDefaults[harness]);
  } else {
    renderFavoriteToggle();
  }
}

function renderNewChatPending(): void {
  const forwarding = pendingForwardPrompt !== null;
  const draft = pendingDraftPrompt !== null;
  const pending =
    pendingForwardPrompt ?? pendingDraftPrompt ?? pendingSharedText;
  show($("nc-pending"), pending !== null);
  if (pending === null) return;
  $("nc-pending-label").textContent = forwarding
    ? pendingForwardToComposer
      ? "Will prefill the composer"
      : "Sent as the first message"
    : draft
      ? "Draft will prefill the composer"
      : "Waiting in the prompt";
  $("nc-pending-text").textContent = pending;
}

async function openNewChatModal(cancelForward = false): Promise<void> {
  clearForwardOnNewChatCancel = cancelForward;
  hideError("newchat-error");
  show($("modal-newchat"), true);
  $("nc-create").textContent =
    pendingForwardPrompt && !pendingForwardToComposer
      ? "Create & send"
      : "Create";
  renderNewChatPending();

  const persisted = await api.loadState();
  agentDefaults = persisted.agentDefaults;
  // A draft's frontmatter overlays the remembered defaults for its harness, so
  // pi's async model reload and harness switches re-render from it too.
  const draft = pendingDraftDefaults;
  pendingDraftDefaults = null;
  if (draft) agentDefaults = { ...agentDefaults, [draft.harness]: draft };

  // Only harnesses the host actually has: offering one whose binary is missing
  // would produce a turn that fails for a reason the dialog already knew.
  const offered = availableHarnesses();
  const harnessSelect = $<HTMLSelectElement>("nc-harness");
  harnessSelect.innerHTML = "";
  const sorted = [...offered].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true }),
  );
  for (const h of sorted) {
    const opt = document.createElement("option");
    opt.value = h.id;
    opt.textContent = h.label;
    harnessSelect.appendChild(opt);
  }
  const remembered = draft?.harness ?? persisted.lastHarness;
  harnessSelect.value =
    remembered && offered.some((h) => h.id === remembered)
      ? remembered
      : offered[0].id;
  // With one harness there is nothing to choose, so the row stays out of the way.
  show($("nc-harness-row"), offered.length > 1);

  const chosen = selectedHarness();
  activateHarnessOptions(chosen, agentDefaults[chosen]);
  $<HTMLInputElement>("nc-cwd").value =
    agentDefaults[chosen]?.cwd || settings?.defaultCwd || "";
  renderDialogFavorites();
  renderFavoriteToggle();
}

function closeNewChatModal(): void {
  show($("modal-newchat"), false);
  pendingDraftPrompt = null;
  pendingDraftDefaults = null;
  pendingDraftDeleteId = null;
  if (clearForwardOnNewChatCancel) {
    pendingForwardPrompt = null;
    pendingForwardToComposer = false;
    pendingForwardCommitted = false;
    renderShareNotice();
  }
  clearForwardOnNewChatCancel = false;
}

async function createNewChat(): Promise<void> {
  hideError("newchat-error");
  const harness = selectedHarness();
  if (modelsUnavailable(harness)) return;
  const model = $<HTMLSelectElement>("nc-model").value;
  const effort = $<HTMLSelectElement>("nc-effort").value;
  const permissionMode = harnessById(harness).permissionModes.length
    ? $<HTMLSelectElement>("nc-permission").value
    : "";
  const cwd = $<HTMLInputElement>("nc-cwd").value.trim();

  if (!cwd) {
    showError(
      "newchat-error",
      "Workspace path required",
      "Enter an absolute path on the server.",
    );
    return;
  }

  chatGeneration += 1;
  show($("modal-newchat"), false);
  clearForwardOnNewChatCancel = false;
  await api
    .saveNewChatDefaults({ harness, model, effort, cwd, permissionMode })
    .catch((err) => {
      void api.logClient("ui", `could not save new chat defaults: ${err}`);
      toast("Chat started, but its defaults were not saved");
    });

  enterNewChat(harness, model, effort, cwd, permissionMode);
  consumePendingShare();
  consumePendingForward();
  consumePendingDraft();
}

function enterNewChat(
  harness: Harness,
  model: string,
  effort: string,
  cwd: string,
  permissionMode: string,
): void {
  resetChat();
  setHarness(harness);
  chat.model = model;
  chat.effort = effort;
  chat.permissionMode = permissionMode;
  chat.cwd = cwd;
  setTurnActive(false);
  setChatStatus(
    harness,
    [modelLabelFor(harness, model), effort, cwd].filter(Boolean).join(" · "),
  );
  newSessionNotice = transcript.addSystem(
    "New session — it is created when you send the first message.",
  );
  renderChatSessionPill();
  goto("chat");
  restoreComposerDraft();
  $<HTMLTextAreaElement>("composer-input").focus();
}

// A model outside the catalog (a pi favorite saved from a since-unloaded model
// list, say) keeps its id rather than borrowing the fallback entry's label.
function modelLabelFor(harness: Harness, model: string): string {
  const choice = choiceById(harness, model);
  return choice?.id === model ? choice.label : model;
}

function setFavorites(list: NewChatDefaults[]): void {
  favorites = [...list].sort((a, b) => {
    const titleOrder = favoriteTitle(a).localeCompare(
      favoriteTitle(b),
      undefined,
      {
        numeric: true,
        sensitivity: "base",
      },
    );
    return (
      titleOrder ||
      favoriteSub(a).localeCompare(favoriteSub(b), undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );
  });
  show($("sessions-favorites"), favorites.length > 0);
  renderDialogFavorites();
  renderFavoriteToggle();
}

const sameFavorite = (a: NewChatDefaults, b: NewChatDefaults) =>
  a.harness === b.harness &&
  a.model === b.model &&
  a.effort === b.effort &&
  a.cwd === b.cwd &&
  a.permissionMode === b.permissionMode;

function favoriteModelTitle(f: NewChatDefaults): string {
  const effort = f.effort ? ` (${f.effort})` : "";
  return `${modelLabelFor(f.harness, f.model)}${effort}`;
}

function favoriteTitle(f: NewChatDefaults): string {
  return `${harnessById(f.harness).badge} · ${favoriteModelTitle(f)}`;
}

function favoriteSub(f: NewChatDefaults): string {
  const permission = f.permissionMode
    ? (harnessById(f.harness).permissionModes.find(
        (m) => m.id === f.permissionMode,
      )?.label ?? f.permissionMode)
    : "";
  return [f.cwd, permission].filter(Boolean).join(" · ");
}

function dialogFavorite(): NewChatDefaults {
  const harness = selectedHarness();
  return {
    harness,
    model: $<HTMLSelectElement>("nc-model").value,
    effort: $<HTMLSelectElement>("nc-effort").value,
    cwd: $<HTMLInputElement>("nc-cwd").value.trim(),
    permissionMode: harnessById(harness).permissionModes.length
      ? $<HTMLSelectElement>("nc-permission").value
      : "",
  };
}

// The star fills when the dialog's exact configuration is already saved.
function renderFavoriteToggle(): void {
  const unavailable = modelsUnavailable(selectedHarness());
  const saved =
    !unavailable && favorites.some((f) => sameFavorite(f, dialogFavorite()));
  const button = $<HTMLButtonElement>("nc-favorite");
  button.classList.toggle("favorited", saved);
  button.setAttribute("aria-pressed", String(saved));
  button.setAttribute("aria-label", saved ? "Remove favorite" : "Add favorite");
  const current = unavailable ? null : dialogFavorite();
  const rows = $("nc-favorites-list").children;
  favorites.forEach((f, i) => {
    rows[i]?.classList.toggle(
      "active",
      current !== null && sameFavorite(f, current),
    );
  });
}

function renderDialogFavorites(): void {
  const section = $("nc-favorites");
  show(section, favorites.length > 0);
  section.classList.toggle("collapsed", favoritesCollapsed);
  $("nc-favorites-toggle").setAttribute(
    "aria-expanded",
    String(!favoritesCollapsed),
  );
  $("nc-favorites-count").textContent = String(favorites.length);
  const list = $("nc-favorites-list");
  list.innerHTML = "";
  for (const f of favorites) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "nc-favorite-row";
    row.appendChild(
      paintHarnessIcon(document.createElement("span"), f.harness),
    );
    const text = document.createElement("span");
    text.className = "nc-favorite-row-text";
    const title = document.createElement("span");
    title.className = "nc-favorite-row-title";
    title.textContent = favoriteModelTitle(f);
    text.appendChild(title);
    if (f.cwd) {
      const sub = document.createElement("span");
      sub.className = "nc-favorite-row-sub";
      sub.textContent = f.cwd;
      text.appendChild(sub);
    }
    row.appendChild(text);
    row.addEventListener("click", () => applyFavoriteToDialog(f));
    list.appendChild(row);
  }
}

function toggleFavoritesCollapsed(): void {
  favoritesCollapsed = !favoritesCollapsed;
  renderDialogFavorites();
  void api.saveFavoritesCollapsed(favoritesCollapsed).catch((err) => {
    void api.logClient("ui", `could not save favorites collapsed: ${err}`);
    toast("Favorites folded, but not saved");
  });
}

// Fills the form the way a draft's frontmatter does: the favorite overlays the
// remembered defaults for its harness so pi's async model reload keeps it.
function applyFavoriteToDialog(f: NewChatDefaults): void {
  hideError("newchat-error");
  const harnessSelect = $<HTMLSelectElement>("nc-harness");
  if (!Array.from(harnessSelect.options).some((o) => o.value === f.harness)) {
    showError(
      "newchat-error",
      `${harnessById(f.harness).label} is not installed on this server`,
      "This favorite cannot be used here.",
    );
    return;
  }
  harnessSelect.value = f.harness;
  agentDefaults = { ...agentDefaults, [f.harness]: f };
  activateHarnessOptions(f.harness, f);
  $<HTMLInputElement>("nc-cwd").value = f.cwd;
  renderFavoriteToggle();
}

let favoriteToggleInFlight = false;

async function toggleFavoriteFromDialog(): Promise<void> {
  hideError("newchat-error");
  if (favoriteToggleInFlight || modelsUnavailable(selectedHarness())) return;
  const favorite = dialogFavorite();
  if (!favorite.cwd) {
    showError(
      "newchat-error",
      "Workspace path required",
      "Enter an absolute path on the server.",
    );
    return;
  }
  const saved = favorites.some((f) => sameFavorite(f, favorite));
  favoriteToggleInFlight = true;
  try {
    if (saved) {
      setFavorites(await api.deleteFavorite(favorite));
      toast("Favorite removed");
    } else {
      setFavorites(await api.saveFavorite(favorite));
      toast("Favorite added");
    }
  } catch (err) {
    showError(
      "newchat-error",
      saved ? "Could not remove the favorite" : "Could not save the favorite",
      err,
    );
  } finally {
    favoriteToggleInFlight = false;
  }
}

function openFavoritesMenu(at?: MenuAnchor): void {
  openPopupMenu(
    favorites.map((f) => ({
      label: favoriteTitle(f),
      sub: favoriteSub(f),
      run: () => startFavoriteChat(f),
      hold: (holdAt: MenuAnchor) =>
        openPopupMenu(
          [
            {
              label: "Delete favorite",
              danger: true,
              run: () => void deleteFavorite(f),
            },
          ],
          holdAt,
        ),
    })),
    at,
  );
}

async function deleteFavorite(f: NewChatDefaults): Promise<void> {
  try {
    setFavorites(await api.deleteFavorite(f));
    toast("Favorite deleted");
  } catch (err) {
    toast(`Could not delete the favorite: ${String(err)}`);
  }
}

// The same landing as Create, minus the dialog: waiting shared, forwarded or
// draft text is spent into the new chat here too.
function startFavoriteChat(f: NewChatDefaults): void {
  chatGeneration += 1;
  enterNewChat(f.harness, f.model, f.effort, f.cwd, f.permissionMode);
  consumePendingShare();
  consumePendingForward();
  consumePendingDraft();
}

// Reached by holding a card's header: what the card was rendered from.
function sourceEntryFor(item: ThreadItem): { text: string; sub: string } {
  const id = String((item as { id?: string }).id ?? "");
  const positional = id.match(/^s-(\d+)-\d+$/);
  const line = positional ? Number(positional[1]) : -1;
  const entry = chat.entries[line];
  if (entry) {
    return {
      text: JSON.stringify(entry, null, 2),
      sub: `Line ${line + 1} of the session file, as ${
        harnessById(chat.harness).agentName
      } wrote it.`,
    };
  }
  return {
    text: JSON.stringify(item, null, 2),
    sub:
      "The transcript node, not a session line: this reader keys nodes by part" +
      " id rather than by position, so there is no single line to show.",
  };
}

function openRawModal(item: ThreadItem, label: string): void {
  const { text, sub } = sourceEntryFor(item);
  $("raw-sub").textContent = `${label} — ${sub}`;
  const body = $("raw-body");
  body.textContent = text;
  show($("modal-raw"), true);
  body.scrollTop = 0;
}

// The chat header's ☰ is not the sessions drawer: it carries only actions on
// the conversation in front of it and nothing that navigates, which the back
// chevron and the session pill already own.
//
// Filters are the one place this app hides part of a session, so the menu item
// says how many kinds are off.
function hiddenKinds(harness: Harness): string[] {
  // A harness never saved on this device gets the shipped defaults; a saved
  // set, even an all-visible empty one, is the reader's answer and wins.
  return knownHidden(
    harness,
    transcriptFilters[harness] ?? defaultHidden(harness),
  );
}

function applyTranscriptFilters(): void {
  const harness = chat.harness;
  const hidden = hiddenKinds(harness);
  transcript.setHidden(
    hidden.length ? (item) => isHidden(harness, hidden, item) : null,
  );
  // The count lives on the menu item: a permanent dot on the ☰ itself would
  // read as a notification badge.
  $("chat-menu-filters-count").textContent = hidden.length
    ? `${hidden.length} hidden`
    : "";
}

function closeChatMenu(): void {
  show($("chat-menu"), false);
  $("chat-menu-btn").setAttribute("aria-expanded", "false");
}

function openChatMenu(): void {
  // The harness behind the count changes with the session.
  applyTranscriptFilters();
  renderChatMenuRefresh();
  renderChatMenuSessionData();
  renderChatMenuSessionPretty();
  renderChatMenuDetails();
  renderChatMenuClose();
  renderChatMenuDelete();
  show($("chat-menu"), true);
  $("chat-menu-btn").setAttribute("aria-expanded", "true");
}

function renderChatMenuRefresh(): void {
  const item = $<HTMLButtonElement>("chat-menu-refresh");
  const hasSession = Boolean(chat.rolloutPath);
  item.disabled = !hasSession || chat.turnActive;
  item.textContent = chat.turnActive
    ? "Refresh chat — turn in progress"
    : hasSession
      ? "Refresh chat"
      : "Refresh chat — no session saved yet";
}

function renderChatMenuSessionData(): void {
  const item = $<HTMLButtonElement>("chat-menu-session-data");
  item.disabled = !chat.rolloutPath;
  item.textContent = chat.rolloutPath
    ? "Session data…"
    : "Session data — no session saved yet";
}

function renderChatMenuSessionPretty(): void {
  const item = $<HTMLButtonElement>("chat-menu-session-pretty");
  item.disabled = !chat.rolloutPath;
  item.textContent = chat.rolloutPath
    ? "Session file (pretty)…"
    : "Session file (pretty) — no session saved yet";
}

async function openPrettySessionFile(): Promise<void> {
  const path = chat.rolloutPath;
  if (!path) return;
  overlay("Formatting the session file…");
  try {
    const pretty = await api.prettySessionFile(path);
    openFileChooser(pretty.path, null);
  } catch (err) {
    showAlert(
      "Could not format the session file",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    overlay(null);
  }
}

async function refreshOpenChat(): Promise<void> {
  closeChatMenu();
  if (chat.turnActive) {
    toast("Wait for this turn to finish before refreshing");
    return;
  }
  const path = chat.rolloutPath;
  if (!path) {
    showAlert(
      "Nothing to refresh",
      "This chat has no session on the server yet — send a message first.",
    );
    return;
  }

  const generation = ++chatGeneration;
  overlay("Refreshing chat…");
  try {
    const slice = await readWholeRollout(path, chat.harness);
    if (chatGeneration !== generation || !isScreen("chat")) return;

    chat.entries = parseSessionLines(slice.lines);
    chat.file = { bytes: wholeLineBytes(slice.lines), lines: slice.lineCount };
    chat.cursor = 1 + slice.lineCount;
    rendered.clear();
    rolloutUserIds.clear();
    seenCategories.clear();
    transcript.clear();
    adoptAiTitle(chat.entries);
    adoptPiName(chat.entries);
    const facts = sessionFacts(chat.harness, chat.entries);
    chat.model = facts.model;
    chat.effort = facts.effort;
    if (facts.cwd) chat.cwd = facts.cwd;
    applyRollout();
    renderChatSessionPill();
    transcript.scrollToBottom(true);
  } catch (err) {
    if (chatGeneration === generation) {
      showAlert(
        "Could not refresh chat",
        err instanceof Error ? err.message : String(err),
      );
    }
  } finally {
    if (chatGeneration === generation) overlay(null);
  }
}

function renderChatMenuDetails(): void {
  const item = $<HTMLButtonElement>("chat-menu-details");
  item.disabled = !chat.threadId;
  item.textContent = chat.threadId
    ? "Session details…"
    : "Session details — no session saved yet";
}

interface SessionDetailsTarget {
  harness: Harness;
  threadId: string;
  path: string | null;
  name: string;
  label: string;
  nameLocked: boolean;
}

let detailsTarget: SessionDetailsTarget | null = null;

// pi is the only harness with a name of its own, and it appends the name to
// the session file a running turn is writing.
function nameLocked(
  harness: Harness,
  path: string | null,
  turnActive: boolean,
): boolean {
  return harness !== "pi" || !path || turnActive;
}

// A locked Name box shows what the header shows: the harness title, or the
// start of the first prompt when there is none.
function lockedName(title: string | null, preview: string | null): string {
  return truncateLabel(title || preview, Infinity) ?? "";
}

function detailsTargetFor(s: SessionSummary): SessionDetailsTarget {
  const locked = nameLocked(
    s.harness,
    s.path,
    isOpenSession(s) && chat.turnActive,
  );
  return {
    harness: s.harness,
    threadId: s.id,
    path: s.path,
    name: locked ? lockedName(s.title, s.preview) : (s.title ?? ""),
    label: s.label ?? "",
    nameLocked: locked,
  };
}

function openChatSessionDetails(): void {
  if (!chat.threadId) {
    showAlert(
      "No session yet",
      "This chat has no session on the server until its first message is" +
        " sent. Send one, then its details can be changed.",
    );
    return;
  }
  const current = sessions.find(isOpenSession);
  const locked = nameLocked(chat.harness, chat.rolloutPath, chat.turnActive);
  const title = chat.title || current?.title || null;
  openSessionDetails({
    harness: chat.harness,
    threadId: chat.threadId,
    path: chat.rolloutPath,
    name: locked ? lockedName(title, current?.preview ?? null) : (title ?? ""),
    label: chat.label ?? current?.label ?? "",
    nameLocked: locked,
  });
}

function openSessionDetails(target: SessionDetailsTarget): void {
  detailsTarget = target;
  hideError("details-error");
  const name = $<HTMLInputElement>("details-name");
  const label = $<HTMLInputElement>("details-label");
  name.value = target.name;
  name.disabled = target.nameLocked;
  label.value = target.label;
  show($("modal-details"), true);
  const first = name.disabled ? label : name;
  first.focus();
  first.select();
}

async function saveSessionDetails(): Promise<void> {
  const target = detailsTarget;
  if (!target) return;
  // Collapsed, not truncated: the inputs' own maxlength caps the length, the
  // sidecar file is one line, and the server collapses pi's name the same way.
  const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
  const name = collapse($<HTMLInputElement>("details-name").value);
  const label = collapse($<HTMLInputElement>("details-label").value);
  const path = target.path;
  const renaming = path !== null && !target.nameLocked && name !== target.name;
  const relabeling = label !== target.label;
  hideError("details-error");
  if (renaming && !name) {
    showError(
      "details-error",
      "Enter a name",
      "pi has no blank session name — a session either has one or keeps the one it has.",
    );
    return;
  }
  if (!renaming && !relabeling) {
    show($("modal-details"), false);
    return;
  }
  const isOpen =
    chat.harness === target.harness && chat.threadId === target.threadId;
  const row = sessions.find(
    (s) => s.harness === target.harness && s.id === target.threadId,
  );
  const save = $<HTMLButtonElement>("details-save");
  save.disabled = true;
  try {
    if (relabeling) {
      await api.setSessionLabel(target.harness, target.threadId, label);
      target.label = label;
      if (row) row.label = label || null;
      if (isOpen) chat.label = label || null;
    }
    if (renaming) {
      await api.setPiSessionName(path, target.threadId, name);
      target.name = name;
      if (row) row.title = name;
      if (isOpen) chat.title = name;
    }
  } catch (err) {
    renderChatSessionPill();
    renderSessionList();
    showError("details-error", "Could not save the session details", err);
    return;
  } finally {
    save.disabled = false;
  }
  show($("modal-details"), false);
  if (renaming && relabeling) toast("Session details saved");
  else if (renaming) toast("Session renamed");
  else toast(label ? "Label saved" : "Label removed");
  // pi records the name as an entry in the session itself, so a chat holding
  // that session re-reads it: nothing else would put the card on screen, and
  // going back to an open chat does not re-read it either.
  if (renaming && isOpen) {
    overlay("Reloading chat…");
    try {
      await reloadChat();
    } catch (err) {
      showAlert(
        "Could not reload the chat",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      overlay(null);
    }
  }
  renderChatSessionPill();
  renderSessionList();
}

function renderChatMenuClose(): void {
  const item = $<HTMLButtonElement>("chat-menu-close");
  const text = $("chat-menu-close-text");
  const current = sessions.find(isOpenSession);
  item.disabled = !current;
  item.setAttribute(
    "aria-checked",
    current && current.closedAt !== null ? "true" : "false",
  );
  text.textContent = current
    ? "Mark closed"
    : "Mark closed — no session saved yet";
}

async function toggleOpenSessionClosed(): Promise<void> {
  const current = sessions.find(isOpenSession);
  if (!current) {
    showAlert(
      "Cannot close this session",
      "This chat has no session on the server yet — send a message first.",
    );
    return;
  }
  const closing = current.closedAt === null;
  overlay(closing ? "Closing session…" : "Reopening session…");
  try {
    await api.setSessionClosed(current.harness, current.id, closing);
  } catch (err) {
    overlay(null);
    showAlert(
      closing ? "Could not close the session" : "Could not reopen the session",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  // Optimistic, like a read mark: the pill flips now, and the next list
  // refresh brings the server's own timestamp back.
  current.closedAt = closing ? Math.floor(Date.now() / 1000) : null;
  overlay(null);
  renderChatSessionPill();
  renderSessionList();
  toast(closing ? "Session closed" : "Session reopened");
  if (closing) openSessionsView();
}

function renderChatMenuDelete(): void {
  const item = $<HTMLButtonElement>("chat-menu-delete");
  const reason = harnessById(chat.harness).cannotDeleteReason;
  if (chat.turnActive) {
    item.disabled = true;
    item.textContent = "Delete session…";
  } else if (reason) {
    item.disabled = true;
    item.textContent = `Delete session — ${reason}`;
  } else if (!sessions.find(isOpenSession)) {
    item.disabled = true;
    item.textContent = "Delete session — no session saved yet";
  } else {
    item.disabled = false;
    item.textContent = "Delete session…";
  }
}

function deleteOpenSession(): void {
  if (chat.turnActive) {
    showAlert(
      "Cannot delete this session",
      "This session has a turn running. Interrupt it first.",
    );
    return;
  }
  const reason = harnessById(chat.harness).cannotDeleteReason;
  if (reason) {
    showAlert("Cannot delete this session", `Deleting a session is ${reason}.`);
    return;
  }
  const current = sessions.find(isOpenSession);
  if (!current) {
    showAlert(
      "Cannot delete this session",
      "This chat has no session on the server yet — send a message first.",
    );
    return;
  }
  void deleteSessionFromServer(current).then((deleted) => {
    // The delete already reset the chat state, so the list is the only place
    // left to stand.
    if (deleted) openSessionsView();
  });
}

function renderFiltersModal(): void {
  const harness = chat.harness;
  const hiddenList = hiddenKinds(harness);
  const categories = allFiltersFor(harness, seenCategories, hiddenList);
  const hidden = new Set(hiddenList);
  const list = $("filters-list");
  list.innerHTML = "";
  $("filters-harness").textContent = harnessById(harness).label;

  let separated = false;
  for (const category of categories) {
    // A heading is enough to say that these came from the conversation, while
    // the ones above are the same for every chat this agent has.
    if (!separated && entryTypeOf(category.id)) {
      separated = true;
      const heading = document.createElement("p");
      heading.className = "filter-heading muted small";
      heading.textContent = `Entry types in this chat (${harnessById(harness).agentName}'s own names)`;
      list.appendChild(heading);
    }

    const row = document.createElement("label");
    row.className = "filter-row";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = hidden.has(category.id);
    box.dataset.filter = category.id;

    const text = document.createElement("span");
    text.className = "filter-label";
    const label = document.createElement("span");
    // A type is shown in the monospace it was written in; a category label is
    // prose and stays prose.
    if (entryTypeOf(category.id)) label.className = "mono";
    label.textContent = category.label;
    const hint = document.createElement("span");
    hint.className = "filter-hint";
    hint.textContent = seenCategories.has(category.id)
      ? category.hint
      : `${category.hint} None in this chat.`;
    text.append(label, hint);

    row.append(box, text);
    list.appendChild(row);
  }

  // Lifts the current state off the device so a set chosen by hand can become
  // `DEFAULT_HIDDEN` in filters.ts. Release builds only offer it while
  // maintenance mode is on.
  if ((import.meta.env.DEV || maintenanceMode) && categories.length) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "ghost";
    copy.textContent = "Copy filter state (dev)";
    copy.addEventListener("click", copyFilterState);
    list.appendChild(copy);
  }

  const none = $("filters-none");
  none.textContent = categories.length
    ? ""
    : `Nothing to filter yet for ${harnessById(harness).agentName} — the kinds` +
      " are named after what each CLI writes, and this one has no set yet.";
  show(none, categories.length === 0);
  show($("filters-reset"), categories.length > 0);
  show($("filters-defaults"), categories.length > 0);
}

function copyFilterState(): void {
  const harness = chat.harness;
  const hidden = new Set(hiddenKinds(harness));
  const categories = allFiltersFor(harness, seenCategories, [...hidden]);
  const state = {
    harness,
    hidden: categories.map((c) => c.id).filter((id) => hidden.has(id)),
    visible: categories.map((c) => c.id).filter((id) => !hidden.has(id)),
  };
  void writeText(JSON.stringify(state, null, 2)).then(
    () => toast("Filter state copied"),
    () => toast("Copy failed"),
  );
}

function openFiltersModal(): void {
  closeChatMenu();
  renderFiltersModal();
  show($("modal-filters"), true);
}

function saveFilters(hidden: string[]): void {
  const harness = chat.harness;
  const defaults = defaultHidden(harness);
  const isDefault =
    hidden.length === defaults.length &&
    hidden.every((id, index) => id === defaults[index]);
  if (isDefault) {
    delete transcriptFilters[harness];
  } else {
    transcriptFilters[harness] = hidden;
  }
  applyTranscriptFilters();
  void (
    isDefault
      ? api.clearTranscriptFilters(harness)
      : api.saveTranscriptFilters(harness, hidden)
  ).catch((err) => {
    // The transcript already reflects the choice; only the memory of it is lost,
    // so this is worth a line in the log rather than a modal.
    void api.logClient("ui", `could not save transcript filters: ${err}`);
  });
}

function toggleFilter(id: string, hide: boolean): void {
  const hidden = new Set(hiddenKinds(chat.harness));
  if (hide) hidden.add(id);
  else hidden.delete(id);
  // Stored in the dialog's own order, the table's categories first, then the
  // entry types alphabetically, so the saved file reads the way the list does
  // rather than in whatever order the boxes were ticked.
  const ordered = allFiltersFor(chat.harness, seenCategories, [...hidden])
    .map((f) => f.id)
    .filter((f) => hidden.has(f));
  saveFilters(ordered);
}

function filterName(harness: Harness, category: string): string {
  const type = entryTypeOf(category);
  if (type) return entryFilterFor(type).label;
  return filtersFor(harness).find((f) => f.id === category)?.label ?? category;
}

function hideActionFor(
  item: ThreadItem,
): { label: string; run: () => void } | null {
  const harness = chat.harness;
  const category = categoryOf(harness, item);
  if (!category || hiddenKinds(harness).includes(category)) return null;
  const name = filterName(harness, category);
  return {
    label: `Hide ${name} messages`,
    run: () => {
      toggleFilter(category, true);
      // The card disappears as this runs, so the toast is what says where the
      // decision now lives.
      toast(`Hiding ${name} — undo in ☰ → Filters`);
    },
  };
}

// App-wide preferences live on the device: how the app looks is a fact about
// the phone, not about a server or a conversation.
const osPrefersLight = window.matchMedia("(prefers-color-scheme: light)");

function applyTheme(): void {
  const resolved =
    theme === "system" ? (osPrefersLight.matches ? "light" : "dark") : theme;
  document.documentElement.dataset.theme = resolved;
  // Android picks the status-bar icon colour from the *activity's* night
  // mode, which has nothing to do with the palette this page chose, so the
  // resolved scheme is pushed through the bridge. Absent off Android.
  window.PabloSystemBars?.setScheme(resolved);
}

function applyChatFontSize(): void {
  document.documentElement.style.setProperty(
    "--chat-font-size",
    `${chatFontSize}px`,
  );
}

function openPreferences(): void {
  $<HTMLSelectElement>("set-theme").value = theme;
  $<HTMLSelectElement>("set-chat-font-size").value = String(chatFontSize);
  $<HTMLInputElement>("set-send-on-enter").checked = sendOnEnter;
  $<HTMLInputElement>("set-maintenance").checked = maintenanceMode;
  $<HTMLInputElement>("set-drafts-path").value = draftPromptsPath;
  show($("modal-preferences"), true);
}

function chooseTheme(choice: ThemeChoice): void {
  theme = choice;
  applyTheme();
  void api.saveTheme(choice).catch((err) => {
    void api.logClient("ui", `could not save the theme: ${err}`);
    toast("Theme applied, but not saved");
  });
}

function chooseChatFontSize(size: ChatFontSize): void {
  chatFontSize = size;
  applyChatFontSize();
  void api.saveChatFontSize(size).catch((err) => {
    void api.logClient("ui", `could not save chat font size: ${err}`);
    toast("Font size applied, but not saved");
  });
}

function applySendOnEnter(): void {
  $("composer").classList.toggle("multiline", !sendOnEnter);
}

function chooseSendOnEnter(on: boolean): void {
  sendOnEnter = on;
  applySendOnEnter();
  void api.saveSendOnEnter(on).catch((err) => {
    void api.logClient("ui", `could not save send on enter: ${err}`);
    toast("Send on enter changed, but not saved");
  });
}

function chooseMaintenanceMode(on: boolean): void {
  maintenanceMode = on;
  renderDrawerMaintenanceItems();
  void api.saveMaintenanceMode(on).catch((err) => {
    void api.logClient("ui", `could not save maintenance mode: ${err}`);
    toast("Maintenance mode applied, but not saved");
  });
}

function chooseDraftPromptsPath(path: string): void {
  draftPromptsPath = path;
  void api.saveDraftPromptsPath(path).catch((err) => {
    void api.logClient("ui", `could not save the drafts path: ${err}`);
    toast("Draft prompts path applied, but not saved");
  });
}

// A prompt saved as a markdown file on the server, settings in front matter and
// prompt as the body, so it can start a new chat later from any device. Saved by
// holding the composer's send button. `drafts.ts` is the file format.
function draftPromptChunks(): string[] {
  const chunks: string[] = [];
  for (const item of renderSession(chat.harness, chat.entries, "s")) {
    if (item.type !== "userMessage") continue;
    const text = textOf(item as ThreadItem).trim();
    if (text) chunks.push(text);
  }
  // Prompts sent but not yet read back out of the session file.
  for (const echo of localEchoes.values()) {
    const text = echo.rawText.trim();
    if (text) chunks.push(text);
  }
  const typed = $<HTMLTextAreaElement>("composer-input").value.trim();
  if (typed) chunks.push(typed);
  return chunks;
}

function openComposerMenu(at?: MenuAnchor): void {
  const empty = draftPromptChunks().length === 0;
  openPopupMenu(
    [
      empty
        ? {
            label: "Save as draft — nothing to save yet",
            run: () => {},
            disabled: true,
          }
        : {
            label: "Save as draft…",
            run: () =>
              openDraftNameModal("Save as draft", "", saveDraftAsTyped),
          },
    ],
    at,
  );
}

async function saveDraftAsTyped(name: string): Promise<void> {
  await api.saveDraftPrompt(
    draftPromptsPath,
    name,
    formatDraft({
      prompt: draftPromptChunks().join("\n\n\n"),
      harness: chat.harness,
      model: chat.model,
      effort: chat.effort,
      cwd: chat.cwd,
      permissionMode: chat.permissionMode,
      createdAt: new Date().toISOString(),
    }),
  );
  const input = $<HTMLTextAreaElement>("composer-input");
  input.value = "";
  input.dispatchEvent(new Event("input"));
  toast("Draft saved");
}

let draftNameAction: ((name: string) => Promise<void>) | null = null;
let draftNameVerb = "save";

function openDraftNameModal(
  heading: string,
  initial: string,
  onSave: (name: string) => Promise<void>,
  verb = "save",
): void {
  draftNameAction = onSave;
  draftNameVerb = verb;
  hideError("draft-name-error");
  $("draft-name-heading").textContent = heading;
  $("draft-name-save-label").textContent =
    verb.charAt(0).toUpperCase() + verb.slice(1);
  const input = $<HTMLInputElement>("draft-name-input");
  input.value = initial;
  show($("modal-draft-name"), true);
  input.focus();
  input.select();
}

async function submitDraftName(): Promise<void> {
  const run = draftNameAction;
  if (!run) return;
  const name = $<HTMLInputElement>("draft-name-input").value.trim();
  if (!name) {
    showError(
      "draft-name-error",
      "Name required",
      "Enter a name for this draft, like project1/tasks/fix-bug.",
    );
    return;
  }
  hideError("draft-name-error");
  const save = $<HTMLButtonElement>("draft-name-save");
  save.disabled = true;
  show($("draft-name-spinner"), true);
  try {
    await run(name);
    draftNameAction = null;
    show($("modal-draft-name"), false);
  } catch (err) {
    showError("draft-name-error", `Could not ${draftNameVerb} the draft`, err);
  } finally {
    save.disabled = false;
    show($("draft-name-spinner"), false);
  }
}

let draftsGeneration = 0;

type ListedDraft = DraftPrompt & { readOnly: boolean };

async function openDraftsModal(): Promise<void> {
  const generation = ++draftsGeneration;
  hideError("drafts-error");
  const status = $("drafts-status");
  status.textContent = "";
  status.classList.add("loading");
  status.setAttribute("aria-label", "Loading drafts from the server");
  show(status, true);
  $("drafts-list").innerHTML = "";
  show($("modal-drafts"), true);
  let files: DraftPromptFile[];
  try {
    files = await api.listDraftPrompts(draftPromptsPath);
  } catch (err) {
    if (generation !== draftsGeneration) return;
    status.classList.remove("loading");
    status.removeAttribute("aria-label");
    show(status, false);
    showError("drafts-error", "Could not load draft prompts", err);
    return;
  }
  if (generation !== draftsGeneration) return;
  renderDraftsList(
    files.map((file) => ({
      ...(file.readOnly
        ? parseTextDraft(file.id, file.text)
        : parseDraft(file.id, file.text)),
      readOnly: file.readOnly,
    })),
  );
}

function renderDraftsList(drafts: ListedDraft[]): void {
  const list = $("drafts-list");
  list.innerHTML = "";
  const status = $("drafts-status");
  status.classList.remove("loading");
  status.removeAttribute("aria-label");
  if (!drafts.length) {
    status.textContent =
      "No draft prompts saved yet. In a chat, press and hold the send " +
      "button and choose Save as draft.";
    show(status, true);
    return;
  }
  show(status, false);
  const sorted = [...drafts].sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" }),
  );
  for (const d of sorted) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "draft-row";
    const title = document.createElement("span");
    title.className = "draft-row-title";
    title.textContent = d.id;
    row.appendChild(title);
    const createdAt = Date.parse(d.createdAt) / 1000;
    const age = compactAge(createdAt);
    if (age !== null) {
      const pill = document.createElement("span");
      pill.className = "draft-row-age";
      pill.dataset.relAt = String(createdAt);
      pill.dataset.relFormat = "compact";
      pill.textContent = age;
      row.appendChild(pill);
    }
    const chevron = document.createElement("span");
    chevron.className = "draft-row-chevron";
    chevron.textContent = "›";
    row.appendChild(chevron);
    attachHoldMenu(row, (at) => openDraftMenu(d, at));
    row.addEventListener("click", () => {
      if (consumeLongPress(row)) return;
      // Read-only drafts cannot be removed, so there is no choice to offer.
      if (d.readOnly) useDraft(d, false);
      else openDraftUseModal(d);
    });
    list.appendChild(row);
  }
}

let draftUseTarget: ListedDraft | null = null;

function openDraftUseModal(d: ListedDraft): void {
  draftUseTarget = d;
  $("draft-use-name").textContent = d.id;
  show($("modal-draft-use"), true);
}

function closeDraftUseModal(deleteAfter: boolean | null): void {
  const d = draftUseTarget;
  draftUseTarget = null;
  show($("modal-draft-use"), false);
  if (d && deleteAfter !== null) useDraft(d, deleteAfter);
}

function openDraftMenu(d: ListedDraft, at?: MenuAnchor): void {
  openPopupMenu(
    [
      { label: "Use & keep", run: () => useDraft(d, false) },
      ...(d.readOnly
        ? []
        : [{ label: "Use & remove", run: () => useDraft(d, true) }]),
      ...(d.readOnly ? [] : [{ label: "Rename…", run: () => renameDraft(d) }]),
      { label: "Duplicate…", run: () => duplicateDraft(d) },
      ...(d.readOnly
        ? []
        : [
            {
              label: "Delete…",
              danger: true,
              run: () => void deleteDraft(d),
            },
          ]),
    ],
    at,
  );
}

function duplicateDraft(d: DraftPrompt): void {
  show($("modal-drafts"), false);
  openDraftNameModal("Duplicate draft", d.id, async (name) => {
    await api.saveDraftPrompt(
      draftPromptsPath,
      name,
      formatDraft({
        prompt: d.prompt,
        harness: d.harness,
        model: d.model,
        effort: d.effort,
        cwd: d.cwd,
        permissionMode: d.permissionMode,
        createdAt: new Date().toISOString(),
      }),
    );
    toast("Draft duplicated");
    void openDraftsModal();
  });
}

function renameDraft(d: DraftPrompt): void {
  show($("modal-drafts"), false);
  openDraftNameModal(
    "Rename draft",
    d.id,
    async (name) => {
      if (name !== d.id) {
        await api.renameDraftPrompt(draftPromptsPath, d.id, name);
        toast("Draft renamed");
      }
      void openDraftsModal();
    },
    "rename",
  );
}

async function deleteDraft(d: DraftPrompt): Promise<void> {
  const ok = await askConfirm(
    "Delete this draft?",
    `"${d.id}" is removed from the server. This cannot be undone.`,
    "Delete",
  );
  if (!ok) return;
  try {
    await api.deleteDraftPrompt(draftPromptsPath, d.id);
  } catch (err) {
    showError("drafts-error", "Could not delete the draft", err);
    return;
  }
  toast("Draft deleted");
  void openDraftsModal();
}

// Opens the New chat dialog rather than the chat itself: the draft's saved
// model settings are a starting point the user gets to verify or change.
function useDraft(d: ListedDraft, deleteAfter: boolean): void {
  show($("modal-drafts"), false);
  pendingDraftPrompt = d.prompt;
  pendingDraftDeleteId = deleteAfter ? d.id : null;
  pendingDraftDefaults = d.readOnly
    ? null
    : {
        harness: harnessById(d.harness).id,
        model: d.model,
        effort: d.effort,
        cwd: d.cwd || settings?.defaultCwd || "",
        permissionMode: d.permissionMode,
      };
  void openNewChatModal();
}

let drawerLoadGeneration = 0;

function renderDrawerMaintenanceItems(): void {
  show($("drawer-diagnostics"), maintenanceMode);
}

async function openDrawer(): Promise<void> {
  renderDrawerMaintenanceItems();
  const generation = ++drawerLoadGeneration;
  const meta = $("drawer-meta");
  meta.textContent = "Loading connection details…";
  meta.classList.add("loading");
  // Started here rather than awaited below: the details above come out of what
  // connecting already established, and must not be held back by a round trip.
  void loadHostStats(generation);
  show($("drawer"), true);
  try {
    const info = await api.connectionInfo();
    if (generation !== drawerLoadGeneration) return;
    if (info) capabilities = info.capabilities;
    meta.textContent = info
      ? [
          `${info.username}@${info.host}:${info.port}`,
          // Every binary, present or not: "no sessions listed" reads very
          // differently once the drawer says one of them is missing.
          `${info.codexBin} — ${info.capabilities.codexVersion ?? "not installed"}`,
          `${info.claudeBin} — ${info.capabilities.claudeVersion ?? "not installed"}`,
          `${info.opencodeBin} — ${info.capabilities.opencodeVersion ?? "not installed"}`,
          `${info.piBin} — ${info.capabilities.piVersion ?? "not installed"}`,
        ].join("\n")
      : "Not connected";
  } catch (err) {
    if (generation !== drawerLoadGeneration) return;
    meta.textContent = "Could not load connection details";
    void api.logClient("ui", `could not load drawer details: ${err}`);
  } finally {
    if (generation === drawerLoadGeneration) meta.classList.remove("loading");
  }
}

async function loadHostStats(generation: number): Promise<void> {
  const el = $("drawer-stats");
  el.textContent = "Reading host stats…";
  el.classList.add("loading");
  try {
    const stats = await api.hostStats();
    if (generation !== drawerLoadGeneration) return;
    renderHostStats(el, stats);
  } catch (err) {
    if (generation !== drawerLoadGeneration) return;
    el.textContent = "Host stats unavailable";
    void api.logClient("ui", `could not read host stats: ${err}`);
  } finally {
    if (generation === drawerLoadGeneration) el.classList.remove("loading");
  }
}

function renderHostStats(el: HTMLElement, stats: HostStats): void {
  const usage = (use: UsageStats | null) => {
    if (!use || use.totalKb <= 0) return { text: "unknown", percent: null };
    const percent = (use.usedKb / use.totalKb) * 100;
    return {
      text: `${formatBytes(use.usedKb * 1024)} of ${formatBytes(
        use.totalKb * 1024,
      )} (${formatPercent(percent)})`,
      percent,
    };
  };
  // Single spaces: `.drawer-meta` is `white-space: pre-line` and would collapse
  // a wider gutter anyway.
  const cores = stats.cores.map((core) => formatPercent(core)).join(" ");
  const cpu = {
    text:
      stats.cpu === null && !stats.cores.length
        ? "unknown"
        : `${stats.cpu === null ? "—" : formatPercent(stats.cpu)}${
            cores ? ` · ${cores}` : ""
          }`,
    // `cpu` is the aggregate `/proc/stat` row, not a single core.
    percent: stats.cpu,
  };
  const rows = [
    ["cpu", "CPU", cpu],
    ["memory", "Memory", usage(stats.memory)],
    ["disk", "Disk space", usage(stats.disk)],
  ] as const;
  el.replaceChildren(
    ...rows.map(([kind, label, reading]) => {
      const row = document.createElement("div");
      row.className = `drawer-stat ${kind}`;
      const name = document.createElement("span");
      name.className = "drawer-stat-label";
      name.textContent = label;
      const value = document.createElement("span");
      value.className = "drawer-stat-value";
      value.textContent = reading.text;
      const line = document.createElement("div");
      line.className = "drawer-stat-line";
      line.append(name, value);
      row.append(line, hostStatProgress(label, reading.percent));
      return row;
    }),
  );
}

function hostStatProgress(
  label: string,
  percent: number | null,
): HTMLDivElement {
  const bar = document.createElement("div");
  bar.className = "drawer-stat-bar";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", `${label} usage`);
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  const fill = document.createElement("span");
  fill.className = "drawer-stat-fill";
  if (percent !== null && Number.isFinite(percent)) {
    const bounded = Math.max(0, Math.min(percent, 100));
    fill.style.width = `${bounded}%`;
    bar.setAttribute("aria-valuenow", String(bounded));
  }
  bar.append(fill);
  return bar;
}

async function openDiagnostics(): Promise<void> {
  const lines = await api.getDiagnostics();
  const body = $("diag-body");
  body.textContent = lines.join("\n");
  show($("modal-diagnostics"), true);
  body.scrollTop = body.scrollHeight;
  body.onclick = () => {
    void writeText(lines.join("\n")).then(
      () => toast("Diagnostics copied"),
      () => toast("Copy failed"),
    );
  };
}

async function handleDrawerAction(action: string): Promise<void> {
  show($("drawer"), false);
  switch (action) {
    case "new-chat":
      await openNewChatModal();
      break;
    case "draft-prompts":
      await openDraftsModal();
      break;
    case "preferences":
      openPreferences();
      break;
    case "diagnostics":
      if (maintenanceMode) await openDiagnostics();
      break;
    case "reconnect":
      if (settings) await doConnect(settings);
      break;
    case "clear-ssh": {
      const ok = await askConfirm(
        "Forget this server?",
        "The saved SSH details and the trusted host key are removed from this device.",
        "Forget",
      );
      if (!ok) return;
      try {
        await api.clearSettings();
      } catch (err) {
        showError("sessions-error", "Could not forget the server", err);
        return;
      }
      settings = null;
      resetModelCatalogs();
      // The 1.5s poll has been running behind this dialog; a reply still in
      // flight would helpfully fill the emptied list back in.
      sessionsGeneration += 1;
      sessions = [];
      // `clear_settings` writes a default state file, so the in-memory
      // filters have to agree. Theme and maintenance mode are what it carries
      // over, so those stay; read marks live in the sidecar on the server
      // being forgotten.
      transcriptFilters = {};
      applyTranscriptFilters();
      // The drafts path names a place on the server being forgotten, so it
      // goes with the rest, the drafts themselves stay on that server.
      draftPromptsPath = "";
      resetChat();
      renderChatSessionPill();
      fillConnectForm(null);
      goto("connect");
      toast("SSH settings cleared");
      break;
    }
    default:
      break;
  }
}

// The WebView owns the scroll, so Android's own gesture never fires here and
// this rebuilds the convention from touch events: pulling down from the top of
// the list grows a ring, and past the arm point letting go runs the refresh.
function installPullToRefresh(
  body: HTMLElement,
  indicator: HTMLElement,
  refresh: () => Promise<void>,
): void {
  const ARM_AT = 64; // indicator height that commits a refresh on release
  const MAX = 96; // hard stop so the pull cannot drag forever
  let startY: number | null = null;
  let busy = false;

  const setHeight = (px: number) => {
    indicator.style.height = `${px}px`;
    indicator.classList.toggle("armed", px >= ARM_AT);
  };

  body.addEventListener(
    "touchstart",
    (e) => {
      if (busy) return;
      // Snap-back animates; the pull itself must track the finger directly.
      indicator.classList.remove("settling");
      startY = body.scrollTop <= 0 ? e.touches[0].clientY : null;
    },
    { passive: true },
  );

  body.addEventListener(
    "touchmove",
    (e) => {
      if (busy) return;
      const y = e.touches[0].clientY;
      if (startY === null) {
        // A drag that reaches the top mid-gesture starts pulling from here.
        if (body.scrollTop <= 0) startY = y;
        return;
      }
      const delta = y - startY;
      if (delta <= 0 || body.scrollTop > 0) {
        setHeight(0);
        return;
      }
      // Half the finger's travel reads as elastic rather than as scrolling.
      setHeight(Math.min(MAX, delta / 2));
    },
    { passive: true },
  );

  const release = () => {
    if (busy || startY === null) return;
    startY = null;
    indicator.classList.add("settling");
    if (!indicator.classList.contains("armed")) {
      setHeight(0);
      return;
    }
    busy = true;
    indicator.classList.add("busy");
    setHeight(ARM_AT); // hold the ring on screen while the refresh runs
    void refresh().finally(() => {
      busy = false;
      indicator.classList.remove("busy");
      setHeight(0);
    });
  };
  body.addEventListener("touchend", release);
  body.addEventListener("touchcancel", release);
}

function wireEvents(): void {
  $("form-connect").addEventListener("submit", (e) => {
    e.preventDefault();
    void doConnect(readConnectForm());
  });

  $("hk-accept").addEventListener("click", () => {
    const prompt = pendingHostKey;
    show($("modal-hostkey"), false);
    if (!prompt) return;
    void (async () => {
      try {
        await api.acceptHostKey(prompt);
        await doConnect(readConnectForm());
      } catch (err) {
        showConnectError("Could not store the accepted host key", err);
      }
    })();
  });
  $("hk-reject").addEventListener("click", rejectHostKey);

  $("sessions-new").addEventListener("click", () => void openNewChatModal());
  $("sessions-refresh").addEventListener("click", () => {
    void (async () => {
      overlay("Refreshing sessions…");
      try {
        // Forced: the answer to this tap has to be read after the tap.
        await refreshSessions(true, true);
      } finally {
        // The overlay swallows every touch, so an exit that skips this line is
        // an app with no way out of it.
        overlay(null);
      }
    })();
  });
  $("sessions-menu").addEventListener("click", () => void openDrawer());
  $("sessions-favorites").addEventListener("click", () => {
    const rect = $("sessions-favorites").getBoundingClientRect();
    openFavoritesMenu({ x: rect.left, y: rect.bottom + 4 });
  });
  // Waiting text is only ever spent by opening a chat, so without this a share
  // cannot be abandoned short of sending it somewhere.
  $("share-notice-dismiss").addEventListener("click", discardPendingShare);
  installPullToRefresh($("sessions-body"), $("sessions-ptr"), () =>
    refreshSessions(true, true),
  );

  // Changing harness re-populates the models, efforts and permission row: the
  // lists have nothing in common, and a leftover selection would be sent as a
  // model the new CLI has never heard of. The workspace only follows when that
  // agent has one remembered, so an unused agent keeps whatever is typed.
  $("nc-harness").addEventListener("change", () => {
    const harness = selectedHarness();
    const remembered = agentDefaults[harness];
    activateHarnessOptions(harness, remembered);
    if (remembered?.cwd) $<HTMLInputElement>("nc-cwd").value = remembered.cwd;
    renderFavoriteToggle();
  });
  $("nc-model").addEventListener("change", () => {
    renderEffortOptions(
      selectedHarness(),
      $<HTMLSelectElement>("nc-model").value,
    );
    renderFavoriteToggle();
  });
  $("nc-effort").addEventListener("change", renderFavoriteToggle);
  $("nc-permission").addEventListener("change", renderFavoriteToggle);
  $("nc-cwd").addEventListener("input", renderFavoriteToggle);
  $("nc-cancel").addEventListener("click", closeNewChatModal);
  $("nc-favorites-toggle").addEventListener("click", toggleFavoritesCollapsed);
  $("nc-favorite").addEventListener(
    "click",
    () => void toggleFavoriteFromDialog(),
  );
  $("nc-create").addEventListener("click", () => void createNewChat());

  $("chat-back").addEventListener("click", () => openSessionsView());
  $("chat-menu-btn").addEventListener("click", () => {
    if ($("chat-menu").hidden) openChatMenu();
    else closeChatMenu();
  });
  $("chat-menu").addEventListener("click", (e) => {
    // The scrim dismisses; the sheet keeps its own taps.
    if ((e.target as HTMLElement).id === "chat-menu") closeChatMenu();
  });
  $("chat-menu-refresh").addEventListener(
    "click",
    () => void refreshOpenChat(),
  );
  $("chat-menu-session-data").addEventListener("click", () => {
    const path = chat.rolloutPath;
    if (!path) return;
    closeChatMenu();
    openFileChooser(path, null);
  });
  $("chat-menu-session-pretty").addEventListener("click", () => {
    closeChatMenu();
    void openPrettySessionFile();
  });
  $("chat-menu-filters").addEventListener("click", () => openFiltersModal());
  $("chat-menu-details").addEventListener("click", () => {
    closeChatMenu();
    openChatSessionDetails();
  });
  $("chat-menu-close").addEventListener("click", () => {
    closeChatMenu();
    void toggleOpenSessionClosed();
  });
  $("chat-menu-delete").addEventListener("click", () => {
    closeChatMenu();
    deleteOpenSession();
  });
  $("filters-list").addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (!box.dataset.filter) return;
    toggleFilter(box.dataset.filter, box.checked);
  });
  $("filters-reset").addEventListener("click", () => {
    saveFilters([]);
    renderFiltersModal();
  });
  $("filters-defaults").addEventListener("click", () => {
    saveFilters(defaultHidden(chat.harness));
    renderFiltersModal();
  });
  $("filters-close").addEventListener("click", () =>
    show($("modal-filters"), false),
  );
  $("chat-session").addEventListener("click", openChatSessionDetails);
  $("alert-close").addEventListener("click", () =>
    show($("modal-alert"), false),
  );
  $("confirm-ok").addEventListener("click", () => closeConfirm(true));
  $("confirm-cancel").addEventListener("click", () => closeConfirm(false));
  // Every way out but the one button is a no.
  $("modal-confirm").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "modal-confirm") closeConfirm(false);
  });
  $("raw-close").addEventListener("click", () => show($("modal-raw"), false));
  $("raw-copy").addEventListener("click", () => {
    void writeText($("raw-body").textContent ?? "").then(
      () => toast("Raw entry copied"),
      () => toast("Copy failed"),
    );
  });
  $("details-cancel").addEventListener("click", () =>
    show($("modal-details"), false),
  );
  $("details-save").addEventListener("click", () => void saveSessionDetails());
  for (const id of ["details-name", "details-label"]) {
    $<HTMLInputElement>(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void saveSessionDetails();
      }
    });
  }
  $("chat-interrupt").addEventListener("click", () => void interruptTurn());
  // Forced: the whole point is that the view is nowhere near the bottom, and
  // the unforced path would decline.
  $("scroll-bottom").addEventListener("click", () =>
    transcript.scrollToBottom(true),
  );
  $("context-pill").addEventListener("click", () => openContextModal());
  for (const id of ["ctx-codex-usage-note", "ctx-claude-usage-note"]) {
    $(id).addEventListener("click", (event) => {
      const link = (event.target as HTMLElement | null)?.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      event.preventDefault();
      event.stopPropagation();
      const href = link.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(href)) return;
      void openUrl(href).catch((err) =>
        toast(`Could not open the link: ${String(err)}`),
      );
    });
  }
  $("ctx-close").addEventListener("click", () =>
    show($("modal-context"), false),
  );

  $("openfile-editor").addEventListener("click", () => {
    const choice = openFileChoice;
    if (!choice) return;
    closeFileChooser();
    openPathInEditor(choice.path, choice.line);
  });
  $("openfile-download").addEventListener("click", () => {
    const choice = openFileChoice;
    if (!choice) return;
    void downloadAndOpen(choice.path);
  });
  $("openfile-save").addEventListener("click", () => {
    const choice = openFileChoice;
    if (!choice) return;
    void downloadAndSave(choice.path);
  });
  $("openfile-cancel").addEventListener("click", closeFileChooser);

  const input = $<HTMLTextAreaElement>("composer-input");
  const autoGrow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  };
  input.addEventListener("input", () => {
    autoGrow();
    syncComposerDraft(input.value);
  });
  input.addEventListener("focus", () => {
    // Give the IME a beat to open before chasing the bottom.
    setTimeout(() => transcript.scrollToBottom(true), 300);
  });
  input.addEventListener("keydown", (e) => {
    if (
      e.key !== "Enter" ||
      e.isComposing ||
      e.shiftKey ||
      (!sendOnEnter && !(e.ctrlKey || e.metaKey))
    ) {
      return;
    }
    e.preventDefault();
    $<HTMLFormElement>("composer").requestSubmit();
  });

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || chat.turnActive || input.disabled) return;
    void sendFromComposer(text);
  });

  // The hold's own click-swallowing is what keeps the release from also
  // submitting the form.
  attachHoldMenu($("composer-send"), openComposerMenu);

  $("drafts-close").addEventListener("click", () =>
    show($("modal-drafts"), false),
  );
  $("draft-use-cancel").addEventListener("click", () =>
    closeDraftUseModal(null),
  );
  $("draft-use-keep").addEventListener("click", () =>
    closeDraftUseModal(false),
  );
  $("draft-use-remove").addEventListener("click", () =>
    closeDraftUseModal(true),
  );
  $("draft-name-cancel").addEventListener("click", () => {
    draftNameAction = null;
    show($("modal-draft-name"), false);
  });
  $("draft-name-save").addEventListener("click", () => void submitDraftName());
  $<HTMLInputElement>("draft-name-input").addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void submitDraftName();
      }
    },
  );

  $("drawer").addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.id === "drawer") {
      show($("drawer"), false);
      return;
    }
    const link = target.closest("a[href]");
    if (link instanceof HTMLAnchorElement) {
      e.preventDefault();
      e.stopPropagation();
      const href = link.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(href)) return;
      show($("drawer"), false);
      void openUrl(href).catch((err) =>
        toast(`Could not open the link: ${String(err)}`),
      );
      return;
    }
    const action = target.dataset.action;
    if (action) void handleDrawerAction(action);
  });

  $<HTMLSelectElement>("set-theme").addEventListener("change", (e) => {
    chooseTheme((e.target as HTMLSelectElement).value as ThemeChoice);
  });
  $<HTMLSelectElement>("set-chat-font-size").addEventListener("change", (e) => {
    chooseChatFontSize(
      Number((e.target as HTMLSelectElement).value) as ChatFontSize,
    );
  });
  $<HTMLInputElement>("set-send-on-enter").addEventListener("change", (e) => {
    chooseSendOnEnter((e.target as HTMLInputElement).checked);
  });
  $<HTMLInputElement>("set-maintenance").addEventListener("change", (e) => {
    chooseMaintenanceMode((e.target as HTMLInputElement).checked);
  });
  $<HTMLInputElement>("set-drafts-path").addEventListener("change", (e) => {
    chooseDraftPromptsPath((e.target as HTMLInputElement).value.trim());
  });
  $("preferences-close").addEventListener("click", () =>
    show($("modal-preferences"), false),
  );
  // Only the "system" theme follows the OS while the app is open.
  osPrefersLight.addEventListener("change", () => {
    if (theme === "system") applyTheme();
  });

  $("diag-close").addEventListener("click", () =>
    show($("modal-diagnostics"), false),
  );
  $("diag-clear").addEventListener("click", () => {
    void api.clearDiagnostics().then(() => {
      $("diag-body").textContent = "";
      toast("Diagnostics cleared");
    });
  });
  $("diag-copy").addEventListener("click", () => {
    void writeText($("diag-body").textContent ?? "").then(
      () => toast("Diagnostics copied"),
      () => toast("Copy failed"),
    );
  });

  // Escape is the desktop equivalent of Android's back button and runs the
  // same rule.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (navigateBack()) e.preventDefault();
  });

  // The layer handler runs first, so a key pressed with a dialog in front of
  // it belongs to the dialog.
  document.addEventListener("keydown", handleLayerKeys);
  document.addEventListener("keydown", handleShortcut);
}

async function main(): Promise<void> {
  transcript = new Transcript(
    $("transcript"),
    toast,
    resendPrompt,
    openTappedPath,
    forwardPrompt,
    openRawModal,
    hideActionFor,
    resolveTranscriptImage,
    rewindActionFor,
    restartActionFor,
  );
  // Solid at either end of the conversation, ghosted in the middle where it
  // lies over what the reader came to read.
  transcript.onEdgeChange((edge) => {
    $("chat-status").classList.toggle("dimmed", edge === "middle");
  });
  transcript.onAwayFromBottom((away) => {
    $("scroll-bottom").classList.toggle("on", away);
  });
  watchChatStatusHeight();
  installViewportHandling();
  // Before the first screen is shown: this measures the padding that keeps the
  // header and the composer out from under the system bars.
  installSystemInsets();
  // Before anything is awaited: the stored choice is a round trip away and the
  // default is to follow the OS, so resolving that much now means a light phone
  // never shows the dark background while the state file is being read.
  applyTheme();
  wireEvents();
  // Installed before the connect flow is awaited: a back press during a slow
  // handshake would otherwise find no handler and close the app.
  window.__pabloBack = navigateBack;

  // Keep "5 mins ago" honest while a screen sits open.
  window.setInterval(refreshRelativeLabels, 30_000);
  // Turn processes live on the host, so the picker stays accurate after
  // switching away from a chat or rebuilding the webview.
  window.setInterval(() => {
    if (isScreen("sessions")) void refreshSessions();
  }, 1_500);

  window.addEventListener("unhandledrejection", (e) => {
    void api.logClient("unhandled", String(e.reason));
  });

  // Rust and its foreground service can survive an Android WebView rebuild,
  // but this new page has no corresponding follow loop. Release any watch the
  // previous JavaScript instance owned before restoring the session picker.
  try {
    await api.resetWatch();
  } catch (err) {
    void api.logClient(
      "watch",
      `stale background monitoring cleanup failed: ${err}`,
    );
  }
  const persisted = await api.loadState();
  settings = persisted.settings;
  transcriptFilters = persisted.transcriptFilters;
  applyTranscriptFilters();
  theme = persisted.theme;
  applyTheme();
  chatFontSize = persisted.chatFontSize;
  applyChatFontSize();
  sendOnEnter = persisted.sendOnEnter;
  applySendOnEnter();
  maintenanceMode = persisted.maintenanceMode;
  renderDrawerMaintenanceItems();
  favoritesCollapsed = persisted.favoritesCollapsed;
  draftPromptsPath = persisted.draftPromptsPath;
  fillConnectForm(settings);

  if (settings?.host && settings.username && settings.password) {
    // Android tears the webview down and rebuilds it when the app comes back to
    // the foreground, but the Rust side, and with it the SSH session, usually
    // survives. Reuse a live connection rather than paying for a fresh handshake.
    let live = false;
    try {
      live = await api.isConnected();
    } catch {
      live = false;
    }
    if (live) {
      overlay("Loading sessions…");
      // The probe result has to be fetched rather than remembered, or the
      // new-chat dialog would offer a harness this host may not have.
      const info = await api.connectionInfo().catch(() => null);
      if (info) capabilities = info.capabilities;
      await refreshSessions(true);
      overlay(null);
      goto("sessions");
    } else {
      await doConnect(settings);
    }
  } else {
    goto("connect");
  }

  // Runs after the connect flow so a share that cold-started the app finds the
  // session picker already in front of the notice it triggers.
  window.__pabloSharedText = handleSharedText;
  handleSharedText();
}

void main().catch((err) => {
  overlay(null);
  goto("connect");
  showConnectError("The app failed to start", err);
});
