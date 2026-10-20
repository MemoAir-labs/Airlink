import type * as Y from "yjs";

export type BrowserActor = {
  kind: "human" | "agent";
  id: string;
  name: string;
};

export type BrowserViewport = { width: number; height: number };

export type BrowserVisit = {
  url: string;
  title: string;
  at: string;
  actor: BrowserActor;
};

export type BrowserState = {
  url: string;
  title: string;
  viewport: BrowserViewport;
};

export const defaultViewport: BrowserViewport = { width: 1280, height: 800 };
export const blankUrl = "about:blank";

// Where the room went and who drove is durable and attributed; pixels and input never enter the
// doc. The history keeps the last visits so a card can say "on github.com, driven by Juno".
const historyCap = 200;

export const browserState = (doc: Y.Doc) => doc.getMap<unknown>("browserState");
export const browserHistory = (doc: Y.Doc) =>
  doc.getArray<BrowserVisit>("browserHistory");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isBrowserDoc(doc: Y.Doc): boolean {
  return typeof browserState(doc).get("url") === "string";
}

export function readBrowserState(doc: Y.Doc): BrowserState {
  const state = browserState(doc);
  const url = state.get("url");
  const title = state.get("title");
  const viewport = state.get("viewport");
  return {
    url: typeof url === "string" ? url : blankUrl,
    title: typeof title === "string" ? title : "",
    viewport:
      isRecord(viewport) &&
      typeof viewport.width === "number" &&
      typeof viewport.height === "number"
        ? { width: viewport.width, height: viewport.height }
        : defaultViewport,
  };
}

export function initBrowser(
  doc: Y.Doc,
  {
    url,
    viewport = defaultViewport,
  }: { url: string; viewport?: BrowserViewport }
) {
  const state = browserState(doc);
  state.set("url", url);
  state.set("title", "");
  state.set("viewport", viewport);
}

export function recordVisit(
  doc: Y.Doc,
  { url, title }: { url: string; title: string },
  actor: BrowserActor,
  at = new Date().toISOString()
) {
  const state = browserState(doc);
  const history = browserHistory(doc);
  const last = history.length ? history.get(history.length - 1) : null;
  state.set("url", url);
  state.set("title", title);
  if (last && last.url === url) {
    return;
  }
  history.push([{ url, title, at, actor }]);
  if (history.length > historyCap) {
    history.delete(0, history.length - historyCap);
  }
}

export function setBrowserTitle(doc: Y.Doc, title: string) {
  browserState(doc).set("title", title);
}

export function readVisits(doc: Y.Doc): BrowserVisit[] {
  return browserHistory(doc).toArray();
}

export type MuxClaim = { ok: true } | { ok: false; heldBy: BrowserActor };

type Holder = { actor: BrowserActor; lastInputAt: number };

// One actor drives the page at a time. A person takes the controls from an agent at once and from
// another person only once that person has paused; an agent only ever takes idle controls. A hold
// lapses by itself after a quiet spell, so nobody has to remember to release.
export function createInputMux({
  humanIdleMs = 3000,
  lapseMs = 10_000,
}: {
  humanIdleMs?: number;
  lapseMs?: number;
} = {}) {
  let holder: Holder | null = null;

  const active = (now: number): Holder | null =>
    holder && now - holder.lastInputAt < lapseMs ? holder : null;

  return {
    holder(now = Date.now()): BrowserActor | null {
      return active(now)?.actor ?? null;
    },

    claim(actor: BrowserActor, now = Date.now()): MuxClaim {
      const current = active(now);
      if (!current || current.actor.id === actor.id) {
        holder = { actor, lastInputAt: now };
        return { ok: true };
      }
      const idleMs = now - current.lastInputAt;
      const mayTake =
        actor.kind === "human"
          ? current.actor.kind === "agent" || idleMs >= humanIdleMs
          : idleMs >= humanIdleMs;
      if (!mayTake) {
        return { ok: false, heldBy: current.actor };
      }
      holder = { actor, lastInputAt: now };
      return { ok: true };
    },

    release(actorId: string) {
      if (holder?.actor.id === actorId) {
        holder = null;
      }
    },
  };
}

export type InputMux = ReturnType<typeof createInputMux>;

// A page as an agent reads it: one line per thing worth knowing, interactive elements numbered so
// the agent can act on them by reference. Built from Chromium's accessibility tree, which already
// strips layout and scripts and names controls the way a screen reader would.

export type AxValue = { value?: unknown };

export type AxNode = {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: { name: string; value: AxValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
};

export type OutlineLine = {
  ref: string | null;
  role: string;
  text: string;
  value: string | null;
  level: number | null;
  checked: boolean | null;
  backendNodeId: number | null;
};

export type Outline = {
  lines: OutlineLine[];
  refs: Record<string, number>;
};

const interactiveRoles = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "slider",
  "spinbutton",
  "listbox",
]);

const structuralRoles = new Set([
  "heading",
  "navigation",
  "main",
  "banner",
  "contentinfo",
  "form",
  "region",
  "dialog",
  "alertdialog",
  "alert",
  "image",
  "img",
  "table",
  "list",
]);

const textRoles = new Set(["StaticText", "text", "paragraph"]);

const maxLines = 400;
const maxTextChars = 160;

function stringOf(value: AxValue | undefined): string {
  return typeof value?.value === "string" ? value.value : "";
}

function property(node: AxNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxTextChars ? `${flat.slice(0, maxTextChars)}…` : flat;
}

