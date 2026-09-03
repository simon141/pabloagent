import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type DiffLine, diffLines, diffText } from "./diff";
import { anchorMenu, type MenuAnchor } from "./platform";
import { execSnippet, execSummary, isExploratoryCommand } from "./rollout";
import type {
  Delivery,
  EmbeddedImage,
  ThreadItem,
  UserInputContent,
} from "./types";

interface ItemView {
  el: HTMLElement;
  item: ThreadItem;

  open?: boolean;
}

interface BubbleAction {
  label: string;
  run: () => void | Promise<void>;

  disabled?: boolean;
  danger?: boolean;
}

export type ScrollEdge = "top" | "bottom" | "both" | "middle";

const EDGE_SLACK = 12;

const MAX_ZOOM = 8;

const TAP_SLOP = 12;

interface ViewerZoom {
  img: HTMLImageElement;
  overlay: HTMLElement;
  scale: number;
  tx: number;
  ty: number;

  raster: number;
  settleTimer: number;
  points: Map<number, { x: number; y: number }>;
  span: number;
  mid: { x: number; y: number };
  moved: number;
  pinched: boolean;
  ignoreClick: boolean;
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function anchor(url: string, label: string): string {
  const href = /^www\./i.test(url) ? `https://${url}` : url;
  if (!/^https?:\/\//i.test(href)) return label;
  return `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`;
}

function splitTrailingPunctuation(
  raw: string,
  emphasis = false,
): { url: string; trail: string } {
  const punctuation = emphasis ? /[.,;:!?'"*_~]$/ : /[.,;:!?'"*]$/;
  let url = raw;
  let trail = "";
  for (;;) {
    const entity = url.match(/(&quot;|&#39;|&gt;|&lt;)$/);
    if (entity) {
      trail = entity[0] + trail;
      url = url.slice(0, -entity[0].length);
      continue;
    }
    // `*` counts as trailing: a URL written as `**bold**` swallows its closing
    // stars, and handing them back lets the emphasis pass find its pair again.
    const punct = url.match(punctuation);
    if (punct) {
      // `…&amp;`, the semicolon closes an entity, so the URL keeps it.
      if (punct[0] === ";" && /&[a-zA-Z#][a-zA-Z0-9]*$/.test(url.slice(0, -1)))
        break;
      trail = punct[0] + trail;
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return { url, trail };
}

const URL_IN_TEXT =
  /(^|[\s('*_~‘“]|&quot;|&#39;|&lt;)((?:https?:\/\/|www\.)[^\s<)]+)/gi;

function linkifyUrls(
  escaped: string,
  opts: { wrap?: (html: string) => string; code?: boolean } = {},
): string {
  const wrap = opts.wrap ?? ((html: string) => html);
  return escaped.replace(URL_IN_TEXT, (whole, before, raw) => {
    const { url, trail } = splitTrailingPunctuation(String(raw), true);
    const built = anchor(url, url);
    if (!built.startsWith("<a ")) return whole;
    // In `<https://…>` the angle brackets are markdown syntax, so prose drops
    // the pair. In code they are characters somebody typed and they stay.
    if (!opts.code && before === "&lt;" && trail.startsWith("&gt;")) {
      return `${wrap(built)}${trail.slice(4)}`;
    }
    return `${before}${wrap(built)}${trail}`;
  });
}

interface FilePathMatch {
  path: string;
  line: number | null;
}

const PATH_BODY = /^\/(?:[\w.@+-]+\/)+[\w.@+-]*$/;

const PATH_BODY_SPACED =
  /^\/(?:[\w.@+-]+(?: [\w.@+-]+)*\/)+[\w.@+-]+(?: [\w.@+-]+)*$/;

const SPACED_MAX_SPACES = 3;

function hasFileExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  const ext = name.slice(dot + 1);
  return /^[A-Za-z0-9]{1,12}$/.test(ext) && /[A-Za-z]/.test(ext);
}

function spacedPathIsCredible(body: string): boolean {
  const words = body.split(" ");
  if (words.length - 1 > SPACED_MAX_SPACES) return false;
  if (words.some((word) => word.startsWith("-"))) return false;
  return hasFileExtension(body);
}

const SANDBOX_SCHEME = /^sandbox:(?=\/)/i;

function filePathIn(
  raw: string,
  opts: { spaces?: boolean } = {},
): FilePathMatch | null {
  if (!raw || raw.length > 4096) return null;
  let body = raw.replace(SANDBOX_SCHEME, "");
  let line: number | null = null;
  // `file.ts:42` and `file.ts:42:9` both name a line. The column is dropped:
  // nothing downstream can place a caret from here.
  const suffix = body.match(/:(\d{1,9})(?::\d{1,9})?$/);
  if (suffix) {
    body = body.slice(0, -suffix[0].length);
    line = Number(suffix[1]);
  }
  if (PATH_BODY.test(body)) return { path: body, line };
  // The spaced form is tried second and only when asked for.
  if (!opts.spaces) return null;
  if (!PATH_BODY_SPACED.test(body) || !spacedPathIsCredible(body)) return null;
  return { path: body, line };
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function pathSpan(escapedLabel: string, match: FilePathMatch): string {
  const line = match.line === null ? "" : ` data-line="${match.line}"`;
  return (
    `<span class="filepath" role="link" tabindex="0"` +
    ` data-path="${escapeHtml(match.path)}"${line}>${escapedLabel}</span>`
  );
}

function imagePlaceholder(path: string, escapedAlt: string): string {
  return (
    `<span class="md-img" data-img-src="${escapeHtml(path)}"` +
    ` data-img-alt="${escapedAlt}">Loading image…</span>`
  );
}

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;

const PATH_IN_TEXT =
  /((?:^|\n)\s*(?:[-+\u2022]|\d+[.)])\s*|^|[\s([*~'\u2018\u201c]|&quot;|&#39;)((?:sandbox:)?\/[\w.@+\-/]*[\w@+-](?::\d{1,9}){0,2})/g;

function linkifyPaths(
  escaped: string,
  opts: { wrap?: (html: string) => string; code?: boolean } = {},
): string {
  const wrap = opts.wrap ?? ((html: string) => html);
  return escaped.replace(PATH_IN_TEXT, (whole, before, raw) => {
    const { url: text, trail } = splitTrailingPunctuation(String(raw));
    const match = filePathIn(unescapeHtml(text));
    if (!match) return whole;
    const built =
      !opts.code && match.line === null && IMAGE_EXT.test(match.path)
        ? imagePlaceholder(match.path, text)
        : pathSpan(text, match);
    return `${before}${wrap(built)}${trail}`;
  });
}

function fencedCode(escaped: string): string {
  const body = escaped.trim();
  if (body.includes(" ")) {
    const whole = filePathIn(unescapeHtml(body), { spaces: true });
    if (whole) {
      const lead = escaped.slice(
        0,
        escaped.length - escaped.trimStart().length,
      );
      const tail = escaped.slice(escaped.trimEnd().length);
      return `${lead}${pathSpan(body, whole)}${tail}`;
    }
  }

  const parts: string[] = [];
  const stash = (html: string) => `\u0000${parts.push(html) - 1}\u0000`;
  let html = linkifyUrls(escaped, { code: true, wrap: stash });
  html = linkifyPaths(html, { code: true, wrap: stash });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL brackets a stashed span, and cannot occur in the escaped HTML it replaces
  return html.replace(/\u0000(\d+)\u0000/g, (_m, i) => parts[Number(i)] ?? "");
}

function inlineMarkdown(escaped: string): string {
  const parts: string[] = [];
  const stash = (html: string) => `\u0000${parts.push(html) - 1}\u0000`;

  // A code span keeps its `<code>` look and gains the file or link affordance;
  // an image path becomes the image itself. The span is measured whole, so a
  // command with an argument is not read as a path with a space in it.
  let html = escaped.replace(/`([^`\n]+)`/g, (_m, body) => {
    const label = String(body);
    const match = filePathIn(unescapeHtml(label), { spaces: true });
    if (match?.line === null && IMAGE_EXT.test(match.path)) {
      return stash(imagePlaceholder(match.path, label));
    }
    const inner = match
      ? pathSpan(label, match)
      : linkifyUrls(label, { code: true });
    return stash(`<code>${inner}</code>`);
  });

  // ![alt](target), before the link pass, whose regex would otherwise claim
  // the `[alt](target)` inside it. A `data:image/…` URL becomes an <img>
  // directly; an absolute path becomes a placeholder the hydrator fills in;
  // anything else degrades to the link rules the text would get without the
  // `!`.
  html = html.replace(
    /!\[([^\]\n]*)\]\(\s*([^\s)]+)\s*\)/g,
    (whole, alt, target) => {
      const label = String(alt);
      const raw = unescapeHtml(String(target));
      const data = raw.match(/^data:(image\/[\w.+-]+);base64,[A-Za-z0-9+/=]+$/);
      if (data) {
        return stash(
          `<img class="chat-img" src="${raw}" alt="${label || "image"}" loading="lazy">`,
        );
      }
      const match = filePathIn(raw);
      if (match && match.line === null) {
        return stash(imagePlaceholder(match.path, label));
      }
      const built = anchor(String(target), label || String(target));
      return built.startsWith("<a ") ? stash(built) : whole;
    },
  );

  // [label](url), an absolute path target gets the same treatment it would
  // bare, rather than falling through as literal brackets and parens.
  html = html.replace(
    /\[([^\]\n]*)\]\(\s*([^\s)]+)\s*\)/g,
    (whole, label, url) => {
      const text = String(label);
      const match = filePathIn(unescapeHtml(String(url)));
      if (match) {
        // A link to a picture is a picture, models drop the `!`, but only
        // without a `:12` suffix: a line number means a location in a file.
        if (match.line === null && IMAGE_EXT.test(match.path)) {
          return stash(imagePlaceholder(match.path, text));
        }
        // An empty label falls back to the path.
        return stash(pathSpan(text || escapeHtml(match.path), match));
      }
      const built = anchor(String(url), text || String(url));
      return built.startsWith("<a ") ? stash(built) : whole;
    },
  );

  // Bare URLs, stashed so nothing below reaches inside the anchor.
  html = linkifyUrls(html, { wrap: stash });

  // Bare paths in prose, after the URL passes so the path part of a linked
  // URL is already stashed out of reach.
  html = linkifyPaths(html, { wrap: stash });

  html = html.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  // A code span inside a link label leaves a placeholder inside a placeholder,
  // and one replace pass does not rescan what it inserted.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL brackets a stashed span, and cannot occur in the escaped HTML it replaces
  for (let pass = 0; pass < 3 && /\u0000\d+\u0000/.test(html); pass += 1) {
    html = html.replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the same span sentinel, one pass deeper
      /\u0000(\d+)\u0000/g,
      (_m, i) => parts[Number(i)] ?? "",
    );
  }
  return html;
}

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      cur += "|";
      i += 1;
    } else if (line[i] === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += line[i];
    }
  }
  cells.push(cur);
  if (cells.length > 1 && !cells[0].trim()) cells.shift();
  if (cells.length > 1 && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map((c) => c.trim());
}

function delimiterRow(line: string): Array<string | null> | null {
  if (!line?.includes("|")) return null;
  const aligns: Array<string | null> = [];
  for (const cell of splitRow(line.trim())) {
    const m = cell.match(/^(:?)-+(:?)$/);
    if (!m) return null;
    aligns.push(
      m[1] && m[2] ? "center" : m[2] ? "right" : m[1] ? "left" : null,
    );
  }
  return aligns.length ? aligns : null;
}

function matchTable(
  lines: string[],
  start: number,
): { html: string; end: number } | null {
  const header = lines[start];
  if (!header?.includes("|")) return null;
  const aligns = delimiterRow(lines[start + 1] ?? "");
  if (!aligns) return null;
  const heads = splitRow(header.trim());
  // GFM throws the table away when the two rows disagree, and so do we.
  if (heads.length !== aligns.length) return null;

  const rows: string[][] = [];
  let end = start + 1;
  for (let i = start + 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || !line.includes("|")) break;
    const cells = splitRow(line.trim());
    // A ragged row is padded and its overflow dropped, so the cells that do
    // exist still land under the right headings.
    rows.push(Array.from({ length: heads.length }, (_, c) => cells[c] ?? ""));
    end = i;
  }

  const cell = (tag: "th" | "td", text: string, align: string | null) =>
    `<${tag}${align ? ` class="${align}"` : ""}>${inlineMarkdown(text)}</${tag}>`;
  const row = (tag: "th" | "td", cells: string[]) =>
    `<tr>${cells.map((t, c) => cell(tag, t, aligns[c])).join("")}</tr>`;

  const body = rows.length
    ? `<tbody>${rows.map((r) => row("td", r)).join("")}</tbody>`
    : "";
  return {
    html: `<div class="md-table"><table><thead>${row("th", heads)}</thead>${body}</table></div>`,
    end,
  };
}

type OpenList = {
  tag: "ul" | "ol";
  indent: number;
  start: number | null;
  items: string[][];
  blanks: number;
};

const LIST_ITEM = /^([ \t]*)(?:([-*+•])|(\d+)[.)])([ \t]+)(.*)$/;

const HR_LINE = /^\s*(?:[-*_]\s*){3,}$/;

const indentOf = (line: string) => line.length - line.trimStart().length;

function matchListItem(line: string): {
  tag: "ul" | "ol";
  indent: number;
  number: number | null;
  text: string;
} | null {
  const m = line.match(LIST_ITEM);
  if (!m) return null;
  return {
    tag: m[2] ? "ul" : "ol",
    indent: m[1].length,
    number: m[3] ? Number(m[3]) : null,
    text: m[5],
  };
}

function dedentFence(body: string, indent: string): string {
  const trimmed = body.replace(/\n[ \t]*$/, "");
  if (!indent) return trimmed;
  return trimmed
    .split("\n")
    .map((line) => {
      let k = 0;
      while (k < indent.length && (line[k] === " " || line[k] === "\t")) k += 1;
      return line.slice(k);
    })
    .join("\n");
}

function dedentItem(lines: string[]): string[] {
  let min = Number.POSITIVE_INFINITY;
  for (const line of lines.slice(1)) {
    if (line.trim()) min = Math.min(min, indentOf(line));
  }
  if (!Number.isFinite(min) || min === 0) return lines;
  return lines.map((line, i) => (i === 0 ? line : line.slice(min)));
}

function renderItem(lines: string[], fences: string[]): string {
  const html = renderBlocks(dedentItem(lines), fences);
  const only = html.match(/^<p>([\s\S]*)<\/p>$/);
  return only && !only[1].includes("<p>") ? only[1] : html;
}

function renderBlocks(lines: string[], fences: string[]): string {
  const out: string[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let list: OpenList | null = null;

  const flushPara = () => {
    if (!para.length) return;
    out.push(
      `<p>${inlineMarkdown(para.join("\n")).replace(/\n/g, "<br>")}</p>`,
    );
    para = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(
      `<blockquote>${inlineMarkdown(quote.join("\n")).replace(/\n/g, "<br>")}</blockquote>`,
    );
    quote = [];
  };
  const flushList = () => {
    if (!list) return;
    // `start` keeps the numbers right across a list that splits.
    const start =
      list.tag === "ol" && list.start !== null && list.start !== 1
        ? ` start="${list.start}"`
        : "";
    const items = list.items
      .map((item) => `<li>${renderItem(item, fences)}</li>`)
      .join("");
    out.push(`<${list.tag}${start}>${items}</${list.tag}>`);
    list = null;
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    flushList();
  };

  // Indexed rather than for-of: tables need lookahead and the ability to skip
  // past a block already consumed.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // An open list sees the line first: a heading, table, rule or fence
    // indented under an item is that item's content, not a sibling block.
    if (list) {
      if (!line.trim()) {
        list.blanks += 1;
        continue;
      }
      if (indentOf(line) > list.indent) {
        const item = list.items[list.items.length - 1];
        // The held blanks turn out to have been inside the item.
        for (let b = 0; b < list.blanks; b += 1) item.push("");
        list.blanks = 0;
        item.push(line);
        continue;
      }
      // Back at the list's own indent, only another item of the same kind
      // continues it. The rule is tested first, as below: `- - -` is a rule.
      const sibling = HR_LINE.test(line) ? null : matchListItem(line);
      if (sibling && sibling.tag === list.tag) {
        list.blanks = 0;
        list.items.push([sibling.text]);
        continue;
      }
      flushList();
    }

    // biome-ignore lint/suspicious/noControlCharactersInRegex: U+0001 is the fence sentinel, and cannot occur in the source
    const fence = line.match(/^\s*(\d+)\s*$/);
    if (fence) {
      flushAll();
      out.push(fences[Number(fence[1])] ?? "");
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      // Bubble headings start at h3, nothing in a chat bubble is a page title.
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    // Checked before list items so `- - -` is a rule, not a bullet.
    if (HR_LINE.test(line)) {
      flushAll();
      out.push("<hr>");
      continue;
    }
    const table = matchTable(lines, i);
    if (table) {
      flushAll();
      out.push(table.html);
      i = table.end;
      continue;
    }
    const quoted = line.match(/^\s*&gt;\s?(.*)$/);
    if (quoted) {
      flushPara();
      quote.push(quoted[1]);
      continue;
    }
    flushQuote();
    const item = matchListItem(line);
    if (item) {
      flushPara();
      list = {
        tag: item.tag,
        indent: item.indent,
        start: item.number,
        items: [[item.text]],
        blanks: 0,
      };
      continue;
    }
    para.push(line);
  }
  flushAll();
  return out.join("");
}

function formatMarkdown(text: string): string {
  const fences: string[] = [];
  // Fenced code comes out first so nothing inside it is read as markdown,
  // beyond the URL and path linking `fencedCode` does itself.
  const source = escapeHtml(text).replace(
    /```([\w+-]*)\n?([\s\S]*?)```/g,
    (_m, _lang, body, offset: number, whole: string) => {
      // The sentinel replaces the fence alone, so whatever indented it stays in
      // front, which is what keeps a step's fence inside its item.
      const bol = offset === 0 ? 0 : whole.lastIndexOf("\n", offset - 1) + 1;
      const before = whole.slice(bol, offset);
      const indent = /^[ \t]*$/.test(before) ? before : "";
      const code = fencedCode(dedentFence(String(body), indent));
      return `${fences.push(`<pre class="mono wrap">${code}</pre>`) - 1}`;
    },
  );
  return renderBlocks(source.split("\n"), fences);
}

const truncate = (s: string, n: number) =>
  s.length <= n ? s : `${s.slice(0, n)}…`;

const LABEL_MAX = 1000;

const firstLine = (s: string) => (s.split("\n")[0] ?? "").trim();

function userText(content: UserInputContent[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c.type === "text"
        ? String((c as { text?: string }).text ?? "")
        : `[${c.type}]`,
    )
    .filter(Boolean)
    .join("\n");
}

const TICK_PATH = (dx: number) =>
  `<path d="M${1 + dx} 5.6 L${3.25 + dx} 7.79 Q${4.4 + dx} 8.9 ${5.47 + dx} 7.71 ` +
  `L${10.9 + dx} 1.7" fill="none" ` +
  `stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ` +
  `stroke-linejoin="round"/>`;

function buildTicks(delivery: Delivery): HTMLElement {
  const el = document.createElement("span");
  el.className = `ticks ${delivery}`;
  el.setAttribute("role", "status");
  el.setAttribute(
    "aria-label",
    delivery === "sent"
      ? "Sent"
      : delivery === "confirmed"
        ? "Delivered"
        : "Responded",
  );
  const double = delivery !== "sent";
  el.innerHTML =
    `<svg viewBox="0 0 ${double ? 17 : 12.2} 10.8" aria-hidden="true">` +
    `${TICK_PATH(0)}${double ? TICK_PATH(4.8) : ""}</svg>`;
  return el;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export class Transcript {
  private views = new Map<string, ItemView>();

  private bubbleText = new WeakMap<
    HTMLElement,
    { text: () => string; item: ThreadItem }
  >();
  private edge: ScrollEdge = "both";
  private edgeListener: ((edge: ScrollEdge) => void) | null = null;
  private away = false;
  private awayListener: ((away: boolean) => void) | null = null;
  private held = new WeakSet<HTMLElement>();

  private imageHold = new WeakSet<HTMLElement>();
  private bubbleMenu: HTMLElement | null = null;
  private menuReturn: HTMLElement | null = null;
  private onCopy: (msg: string) => void;
  private onResend: ((text: string) => void) | null;

  private rewindAction:
    | ((item: ThreadItem, text: string) => BubbleAction | null)
    | null;
  private restartAction:
    | ((item: ThreadItem, text: string) => BubbleAction | null)
    | null;
  private onForward:
    | ((text: string, target: "new" | "existing") => void)
    | null;
  private onOpenPath: ((path: string, line: number | null) => void) | null;

  private onViewRaw: ((item: ThreadItem, label: string) => void) | null;

  private hideAction:
    | ((item: ThreadItem) => { label: string; run: () => void } | null)
    | null;

  private onImage:
    | ((path: string, itemId: string, fresh: boolean) => Promise<string | null>)
    | null;
  private imageViewer: HTMLElement | null = null;
  private agentName = "Agent";

  private hidden: ((item: ThreadItem) => boolean) | null = null;

  constructor(
    private root: HTMLElement,
    onCopy: (msg: string) => void,
    onResend?: (text: string) => void,
    onOpenPath?: (path: string, line: number | null) => void,
    onForward?: (text: string, target: "new" | "existing") => void,
    onViewRaw?: (item: ThreadItem, label: string) => void,
    hideAction?: (
      item: ThreadItem,
    ) => { label: string; run: () => void } | null,
    onImage?: (
      path: string,
      itemId: string,
      fresh: boolean,
    ) => Promise<string | null>,
    rewindAction?: (item: ThreadItem, text: string) => BubbleAction | null,
    restartAction?: (item: ThreadItem, text: string) => BubbleAction | null,
  ) {
    this.onCopy = onCopy;
    this.onResend = onResend ?? null;
    this.onOpenPath = onOpenPath ?? null;
    this.onForward = onForward ?? null;
    this.onViewRaw = onViewRaw ?? null;
    this.hideAction = hideAction ?? null;
    this.onImage = onImage ?? null;
    this.rewindAction = rewindAction ?? null;
    this.restartAction = restartAction ?? null;

    // Links in model output must never navigate the webview, hand them to
    // the OS browser instead. Delegated, so it covers every bubble ever
    // rendered.
    this.root.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement | null;

      // Images before paths and links, because an image can sit inside either.
      const img = target?.closest?.("img.chat-img") as HTMLImageElement | null;
      if (img?.src) {
        ev.preventDefault();
        ev.stopPropagation();
        this.openImageViewer(img.src, img.alt);
        return;
      }
      const retry = target?.closest?.(
        "span.md-img.failed",
      ) as HTMLElement | null;
      if (retry?.dataset.imgSrc) {
        ev.preventDefault();
        ev.stopPropagation();
        this.hydrateImage(retry, true);
        return;
      }

      // Paths before links: one can sit inside a link's label, and opening
      // the file is the more specific intention.
      const path = target?.closest?.("[data-path]") as HTMLElement | null;
      if (path?.dataset.path) {
        ev.preventDefault();
        ev.stopPropagation();
        const line = Number(path.dataset.line);
        this.onOpenPath?.(
          path.dataset.path,
          Number.isFinite(line) && line > 0 ? line : null,
        );
        return;
      }

      const link = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link) return;
      ev.preventDefault();
      ev.stopPropagation();
      const href = link.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(href)) return;
      void openUrl(href).catch((err) => {
        this.onCopy(`Could not open the link: ${String(err)}`);
      });
    });

    // Passive: it only reads scroll offsets, and saying so keeps it off the
    // critical path of a flick.
    this.root.addEventListener("scroll", () => this.updateScrollState(), {
      passive: true,
    });

    this.confineSelection();

    // A path is a link, so it answers to a keyboard the way one does.
    this.root.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const el = (ev.target as HTMLElement | null)?.closest?.(
        "[data-path]",
      ) as HTMLElement | null;
      if (!el?.dataset.path) return;
      ev.preventDefault();
      const line = Number(el.dataset.line);
      this.onOpenPath?.(
        el.dataset.path,
        Number.isFinite(line) && line > 0 ? line : null,
      );
    });
  }

  private confineSelection(): void {
    const REGION = ".bubble, .card-body, .modal-sheet";

    document.addEventListener("selectionchange", () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0)
        return;
      const { anchorNode, focusNode } = selection;
      if (!anchorNode || !focusNode) return;

      const from =
        anchorNode.nodeType === Node.ELEMENT_NODE
          ? (anchorNode as Element)
          : anchorNode.parentElement;
      const region = from?.closest(REGION);
      // A selection that began outside any region is not this method's
      // business.
      if (!region || region.contains(focusNode)) return;

      // Which way it went out, so the end lands on the near edge.
      const wentUp = Boolean(
        region.compareDocumentPosition(focusNode) &
          Node.DOCUMENT_POSITION_PRECEDING,
      );
      try {
        selection.extend(region, wentUp ? 0 : region.childNodes.length);
      } catch {
        // A range that cannot be extended is left as it is: an odd selection
        // beats throwing out of a listener that fires on every drag frame.
      }
    });
  }

  clear(): void {
    this.closeImageViewer();
    this.views.clear();
    this.root.innerHTML = "";
    // Emptying the element fires no scroll event, without this a chat left
    // scrolled up would hand its state to the next one.
    this.updateScrollState();
  }

  setAgentName(name: string): void {
    this.agentName = name;
  }

  setHidden(hidden: ((item: ThreadItem) => boolean) | null): void {
    this.hidden = hidden;
    for (const view of this.views.values()) this.applyHidden(view);
    this.scrollToBottom(true);
  }

  private applyHidden(view: ItemView): void {
    view.el.hidden = this.hidden ? this.hidden(view.item) : false;
  }

  remove(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    view.el.remove();
    this.views.delete(id);
  }

  private nearBottom(): boolean {
    const slack = 120;
    return (
      this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight <
      slack
    );
  }

  onEdgeChange(listener: (edge: ScrollEdge) => void): void {
    this.edgeListener = listener;
    listener(this.edge);
  }

  private edgeNow(): ScrollEdge {
    const { scrollTop, scrollHeight, clientHeight } = this.root;
    const top = scrollTop <= EDGE_SLACK;
    const bottom = scrollHeight - scrollTop - clientHeight <= EDGE_SLACK;
    if (top && bottom) return "both";
    if (top) return "top";
    if (bottom) return "bottom";
    return "middle";
  }

  private updateScrollState(): void {
    this.updateEdge();
    this.updateAway();
  }

  private updateEdge(): void {
    const edge = this.edgeNow();
    if (edge === this.edge) return;
    this.edge = edge;
    this.edgeListener?.(edge);
  }

  onAwayFromBottom(listener: (away: boolean) => void): void {
    this.awayListener = listener;
    listener(this.away);
  }

  private updateAway(): void {
    const scrollable = this.root.scrollHeight > this.root.clientHeight + 1;
    const away = scrollable && !this.nearBottom();
    if (away === this.away) return;
    this.away = away;
    this.awayListener?.(away);
  }

  scrollToBottom(force = false): void {
    // Asked now rather than inside the frame, so what is followed is where the
    // view was when the content arrived.
    const follow = force || this.nearBottom();
    // rAF so layout has settled after the DOM mutation.
    requestAnimationFrame(() => {
      if (follow) this.root.scrollTop = this.root.scrollHeight;
      // Unconditional, and here as well as on scroll: growing the transcript
      // moves both answers without anybody touching it.
      this.updateScrollState();
    });
  }

  private async copy(text: string, el: HTMLElement): Promise<void> {
    // The "Copied" badge is positioned against `.bubble` / `.card`, so the
    // class has to land there, a card body resolves up to its card.
    const flash = (el.closest(".bubble, .card") as HTMLElement | null) ?? el;
    try {
      await writeText(text);
      flash.classList.add("copied");
      setTimeout(() => flash.classList.remove("copied"), 1100);
      this.onCopy("Copied to clipboard");
    } catch (e) {
      this.onCopy(`Copy failed: ${String(e)}`);
    }
  }

  private closeBubbleMenu(): void {
    this.bubbleMenu?.remove();
    this.bubbleMenu = null;
    const back = this.menuReturn;
    this.menuReturn = null;
    if (!back) return;
    // A frame later, so an item chosen with Enter cannot have its keypress
    // land on whatever focus goes back to, a card header is a button, and it
    // would toggle the card shut on the way out.
    requestAnimationFrame(() => {
      // Not if something else has taken focus, and not if the transcript has
      // been rebuilt underneath it. The menu's own items do not count: a
      // removed element stays `activeElement` for a moment after it goes.
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active.isConnected
      ) {
        return;
      }
      if (back.isConnected) back.focus({ preventScroll: true });
    });
  }

  closeMenu(): boolean {
    if (this.closeImageViewer()) return true;
    if (!this.bubbleMenu) return false;
    this.closeBubbleMenu();
    return true;
  }

  private openImageViewer(src: string, alt: string): void {
    this.closeImageViewer();
    const overlay = document.createElement("div");
    overlay.className = "image-viewer";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", alt || "Image");
    overlay.tabIndex = -1;
    const img = document.createElement("img");
    img.src = src;
    img.alt = alt;
    overlay.appendChild(img);
    overlay.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" && ev.key !== "Enter" && ev.key !== " ") return;
      // Swallowed, or the document's own Escape handler would also leave the
      // screen underneath.
      ev.stopPropagation();
      ev.preventDefault();
      this.closeImageViewer();
    });
    this.attachZoom(overlay, img);
    document.body.appendChild(overlay);
    this.imageViewer = overlay;
    overlay.focus();
  }

  private closeImageViewer(): boolean {
    if (!this.imageViewer) return false;
    this.imageViewer.remove();
    this.imageViewer = null;
    return true;
  }

  private attachZoom(overlay: HTMLElement, img: HTMLImageElement): void {
    const state: ViewerZoom = {
      img,
      overlay,
      scale: 1,
      tx: 0,
      ty: 0,
      raster: 1,
      settleTimer: 0,
      points: new Map(),
      span: 0,
      mid: { x: 0, y: 0 },
      moved: 0,
      pinched: false,
      ignoreClick: false,
    };

    overlay.addEventListener("pointerdown", (ev) => {
      // The primary pointer starts a fresh gesture, so anything still in the
      // map belongs to one that is over, a pointerup the WebView never
      // delivered would otherwise wedge every tap after it.
      if (ev.isPrimary) state.points.clear();
      window.clearTimeout(state.settleTimer);
      overlay.setPointerCapture?.(ev.pointerId);
      state.points.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (state.points.size === 1) {
        // A finger landing mid-animation is a new gesture: leaving the
        // transition on would smear every frame of it.
        img.style.transition = "";
        state.moved = 0;
        state.pinched = false;
        state.ignoreClick = false;
      }
      if (state.points.size === 2) {
        state.pinched = true;
        this.readPinch(state);
      }
    });

    overlay.addEventListener("pointermove", (ev) => {
      const prev = state.points.get(ev.pointerId);
      if (!prev) return;
      const at = { x: ev.clientX, y: ev.clientY };
      state.points.set(ev.pointerId, at);
      state.moved += Math.hypot(at.x - prev.x, at.y - prev.y);
      if (state.points.size >= 2) {
        const before = state.span;
        const mid = state.mid;
        this.readPinch(state);
        if (before > 0) {
          this.applyZoom(
            state,
            (state.span / before) * state.scale,
            state.mid,
            {
              x: state.mid.x - mid.x,
              y: state.mid.y - mid.y,
            },
          );
        }
        return;
      }
      // One finger pans only what is zoomed in: at fit, an image that slides
      // and springs back reads as a bug.
      if (state.scale <= 1) return;
      this.applyZoom(state, state.scale, at, {
        x: at.x - prev.x,
        y: at.y - prev.y,
      });
    });

    const lift = (ev: PointerEvent, cancelled: boolean) => {
      if (!state.points.delete(ev.pointerId)) return;
      if (cancelled) state.pinched = true;
      // No release: the capture is implicitly given up after pointerup and
      // pointercancel, and asking for one that has gone throws.
      if (state.points.size === 1) {
        // A pinch that lost a finger carries on as a pan from where the other
        // one is, rather than jumping by the distance between them.
        this.readPinch(state);
        state.span = 0;
        return;
      }
      if (state.points.size > 0) return;
      const tapped = !state.pinched && state.moved < TAP_SLOP;
      // The finger going up answers the gesture, not the click: Chromium
      // spends the first tap after a flick cancelling the fling and emits no
      // click for it at all.
      state.ignoreClick = true;
      if (!tapped) {
        this.settle(state);
        return;
      }
      if (state.scale > 1) {
        this.resetZoom(state);
        return;
      }
      this.swallowTapClick();
      this.closeImageViewer();
    };
    overlay.addEventListener("pointerup", (ev) => lift(ev, false));
    overlay.addEventListener("pointercancel", (ev) => lift(ev, true));

    overlay.addEventListener("click", () => {
      if (state.ignoreClick) return;
      this.stepBack(state);
    });

    overlay.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        this.applyZoom(
          state,
          state.scale * Math.exp(-ev.deltaY / 300),
          { x: ev.clientX, y: ev.clientY },
          { x: 0, y: 0 },
        );
        // A wheel has no "finger up", so the end of one is a gap between events.
        window.clearTimeout(state.settleTimer);
        state.settleTimer = window.setTimeout(() => this.settle(state), 180);
      },
      { passive: false },
    );
  }

  private readPinch(state: ViewerZoom): void {
    const [a, b] = [...state.points.values()];
    if (!a) return;
    if (!b) {
      state.mid = { x: a.x, y: a.y };
      return;
    }
    state.span = Math.hypot(a.x - b.x, a.y - b.y);
    state.mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private applyZoom(
    state: ViewerZoom,
    scale: number,
    focus: { x: number; y: number },
    delta: { x: number; y: number },
  ): void {
    const next = Math.min(MAX_ZOOM, Math.max(1, scale));
    const rect = state.img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const base = { w: rect.width / state.scale, h: rect.height / state.scale };
    const cx = rect.left + rect.width / 2 - state.tx;
    const cy = rect.top + rect.height / 2 - state.ty;
    const k = next / state.scale;
    const tx = focus.x - cx - k * (focus.x - cx - state.tx) + delta.x;
    const ty = focus.y - cy - k * (focus.y - cy - state.ty) + delta.y;

    const style = getComputedStyle(state.overlay);
    const box = state.overlay.getBoundingClientRect();
    const room = (span: number, ...pads: string[]) =>
      span - pads.reduce((sum, p) => sum + (Number.parseFloat(p) || 0), 0);
    const limitX = Math.max(
      0,
      (base.w * next - room(box.width, style.paddingLeft, style.paddingRight)) /
        2,
    );
    const limitY = Math.max(
      0,
      (base.h * next -
        room(box.height, style.paddingTop, style.paddingBottom)) /
        2,
    );

    state.scale = next;
    state.tx = Math.min(limitX, Math.max(-limitX, tx));
    state.ty = Math.min(limitY, Math.max(-limitY, ty));
    // Only the part of the zoom that is not already in the layout size.
    state.img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${next / state.raster})`;
    state.overlay.classList.toggle("zoomed", next > 1);
  }

  private settle(state: ViewerZoom): void {
    if (state.raster === state.scale) return;
    const rect = state.img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Nothing moves on screen here, so a leftover reset animation must not be
    // allowed to make a journey of it.
    state.img.style.transition = "";
    state.raster = state.scale;
    // `max-width: 100%` would clamp the explicit size straight back to the
    // fitted one, so it has to go in the same breath.
    state.img.style.maxWidth = "none";
    state.img.style.maxHeight = "none";
    state.img.style.width = `${rect.width}px`;
    state.img.style.height = `${rect.height}px`;
    state.img.style.transform = `translate(${state.tx}px, ${state.ty}px)`;
  }

  private unsettle(state: ViewerZoom): void {
    if (state.raster === 1) return;
    state.img.style.transition = "";
    state.raster = 1;
    state.img.style.maxWidth = "";
    state.img.style.maxHeight = "";
    state.img.style.width = "";
    state.img.style.height = "";
    state.img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
  }

  private swallowTapClick(): void {
    let timer = 0;
    const eat = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
      document.removeEventListener("click", eat, true);
      window.clearTimeout(timer);
    };
    document.addEventListener("click", eat, true);
    // A tap does not always produce a click, so the trap disarms itself rather
    // than waiting to eat whatever the reader taps next.
    timer = window.setTimeout(() => {
      document.removeEventListener("click", eat, true);
    }, 400);
  }

  private stepBack(state: ViewerZoom): void {
    if (state.scale > 1) this.resetZoom(state);
    else this.closeImageViewer();
  }

  private resetZoom(state: ViewerZoom): void {
    state.img.style.transition = "transform 160ms ease";
    // At fit the translation clamps to zero whatever it is handed.
    this.applyZoom(state, 1, { x: 0, y: 0 }, { x: 0, y: 0 });
    // The layout size is what the animation is scaling down from, so it is
    // handed back only once the animation has finished with it.
    window.clearTimeout(state.settleTimer);
    state.settleTimer = window.setTimeout(() => this.unsettle(state), 220);
  }

  private showMenu(actions: BubbleAction[], at?: MenuAnchor): void {
    if (!actions.length) return;
    this.closeBubbleMenu();

    const menu = document.createElement("div");
    menu.className = "bubble-menu";
    menu.setAttribute("role", "presentation");
    const sheet = document.createElement("div");
    sheet.className = "bubble-menu-sheet";
    sheet.setAttribute("role", "menu");
    // Focus lands on the sheet rather than the first action: a programmatically
    // focused button matches :focus-visible in the Android WebView, which reads
    // as the action being already selected. The sheet still catches Escape.
    sheet.tabIndex = -1;

    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.danger
        ? "bubble-menu-item danger"
        : "bubble-menu-item";
      button.setAttribute("role", "menuitem");
      button.textContent = action.label;
      if (action.disabled) {
        button.disabled = true;
      } else {
        button.addEventListener("click", () => {
          this.closeBubbleMenu();
          void action.run();
        });
      }
      sheet.appendChild(button);
    }

    menu.appendChild(sheet);
    menu.addEventListener("click", (ev) => {
      if (ev.target === menu) this.closeBubbleMenu();
    });
    menu.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      // Swallowed, or the document's Escape handler would also leave the
      // screen underneath.
      ev.stopPropagation();
      this.closeBubbleMenu();
    });
    this.bubbleMenu = menu;
    const from = document.activeElement;
    this.menuReturn = from instanceof HTMLElement ? from : null;
    document.body.appendChild(menu);
    anchorMenu(menu, sheet, at);
    sheet.focus();
  }

  private attachHold(el: HTMLElement, open: (at: MenuAnchor) => void): void {
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
      this.held.delete(el);
      startX = ev.clientX;
      startY = ev.clientY;
      timer = window.setTimeout(() => {
        timer = undefined;
        this.held.add(el);
        open({ x: startX, y: startY });
      }, 550);
    });
    el.addEventListener("pointermove", (ev) => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 10) cancel();
    });
    for (const event of [
      "pointerup",
      "pointercancel",
      "pointerleave",
    ] as const) {
      el.addEventListener(event, cancel);
    }
    el.addEventListener("click", (ev) => {
      if (!this.held.has(el)) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.held.delete(el);
    });
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      cancel();
      this.held.add(el);
      open({ x: ev.clientX, y: ev.clientY });
    });
  }

  private consumeHold(el: HTMLElement): boolean {
    return this.held.delete(el);
  }

  private makeBubbleInteractive(view: ItemView, getText: () => string): void {
    const el = view.el;
    const entry = { text: getText, item: view.item };
    if (this.bubbleText.has(el)) {
      this.bubbleText.set(el, entry);
      return;
    }
    this.bubbleText.set(el, entry);
    this.attachHold(el, (at) => {
      const bubble = this.bubbleText.get(el);
      if (!bubble) return;
      const text = bubble.text;
      const actions: BubbleAction[] = [
        { label: "Copy to clipboard", run: () => this.copy(text(), el) },
      ];
      if (this.onResend) {
        const resend = this.onResend;
        actions.push({ label: "Resend", run: () => resend(text()) });
      }
      // Asked at open time, like `hideAction`: whether this bubble can be
      // rewound to depends on the session as it stands, not as it rendered.
      const rewind = this.rewindAction?.(bubble.item, text());
      if (rewind) actions.push(rewind);
      if (this.onForward) {
        const forward = this.onForward;
        actions.push(
          { label: "Send to new chat", run: () => forward(text(), "new") },
          {
            label: "Send to existing chat",
            run: () => forward(text(), "existing"),
          },
        );
      }
      const restart = this.restartAction?.(bubble.item, text());
      if (restart) actions.push(restart);
      this.showMenu(actions, at);
    });
  }

  private makeCardHeadInteractive(
    head: HTMLElement,
    view: ItemView,
    label: string,
  ): void {
    if (!this.onViewRaw && !this.hideAction) return;
    this.attachHold(head, (at) => {
      const actions: BubbleAction[] = [];
      // Asked at open time, not render time: whether this kind is already
      // hidden changes as the reader works.
      const hide = this.hideAction?.(view.item);
      if (hide) actions.push(hide);
      if (this.onViewRaw) {
        const viewRaw = this.onViewRaw;
        actions.push({
          label: "View raw",
          run: () => viewRaw(view.item, label),
        });
      }
      this.showMenu(actions, at);
    });
  }

  addSystem(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "bubble system";
    el.textContent = text;
    this.root.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  addError(title: string, detail: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "bubble error";
    const full = detail ? `${title}\n\n${detail}` : title;
    const role = document.createElement("span");
    role.className = "role";
    role.textContent = "Error";
    const body = document.createElement("div");
    body.className = "mono wrap";
    body.textContent = full;
    el.append(role, body);
    // No menu: the CSS makes an error selectable so Android's own handles copy
    // it.
    this.root.appendChild(el);
    this.scrollToBottom(true);
    return el;
  }

  upsert(item: ThreadItem): void {
    // An id-less item gets a synthesised key and may render twice (the key
    // cannot correlate `item/started` with `item/completed`), visible and
    // duplicated beats silently discarded.
    const id = (item as { id?: string }).id || this.synthesiseId(item);

    let view = this.views.get(id);
    if (!view) {
      const el = document.createElement("div");
      view = { el, item };
      this.views.set(id, view);
      this.root.appendChild(el);
    }
    view.item = item;
    this.render(view);
    this.scrollToBottom();
  }

  private idlessCount = 0;

  private synthesiseId(item: ThreadItem): string {
    const type = String((item as { type?: string }).type ?? "item");
    return `noid-${type}-${this.idlessCount++}`;
  }

  private render(view: ItemView): void {
    view.el.className = "";
    view.el.innerHTML = "";
    // Re-asked on every render: a live turn re-renders a card as its output
    // lands, and a filtered kind must stay filtered across that.
    this.applyHidden(view);

    const type = String((view.item as { type?: string })?.type ?? "item");
    try {
      this.renderItem(view);
    } catch (err) {
      view.el.className = "";
      view.el.innerHTML = "";
      this.renderCard(view, {
        icon: "⚠",
        label: `Could not render ${type}`,
        badge: { text: "render error", cls: "failed" },
        body: `${String(err)}\n\n${stringify(view.item)}`,
        openByDefault: view.open ?? false,
      });
      return;
    }

    if (view.el.childElementCount === 0) {
      this.renderCard(view, {
        icon: "•",
        label: type,
        badge: null,
        body: stringify(view.item),
        openByDefault: view.open ?? false,
      });
    }

    this.hydratePathImages(view);
  }

  private hydratePathImages(view: ItemView): void {
    const id = String((view.item as { id?: string }).id ?? "");
    for (const span of Array.from(
      view.el.querySelectorAll<HTMLElement>("span.md-img[data-img-src]"),
    )) {
      span.dataset.itemId = id;
      // Wired whether or not anything can draw the picture: the hold is about
      // the file, and a placeholder that never resolves still names one.
      this.makeImageInteractive(span);
      if (this.onImage) this.hydrateImage(span, false);
    }
  }

  private makeImageInteractive(span: HTMLElement): void {
    if (!this.onOpenPath || this.imageHold.has(span)) return;
    this.imageHold.add(span);
    // The path is read at open time rather than closed over: hydration reuses
    // a placeholder across renders, and a stale path would offer the wrong
    // file.
    this.attachHold(span, () => {
      const path = span.dataset.imgSrc;
      if (path) this.onOpenPath?.(path, null);
    });
  }

  private hydrateImage(span: HTMLElement, fresh: boolean): void {
    const path = span.dataset.imgSrc;
    if (!path || !this.onImage) return;
    span.classList.remove("failed");
    span.textContent = "Loading image…";
    this.onImage(path, span.dataset.itemId ?? "", fresh).then((src) => {
      if (!span.isConnected) return;
      if (!src) {
        // The path stays readable, it is the agent's own reference. The retry
        // hint sits on its own line so it does not re-wrap with the path.
        span.classList.add("failed");
        const where = document.createElement("div");
        where.textContent = `⚠ ${path}`;
        const hint = document.createElement("div");
        hint.className = "md-img-retry";
        hint.textContent = "tap to retry";
        span.replaceChildren(where, hint);
        return;
      }
      const img = document.createElement("img");
      img.className = "chat-img";
      img.alt = span.dataset.imgAlt || path;
      img.src = src;
      // The image arrives with height 0 and grows on decode.
      img.addEventListener("load", () => this.scrollToBottom());
      span.classList.add("loaded");
      span.replaceChildren(img);
    });
  }

  private buildImages(images: EmbeddedImage[]): HTMLElement {
    const strip = document.createElement("div");
    strip.className = "bubble-images";
    for (const image of images) {
      const img = document.createElement("img");
      img.className = "chat-img";
      img.alt = image.mime;
      img.src = `data:${image.mime};base64,${image.data}`;
      img.addEventListener("load", () => this.scrollToBottom());
      strip.appendChild(img);
    }
    return strip;
  }

  private renderItem(view: ItemView): void {
    const wasOpen = view.open ?? false;

    switch (view.item.type) {
      case "userMessage": {
        const item = view.item as Extract<ThreadItem, { type: "userMessage" }>;
        this.renderBubble(view, "user", "", userText(item.content), {
          images: item.images,
          delivery: item.delivery,
        });
        break;
      }

      case "agentMessage": {
        const item = view.item as Extract<ThreadItem, { type: "agentMessage" }>;
        const text = String(item.text ?? "");
        // An empty agent message is possible, codex writes one for a
        // commentary preamble, so show it as pending rather than blank. One
        // carrying only an image is not pending: the image is the message.
        this.renderBubble(view, "agent", this.agentName, text, {
          pending: !text && !item.images?.length,
          images: item.images,
        });
        break;
      }

      case "reasoning": {
        const item = view.item as Extract<ThreadItem, { type: "reasoning" }>;
        const summary = (item.summary ?? []).filter(Boolean).join("\n\n");
        const headline = firstLine(summary) || "Thinking";
        // Collapsed with the opening line in the heading: claude writes
        // several hundred words of thinking before almost every tool call, and
        // expanded by default a turn's thinking buries the conversation.
        this.renderCard(view, {
          icon: "💭",
          label: `Reasoning — ${truncate(headline, LABEL_MAX)}`,
          badge: null,
          body: summary || "(no reasoning text exposed by the model)",
          openByDefault: wasOpen,
          extraClass: "reasoning",
          prose: true,
        });
        break;
      }

      case "rawToolCall": {
        const item = view.item as Extract<ThreadItem, { type: "rawToolCall" }>;
        const edit =
          String(item.tool).toLowerCase() === "edit"
            ? editInput(item.input)
            : null;
        if (edit) {
          this.renderEditCard(view, item, edit);
          break;
        }
        const bash = bashInput(String(item.tool ?? ""), item.input);
        if (bash) {
          this.renderBashCard(view, item, bash, wasOpen);
          break;
        }
        // codex's `exec` tool wraps its shell commands in a JS snippet, so
        // the commands are dug out and shown as commands, the way codex's own
        // UI does; code mode's `title` is the heading.
        const exec = item.input?.includes("exec_command")
          ? execSnippet(item.input)
          : null;
        if (exec) {
          this.renderBashCard(view, item, exec, wasOpen);
          break;
        }
        const summary = item.summary ?? execSummary(item.input ?? "");
        const read =
          !item.namespace && String(item.tool).toLowerCase() === "read";
        const explored =
          item.explored ?? (summary ? isExploratoryCommand(summary) : false);
        const label = read
          ? summary?.replace(/^read(?:\s+|$)/i, "") || "file"
          : (summary ?? `${item.tool}`);
        const body = [
          `tool: ${item.namespace ? `${item.namespace}.` : ""}${item.tool}`,
          `input:\n${item.input ?? ""}`,
          item.output ? `output:\n${item.output}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        this.renderCard(view, {
          icon: read ? "📖" : explored ? "🔍" : "⌘",
          label: read
            ? truncate(label, LABEL_MAX)
            : `${explored ? "Explored" : "Ran"} ${truncate(label, LABEL_MAX)}`,
          badge: badgeFor(item.status ?? "completed", item.durationMs),
          body,
          images: item.images,
          openByDefault: wasOpen,
        });
        break;
      }

      case "contextEntry": {
        const item = view.item as Extract<ThreadItem, { type: "contextEntry" }>;
        const origin = String(item.origin ?? "");
        this.renderCard(view, {
          icon: contextIcon(origin),
          label: truncate(String(item.label || origin || "Context"), LABEL_MAX),
          badge: null,
          body: String(item.text ?? ""),
          sub: origin,
          openByDefault: wasOpen,
          extraClass: "context",
          prose: !origin.startsWith("event/") && !META_ORIGINS.has(origin),
        });
        break;
      }

      default:
        this.renderCard(view, {
          icon: "•",
          label: String(view.item.type ?? "item"),
          badge: null,
          body: stringify(view.item),
          openByDefault: wasOpen,
        });
    }
  }

  private renderBubble(
    view: ItemView,
    kind: "user" | "agent" | "system",
    role: string,
    text: string,
    opts: {
      pending?: boolean;
      images?: EmbeddedImage[];
      delivery?: Delivery;
    } = {},
  ): void {
    view.el.className = `bubble ${kind}${opts.pending ? " pending" : ""}`;
    if (role) {
      const roleEl = document.createElement("span");
      roleEl.className = "role";
      roleEl.textContent = role;
      // Holding the agent's name offers the entry behind the reply; a hold on
      // the body stays Android's, for selecting the text.
      if (kind === "agent") this.makeCardHeadInteractive(roleEl, view, role);
      view.el.appendChild(roleEl);
    }
    const body = document.createElement("div");
    if (kind === "agent" && !opts.pending) body.className = "md";
    if (opts.pending) {
      body.className = "bubble-loading";
      body.setAttribute("role", "status");
      body.setAttribute("aria-label", "Waiting for the reply");
      for (let i = 0; i < 3; i += 1) {
        const dot = document.createElement("span");
        dot.className = "dot";
        body.appendChild(dot);
      }
    } else if (kind === "agent") {
      body.innerHTML = formatMarkdown(text);
    } else {
      body.textContent = text;
    }
    view.el.appendChild(body);
    if (opts.images?.length) view.el.appendChild(this.buildImages(opts.images));
    if (kind === "user" && opts.delivery && opts.delivery !== "pending") {
      view.el.appendChild(buildTicks(opts.delivery));
    }
    // Your own message is the only bubble whose *body* has a menu; an agent's
    // reply hands the hold to Android's selection handles instead.
    if (!opts.pending && kind === "user") {
      this.makeBubbleInteractive(view, () => text);
    }
  }

  private renderEditCard(
    view: ItemView,
    item: {
      status?: string;
      rawType?: string;
      output?: string;
      durationMs?: number;
    },
    edit: EditInput,
  ): void {
    const container = document.createElement("div");

    if (edit.path) {
      const file = document.createElement("div");
      file.className = "diff-file mono";
      // An Edit call states its path as data, so this one is known rather
      // than guessed at.
      const name = document.createElement("span");
      name.className = "filepath";
      name.setAttribute("role", "link");
      name.tabIndex = 0;
      name.dataset.path = edit.path;
      name.textContent = edit.path;
      file.appendChild(name);
      if (edit.replaceAll) file.append(" · replace all");
      container.appendChild(file);
    }

    const lines = edit.changes.flatMap((change, i): DiffLine[] => [
      ...(i ? [{ kind: "same" as const, text: "⋯" }] : []),
      ...diffLines(change.old, change.new),
    ]);
    const block = document.createElement("div");
    block.className = "diff mono";
    for (const line of lines) {
      const row = document.createElement("div");
      row.className = `diff-line ${line.kind}`;
      // The margin marker travels inside the text so the row is one <div> and
      // horizontal scrolling drags marker and code together.
      row.textContent =
        (line.kind === "del" ? "- " : line.kind === "add" ? "+ " : "  ") +
        line.text;
      block.appendChild(row);
    }
    container.appendChild(block);

    const failed = item.status === "failed";
    if (failed && item.output) {
      const err = document.createElement("pre");
      err.className = "mono wrap diff-error";
      err.textContent = item.output;
      container.appendChild(err);
    }

    const copy = [
      edit.path ? `Edit ${edit.path}` : "Edit",
      diffText(lines),
      failed && item.output ? item.output : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    this.renderCard(view, {
      icon: "✏️",
      label: truncate(edit.path || "file", LABEL_MAX),
      badge: badgeFor(item.status ?? "completed", item.durationMs),
      body: copy,
      bodyEl: container,
      // The diff *is* this card, so it stays open, and `.card.edit` drops the
      // inner scroll box so the whole change is on the page.
      collapsible: false,
      extraClass: "edit",
    });
  }

  private renderBashCard(
    view: ItemView,
    item: {
      status?: string;
      output?: string;
      durationMs?: number;
      summary?: string;
      tool?: string;
      images?: EmbeddedImage[];
    },
    bash: BashInput,
    wasOpen: boolean,
  ): void {
    const container = document.createElement("div");

    const block = document.createElement("div");
    block.className = "shell mono";
    for (const command of bash.commands) {
      const lines = shellLines(command);
      lines.forEach((text, i) => {
        const row = document.createElement("div");
        row.className = i === 0 ? "shell-line" : "shell-line cont";
        if (i === 0) {
          // The prompt is its own element so it can be dimmed and so a copy
          // never picks it up.
          const prompt = document.createElement("span");
          prompt.className = "shell-prompt";
          prompt.setAttribute("aria-hidden", "true");
          prompt.textContent = "$ ";
          row.appendChild(prompt);
        }
        appendCommandText(row, text);
        block.appendChild(row);
      });
    }
    container.appendChild(block);

    if (bash.notes.length) {
      const notes = document.createElement("div");
      notes.className = "shell-notes mono";
      notes.textContent = bash.notes.join(" · ");
      container.appendChild(notes);
    }

    if (item.output) {
      const out = document.createElement("pre");
      out.className = `shell-out mono wrap${item.status === "failed" ? " failed" : ""}`;
      out.textContent = item.output;
      container.appendChild(out);
    }

    const label =
      bash.title ||
      item.summary?.replace(/^bash(?:\s+|$)/i, "") ||
      bash.commands[0];
    this.renderCard(view, {
      icon: "$",
      label: truncate(label, LABEL_MAX),
      badge: badgeFor(item.status ?? "completed", item.durationMs),
      // Press-and-hold copies the commands verbatim, unsplit and unprefixed,
      // with their output under them.
      body: [
        bash.commands.join("\n\n"),
        bash.notes.join(" · "),
        item.output ?? "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      bodyEl: container,
      images: item.images,
      openByDefault: wasOpen,
      extraClass: "shell-card",
    });
  }

  private renderCard(
    view: ItemView,
    opts: {
      icon: string;
      label: string;
      badge: { text: string; cls: string } | null;
      body: string;
      bodyEl?: HTMLElement;
      images?: EmbeddedImage[];
      sub?: string;
      openByDefault?: boolean;
      extraClass?: string;
      prose?: boolean;

      collapsible?: boolean;
    },
  ): void {
    const collapsible = opts.collapsible !== false;
    const open = collapsible ? Boolean(opts.openByDefault) : true;
    view.el.className = [
      "card",
      opts.extraClass ?? "",
      open ? "open" : "",
      collapsible ? "" : "fixed",
    ]
      .filter(Boolean)
      .join(" ");

    const head = document.createElement("div");
    head.className = "card-head";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = `${opts.icon}  ${opts.label}`;

    if (collapsible) {
      const chev = document.createElement("span");
      chev.className = "chev";
      chev.textContent = "▶";
      head.append(chev, label);
    } else {
      head.append(label);
    }
    if (opts.badge) {
      const badge = document.createElement("span");
      badge.className = `badge ${opts.badge.cls}`;
      badge.textContent = opts.badge.text;
      head.appendChild(badge);
    }
    if (collapsible) {
      head.addEventListener("click", () => {
        if (this.consumeHold(head)) return;
        view.open = !view.el.classList.contains("open");
        view.el.classList.toggle("open", view.open);
      });
    }
    // The hold menu is attached either way: View raw and "hide this kind" are
    // properties of the card, not of its being collapsible.
    this.makeCardHeadInteractive(head, view, opts.label);

    const body = document.createElement("div");
    body.className = "card-body";
    if (opts.bodyEl) {
      body.appendChild(opts.bodyEl);
    } else {
      const content = document.createElement("pre");
      content.className = opts.prose ? "prose wrap" : "mono wrap";
      content.textContent = opts.body;
      body.appendChild(content);
    }
    if (opts.images?.length) body.appendChild(this.buildImages(opts.images));

    if (opts.sub) {
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = opts.sub;
      body.appendChild(sub);
    }

    view.el.append(head, body);
  }
}

interface EditInput {
  path: string;
  changes: { old: string; new: string }[];
  replaceAll: boolean;
}

interface BashInput {
  commands: string[];
  notes: string[];
  title?: string | null;
}

function bashInput(tool: string, input: unknown): BashInput | null {
  if (tool.toLowerCase() !== "bash") return null;
  if (typeof input !== "string" || !input.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const args = parsed as Record<string, unknown>;
  const command = typeof args.command === "string" ? args.command : "";
  if (!command.trim()) return null;
  const notes: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (key === "command" || key === "description") continue;
    if (value === null || value === undefined || value === "") continue;
    notes.push(
      `${key}: ${
        key === "timeout" && typeof value === "number"
          ? humanMs(value)
          : stringify(value)
      }`,
    );
  }
  return { commands: [command], notes };
}

function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return String(ms);
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${trimZero(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${trimZero(minutes)}m`;
  return `${trimZero(minutes / 60)}h`;
}

const trimZero = (n: number) => String(Math.round(n * 10) / 10);

const TRAILING_OP = /\s(&&|\|\||;)$/;
const GLUE_MAX = 26;

function appendCommandText(row: HTMLElement, text: string): void {
  const match = text.match(TRAILING_OP);
  if (!match || match.index === undefined) {
    row.appendChild(document.createTextNode(text));
    return;
  }
  const step = text.slice(0, match.index);
  const cut = step.lastIndexOf(" ");
  const last = step.slice(cut + 1);
  // A long final token is left breakable: an orphaned operator is a smaller
  // price than a command that scrolls sideways.
  if (cut < 0 || last.length > GLUE_MAX) {
    row.appendChild(document.createTextNode(text));
    return;
  }
  row.appendChild(document.createTextNode(step.slice(0, cut)));
  const glue = document.createElement("span");
  glue.className = "shell-glue";
  glue.textContent = ` ${last} ${match[1]}`;
  row.appendChild(glue);
}

function shellLines(command: string): string[] {
  const text = command.trim();
  if (text.includes("<<")) return [text];
  const lines: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // A `$(…)` or `(…)` subshell is one unit: its own `&&` joins commands
    // inside it, not the steps of the line being read here.
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth > 0) continue;
    const two = text.slice(i, i + 2);
    const op = two === "&&" || two === "||" ? two : ch === ";" ? ";" : "";
    if (!op) continue;
    const step = text.slice(start, i).trim();
    if (step) lines.push(`${step} ${op}`);
    i += op.length - 1;
    start = i + 1;
  }
  if (quote) return [text];
  const tail = text.slice(start).trim();
  if (tail) lines.push(tail);
  return lines.length ? lines : [text];
}

function editInput(input: unknown): EditInput | null {
  if (typeof input !== "string" || !input.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const args = parsed as Record<string, unknown>;
  const rawChanges = Array.isArray(args.edits)
    ? args.edits
    : [
        {
          oldText: args.old_string ?? args.oldText,
          newText: args.new_string ?? args.newText,
        },
      ];
  const changes = rawChanges.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const change = value as Record<string, unknown>;
    return typeof change.oldText === "string" &&
      typeof change.newText === "string"
      ? [{ old: change.oldText, new: change.newText }]
      : [];
  });
  if (!changes.length || changes.length !== rawChanges.length) return null;
  return {
    path:
      typeof args.file_path === "string"
        ? args.file_path
        : typeof args.path === "string"
          ? args.path
          : "",
    changes,
    replaceAll: args.replace_all === true,
  };
}

const META_ORIGINS = new Set([
  "session_meta",
  "turn_context",
  "world_state",
  "reasoning",
  "attachment",
  "mode",
  "permission-mode",
  "ai-title",
  "file-history-snapshot",
  "assistant part",
  "step-finish",
  "opencode part",
  "opencode error",
  "opencode event",
]);

function contextIcon(origin: string): string {
  if (origin === "developer" || origin === "system") return "📋";
  if (origin === "injected context") return "📄";
  if (origin === "attachment") return "📎";
  if (origin === "sidechain") return "🤖";
  if (origin.startsWith("event/")) return "•";
  if (META_ORIGINS.has(origin)) return "⚙";
  return "📄";
}

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  return `${groupDigits(Math.round(ms))}ms`;
}

const groupDigits = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, ",");

function badgeFor(
  status: string,
  durationMs?: number,
): { text: string; cls: string } {
  const duration = formatDuration(durationMs);
  switch (status) {
    case "inProgress":
      return { text: "running", cls: "running" };
    case "completed":
      return { text: duration ?? "done", cls: "ok" };
    case "failed":
      return { text: duration ?? "failed", cls: "failed" };
    case "declined":
      return { text: "declined", cls: "failed" };
    default:
      return { text: status, cls: "" };
  }
}
