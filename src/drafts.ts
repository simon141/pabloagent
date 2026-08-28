export interface DraftPrompt {
  id: string;
  prompt: string;
  harness: string;
  model: string;
  effort: string;
  cwd: string;
  permissionMode: string;
  createdAt: string;
}

const KEYS = [
  "harness",
  "model",
  "effort",
  "cwd",
  "permissionMode",
  "createdAt",
] as const;

const NEEDS_QUOTING = /^$|^\s|\s$|\n|:\s|:$|^[-?:,[\]{}#&*!|>%@`"']/;

function writeScalar(value: string): string {
  if (!NEEDS_QUOTING.test(value)) return value;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function readScalar(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\nt])/g, (_, c: string) =>
        c === "n" ? "\n" : c === "t" ? "\t" : c,
      );
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

export function formatDraft(draft: Omit<DraftPrompt, "id">): string {
  const lines = ["---"];
  for (const key of KEYS) {
    const value = draft[key];
    if (value) lines.push(`${key}: ${writeScalar(value)}`);
  }
  lines.push("---", "", draft.prompt.trim(), "");
  return lines.join("\n");
}

function splitFrontMatter(raw: string): {
  fields: Record<string, string>;
  body: string;
} {
  const text = raw.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const close =
    lines[0]?.trim() === "---"
      ? lines.findIndex((line, i) => i > 0 && line.trim() === "---")
      : -1;
  if (close < 0) return { fields: {}, body: text.trim() };
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) continue;
    const colon = entry.indexOf(":");
    if (colon <= 0) continue;
    const key = entry.slice(0, colon).trim();
    if (key && !(key in fields)) {
      fields[key] = readScalar(entry.slice(colon + 1).trim());
    }
  }
  return {
    fields,
    body: lines
      .slice(close + 1)
      .join("\n")
      .trim(),
  };
}

export function parseDraft(id: string, text: string): DraftPrompt {
  const { fields, body } = splitFrontMatter(text);
  const field = (key: string) => fields[key] ?? "";
  return {
    id,
    prompt: body,
    harness: field("harness"),
    model: field("model"),
    effort: field("effort"),
    cwd: field("cwd"),
    permissionMode: field("permissionMode"),
    createdAt: field("createdAt"),
  };
}

export function parseTextDraft(id: string, text: string): DraftPrompt {
  return {
    id,
    prompt: text.replace(/\r\n?/g, "\n").trim(),
    harness: "",
    model: "",
    effort: "",
    cwd: "",
    permissionMode: "",
    createdAt: "",
  };
}