export function outlineFromAxTree(nodes: AxNode[]): Outline {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const children = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const roots = nodes.filter((node) => !children.has(node.nodeId));
  const lines: OutlineLine[] = [];
  const refs: Record<string, number> = {};
  let nextRef = 1;

  const visit = (node: AxNode, insideNamed: boolean) => {
    if (lines.length >= maxLines) {
      return;
    }
    const role = stringOf(node.role);
    const name = clip(stringOf(node.name));
    const ignored = node.ignored === true;
    const interactive = interactiveRoles.has(role);
    const structural = structuralRoles.has(role);
    const text = textRoles.has(role);
    let emitted = false;
    if (!ignored && interactive) {
      const ref = `e${nextRef++}`;
      if (typeof node.backendDOMNodeId === "number") {
        refs[ref] = node.backendDOMNodeId;
      }
      const checked = property(node, "checked");
      lines.push({
        ref,
        role,
        text: name,
        value: stringOf(node.value) || null,
        level: null,
        checked:
          checked === true || checked === "true"
            ? true
            : checked === false || checked === "false"
              ? false
              : null,
        backendNodeId: node.backendDOMNodeId ?? null,
      });
      emitted = true;
    } else if (!ignored && structural && (name || role === "heading")) {
      const level = property(node, "level");
      lines.push({
        ref: null,
        role,
        text: name,
        value: null,
        level: typeof level === "number" ? level : null,
        checked: null,
        backendNodeId: node.backendDOMNodeId ?? null,
      });
      emitted = true;
    } else if (!ignored && text && name && !insideNamed) {
      lines.push({
        ref: null,
        role: "text",
        text: name,
        value: null,
        level: null,
        checked: null,
        backendNodeId: node.backendDOMNodeId ?? null,
      });
      emitted = true;
    }
    // A link's or heading's own text is already in its name; descending would repeat it.
    const named =
      insideNamed || (emitted && (interactive || role === "heading"));
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) {
        visit(child, named);
      }
    }
  };

  for (const root of roots) {
    visit(root, false);
  }
  return { lines, refs };
}

export function formatOutlineLine(line: OutlineLine): string {
  const head = line.ref ? `${line.ref} ` : "";
  const role =
    line.role === "heading" && line.level ? `h${line.level}` : line.role;
  const parts = [`${head}${role}`];
  if (line.text) {
    parts.push(JSON.stringify(line.text));
  }
  if (line.value) {
    parts.push(`= ${JSON.stringify(clip(line.value))}`);
  }
  if (line.checked !== null) {
    parts.push(line.checked ? "[checked]" : "[unchecked]");
  }
  return parts.join(" ");
}

export function formatOutline(outline: Outline): string {
  return outline.lines.map(formatOutlineLine).join("\n");
}

function lineKey(line: OutlineLine): string {
  return formatOutlineLine({ ...line, ref: line.ref ? "e" : null });
}

// What a step changed, by content rather than by ref: refs renumber on every read.
export function diffOutline(
  before: Outline,
  after: Outline
): { added: string[]; removed: string[] } {
  const count = (outline: Outline) => {
    const counts = new Map<string, number>();
    for (const line of outline.lines) {
      const key = lineKey(line);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const beforeCounts = count(before);
  const afterCounts = count(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [key, n] of afterCounts) {
    const extra = n - (beforeCounts.get(key) ?? 0);
    for (let i = 0; i < extra; i++) {
      added.push(key);
    }
  }
  for (const [key, n] of beforeCounts) {
    const missing = n - (afterCounts.get(key) ?? 0);
    for (let i = 0; i < missing; i++) {
      removed.push(key);
    }
  }
  return { added, removed };
}

// The shared browser runs next to the rest of the stack, so a page it loads could reach the VM's
// metadata server or any private service. Every request is checked here before Chromium continues
// it: only http(s), and never a host that names or resolves to a private address. The connection
// itself goes through live-server's pinning proxy (proxy.ts), which dials the address it resolved,
// so a name that starts answering privately after this check still reaches nothing.

const blockedNames = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
]);

export type AddressLookup = (host: string) => Promise<string[]>;

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : -1
  );
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isBlockedIpv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isBlockedIpv6(host: string): boolean {
  const ip = host.toLowerCase();
  if (ip === "::1" || ip === "::") {
    return true;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) {
    const v4 = parseIpv4(mapped[1]);
    return v4 ? isBlockedIpv4(v4) : true;
  }
  return /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

export function isBlockedHost(rawHost: string): boolean {
  const host = rawHost
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!host || blockedNames.has(host) || host.endsWith(".localhost")) {
    return true;
  }
  const v4 = parseIpv4(host);
  if (v4) {
    return isBlockedIpv4(v4);
  }
  if (host.includes(":")) {
    return isBlockedIpv6(host);
  }
  return false;
}

// What a person types in the address bar: a URL as is, something shaped like a host (a dot or a
// port, no spaces) over https, and anything else as a web search.
export function addressToUrl(input: string): string {
  const text = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return text;
  }
  if (!/\s/.test(text) && /^[^/?#]+(\.[^/?#.]+|:\d+)([/?#].*)?$/.test(text)) {
    return `https://${text}`;
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export async function checkUrl(
  raw: string,
  lookup: AddressLookup
): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "only http and https pages can be opened" };
  }
  if (isBlockedHost(url.hostname)) {
    return { ok: false, reason: "private and internal addresses are blocked" };
  }
  if (parseIpv4(url.hostname) || url.hostname.includes(":")) {
    return { ok: true, url };
  }
  let addresses: string[];
  try {
    addresses = await lookup(url.hostname);
  } catch {
    return { ok: false, reason: `${url.hostname} could not be resolved` };
  }
  if (addresses.some(isBlockedHost)) {
    return { ok: false, reason: "private and internal addresses are blocked" };
  }
  return { ok: true, url };
}
