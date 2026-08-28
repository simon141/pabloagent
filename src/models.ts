import { DEFAULT_HARNESS, type Harness } from "./harness";
import type { PiModel } from "./types";

export interface ModelChoice {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
}

const CONFIG_EFFORTS = ["low", "medium", "high", "xhigh"];

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const CODEX_MODELS: ModelChoice[] = [
  {
    id: "",
    label: "Server default (config.toml)",
    efforts: CONFIG_EFFORTS,
    defaultEffort: "",
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6-Terra",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6-Luna",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "xhigh",
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4-Mini",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
  },
];

const CLAUDE_MODELS: ModelChoice[] = [
  {
    id: "",
    label: "Server default (settings.json)",
    efforts: CLAUDE_EFFORTS,
    defaultEffort: "",
  },
  { id: "fable", label: "Fable", efforts: CLAUDE_EFFORTS, defaultEffort: "" },
  { id: "opus", label: "Opus", efforts: CLAUDE_EFFORTS, defaultEffort: "" },
  {
    id: "opus[1m]",
    label: "Opus (1M context)",
    efforts: CLAUDE_EFFORTS,
    defaultEffort: "",
  },
  { id: "sonnet", label: "Sonnet", efforts: CLAUDE_EFFORTS, defaultEffort: "" },
  {
    id: "sonnet[1m]",
    label: "Sonnet (1M context)",
    efforts: CLAUDE_EFFORTS,
    defaultEffort: "",
  },
  { id: "haiku", label: "Haiku", efforts: CLAUDE_EFFORTS, defaultEffort: "" },
];

const OPENCODE_EFFORTS = ["minimal", "low", "medium", "high", "max"];

const OPENCODE_MODELS: ModelChoice[] = [
  {
    id: "",
    label: "Server default (opencode.json)",
    efforts: OPENCODE_EFFORTS,
    defaultEffort: "",
  },
  {
    id: "anthropic/claude-fable-5",
    label: "Fable 5 (Anthropic)",
    efforts: OPENCODE_EFFORTS,
    defaultEffort: "",
  },
  {
    id: "anthropic/claude-sonnet-5",
    label: "Sonnet 5 (Anthropic)",
    efforts: OPENCODE_EFFORTS,
    defaultEffort: "",
  },
  {
    id: "openai/gpt-5.6-sol",
    label: "GPT-5.6-Sol (OpenAI)",
    efforts: OPENCODE_EFFORTS,
    defaultEffort: "",
  },
  {
    id: "openai/gpt-5.5",
    label: "GPT-5.5 (OpenAI)",
    efforts: OPENCODE_EFFORTS,
    defaultEffort: "",
  },
  {
    id: "opencode/big-pickle",
    label: "Big Pickle (opencode zen)",
    efforts: OPENCODE_EFFORTS,
    defaultEffort: "",
  },
];

const PI_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const PI_MODELS: ModelChoice[] = [
  {
    id: "",
    label: "Server default (pi settings)",
    efforts: PI_EFFORTS,
    defaultEffort: "",
  },
];

export function piModelChoices(models: PiModel[]): ModelChoice[] {
  return [
    ...PI_MODELS,
    ...models.map((model) => ({
      id: model.id,
      label: model.id,
      efforts: model.thinking ? PI_EFFORTS : [],
      defaultEffort: "",
    })),
  ];
}

const MODELS_BY_HARNESS: Record<Harness, ModelChoice[]> = {
  codex: CODEX_MODELS,
  claude: CLAUDE_MODELS,
  opencode: OPENCODE_MODELS,
  pi: PI_MODELS,
};

export function modelsFor(
  harness: Harness | null | undefined,
  piModels?: ModelChoice[] | null,
): ModelChoice[] {
  if (harness === "pi" && piModels) return piModels;
  return MODELS_BY_HARNESS[harness ?? DEFAULT_HARNESS] ?? CODEX_MODELS;
}

export function modelById(
  harness: Harness | null | undefined,
  id: string | null | undefined,
  piModels?: ModelChoice[] | null,
): ModelChoice {
  const models = modelsFor(harness, piModels);
  return models.find((m) => m.id === (id ?? "")) ?? models[0];
}
