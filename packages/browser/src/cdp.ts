import { lookup as dnsLookup } from "node:dns/promises";

import type {
  AddressLookup,
  AxNode,
  BrowserViewport,
  Outline,
} from "./index.ts";
import { checkUrl, outlineFromAxTree } from "./index.ts";

type CdpError = { message: string };

type Incoming = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: CdpError;
  sessionId?: string;
};

type EventHandler = (params: unknown, sessionId: string | undefined) => void;

export type CdpClient = {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T>;
  on(method: string, handler: EventHandler): () => void;
  onClose(handler: () => void): void;
  close(): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The few CDP calls a shared browser needs, over Node's own WebSocket: no driver library, no
// browser binary in the image. Chromium lives in its own container and is reached by URL.
export function connectCdp(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (err: Error) => void }
    >();
    const handlers = new Map<string, Set<EventHandler>>();
    const closeHandlers: (() => void)[] = [];
    let nextId = 1;
    let opened = false;

    const client: CdpClient = {
      send(method, params = {}, sessionId) {
        const id = nextId++;
        return new Promise((resolveSend, rejectSend) => {
          if (socket.readyState !== WebSocket.OPEN) {
            rejectSend(new Error(`cdp: socket closed before ${method}`));
            return;
          }
          pending.set(id, {
            resolve: (value) => resolveSend(value as never),
            reject: rejectSend,
          });
          socket.send(JSON.stringify({ id, method, params, sessionId }));
        });
      },
      on(method, handler) {
        const set = handlers.get(method) ?? new Set();
        set.add(handler);
        handlers.set(method, set);
        return () => {
          set.delete(handler);
        };
      },
      onClose(handler) {
        closeHandlers.push(handler);
      },
      close() {
        socket.close();
      },
    };

    socket.addEventListener("open", () => {
      opened = true;
      resolve(client);
    });
    socket.addEventListener("error", () => {
      if (!opened) {
        reject(new Error(`cdp: could not connect to ${wsUrl}`));
      }
    });
    socket.addEventListener("close", () => {
      for (const { reject: rejectPending } of pending.values()) {
        rejectPending(new Error("cdp: connection closed"));
      }
      pending.clear();
      for (const handler of closeHandlers) {
        handler();
      }
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      let message: Incoming;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message.id === "number") {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (!waiter) {
          return;
        }
        if (message.error) {
          waiter.reject(new Error(`cdp: ${message.error.message}`));
        } else {
          waiter.resolve(message.result);
        }
        return;
      }
      if (message.method) {
        for (const handler of handlers.get(message.method) ?? []) {
          handler(message.params, message.sessionId);
        }
      }
    });
  });
}

export type ScreencastFrame = { data: string; width: number; height: number };

export type MouseInput = {
  type: "move" | "down" | "up";
  x: number;
  y: number;
  button?: "left" | "right" | "middle" | "none";
  clickCount?: number;
  modifiers?: number;
};

export type WheelInput = {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  modifiers?: number;
};

export type KeyInput = {
  type: "down" | "up";
  key: string;
  code: string;
  text?: string;
  modifiers?: number;
};

export type PageInfo = { url: string; title: string };

export type NavigateResult =
  | { ok: true; url: string; title: string }
  | { ok: false; reason: string };

export type BrowserSession = {
  navigate(url: string): Promise<NavigateResult>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  mouse(input: MouseInput): Promise<void>;
  wheel(input: WheelInput): Promise<void>;
  key(input: KeyInput): Promise<void>;
  insertText(text: string): Promise<void>;
  press(combo: string): Promise<void>;
  // Refs come from the session's own last readOutline(), so a stale ref fails loudly instead
  // of clicking whatever now has that node id.
  click(ref: string): Promise<{ x: number; y: number }>;
  type(
    ref: string,
    text: string,
    submit?: boolean
  ): Promise<{ x: number; y: number }>;
  readOutline(): Promise<Outline>;
  pageInfo(): Promise<PageInfo>;
  screenshot(): Promise<string>;
  isOpen(): boolean;
  close(): Promise<void>;
};

const ctrlModifier = 2;
const metaModifier = 4;
const loadTimeoutMs = 8000;
const lookupTtlMs = 60_000;
const screencastQuality = 60;

const keyCodes: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Meta: 91,
  " ": 32,
};

const modifierBits: Record<string, number> = {
  Alt: 1,
  Control: ctrlModifier,
  Meta: metaModifier,
  Shift: 8,
};

function keyEventParams({ type, key, code, text, modifiers = 0 }: KeyInput) {
  const printable = key.length === 1;
  const withCommand = (modifiers & (ctrlModifier | metaModifier)) !== 0;
  const typed =
    type === "down" && !withCommand
      ? (text ?? (printable ? key : key === "Enter" ? "\r" : undefined))
      : undefined;
  const vk = keyCodes[key] ?? (printable ? key.toUpperCase().charCodeAt(0) : 0);
  return {
    type: type === "up" ? "keyUp" : typed ? "keyDown" : "rawKeyDown",
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
    ...(typed ? { text: typed } : {}),
  };
}

function codeFor(key: string): string {
  if (key.length === 1) {
    return /[a-z]/i.test(key)
      ? `Key${key.toUpperCase()}`
      : /\d/.test(key)
        ? `Digit${key}`
        : key === " "
          ? "Space"
          : "";
  }
  return key;
}

export function parseKeyCombo(combo: string): KeyInput {
  const parts = combo.split("+");
  const key = parts[parts.length - 1] === "" ? "+" : parts[parts.length - 1];
  const modifiers = parts
    .slice(0, -1)
    .reduce((bits, part) => bits | (modifierBits[part] ?? 0), 0);
  return { type: "down", key, code: codeFor(key), modifiers };
}

function centreOf(quad: number[]): { x: number; y: number } {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

const defaultLookup: AddressLookup = async (host) =>
  (await dnsLookup(host, { all: true })).map((entry) => entry.address);

// A dedicated browser serves one room, so the page opens as a tab of its one (kiosk) window
// instead of in a browser context of its own, which headed Chromium would open as a second,
// decorated window.
export async function createBrowserSession({
  cdpUrl,
  viewport,
  dedicated = false,
  lookup = defaultLookup,
  onFrame,
  onNavigated,
  onClosed,
}: {
  cdpUrl: string;
  viewport: BrowserViewport;
  dedicated?: boolean;
  lookup?: AddressLookup;
  onFrame: (frame: ScreencastFrame) => void;
  onNavigated: (page: PageInfo) => void;
  onClosed: () => void;
}): Promise<BrowserSession> {
  const client = await connectCdp(cdpUrl);
  let open = true;
  client.onClose(() => {
    open = false;
    onClosed();
  });

  const browserContextId = dedicated
    ? undefined
    : (
        await client.send<{ browserContextId: string }>(
          "Target.createBrowserContext",
          { disposeOnDetach: true }
        )
      ).browserContextId;
  const { targetId } = await client.send<{ targetId: string }>(
    "Target.createTarget",
    {
      url: "about:blank",
      ...(browserContextId
        ? { browserContextId, width: viewport.width, height: viewport.height }
        : {}),
    }
  );
  const { sessionId } = await client.send<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId, flatten: true }
  );
  const send = <T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ) => client.send<T>(method, params, sessionId);
  const onEvent = (method: string, handler: (params: unknown) => void) =>
    client.on(method, (params, eventSession) => {
      if (eventSession === sessionId) {
        handler(params);
      }
    });

  const lookups = new Map<string, { at: number; result: Promise<string[]> }>();
  const cachedLookup: AddressLookup = (host) => {
    const cached = lookups.get(host);
    if (cached && Date.now() - cached.at < lookupTtlMs) {
      return cached.result;
    }
    const result = lookup(host);
    lookups.set(host, { at: Date.now(), result });
    return result;
  };

  onEvent("Fetch.requestPaused", (params) => {
    if (!isRecord(params) || typeof params.requestId !== "string") {
      return;
    }
    const { requestId } = params;
    const url =
      isRecord(params.request) && typeof params.request.url === "string"
        ? params.request.url
        : "";
    void checkUrl(url, cachedLookup).then((check) =>
      send(
        check.ok ? "Fetch.continueRequest" : "Fetch.failRequest",
        check.ok ? { requestId } : { requestId, errorReason: "AccessDenied" }
      ).catch(() => {})
    );
  });

  onEvent("Page.screencastFrame", (params) => {
    if (!isRecord(params) || typeof params.data !== "string") {
      return;
    }
    const metadata = isRecord(params.metadata) ? params.metadata : {};
    onFrame({
      data: params.data,
      width:
        typeof metadata.deviceWidth === "number"
          ? metadata.deviceWidth
          : viewport.width,
      height:
        typeof metadata.deviceHeight === "number"
          ? metadata.deviceHeight
          : viewport.height,
    });
    void send("Page.screencastFrameAck", {
      sessionId: params.sessionId,
    }).catch(() => {});
  });

  onEvent("Page.javascriptDialogOpening", () => {
    void send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
  });

  const pageInfo = async (): Promise<PageInfo> => {
    const { result } = await send<{ result: { value?: unknown } }>(
      "Runtime.evaluate",
      {
        expression:
          "JSON.stringify({ url: location.href, title: document.title })",
        returnByValue: true,
      }
    );
    try {
      const parsed: unknown =
        typeof result.value === "string" ? JSON.parse(result.value) : null;
      if (
        isRecord(parsed) &&
        typeof parsed.url === "string" &&
        typeof parsed.title === "string"
      ) {
        return { url: parsed.url, title: parsed.title };
      }
    } catch {}
    return { url: "about:blank", title: "" };
  };

  let announceTimer: NodeJS.Timeout | null = null;
  const announceNavigation = () => {
    if (announceTimer) {
      clearTimeout(announceTimer);
    }
    announceTimer = setTimeout(() => {
      announceTimer = null;
      if (open) {
        void pageInfo().then(onNavigated, () => {});
      }
    }, 300);
  };
  onEvent("Page.frameNavigated", (params) => {
    if (isRecord(params) && isRecord(params.frame) && !params.frame.parentId) {
      announceNavigation();
    }
  });
  onEvent("Page.navigatedWithinDocument", announceNavigation);
  onEvent("Page.loadEventFired", announceNavigation);

  await send("Page.enable");
  await send("DOM.enable");
  await send("Accessibility.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.send("Browser.setDownloadBehavior", {
    behavior: "deny",
    ...(browserContextId ? { browserContextId } : {}),
  });
  await send("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  });
  await send("Page.startScreencast", {
    format: "jpeg",
    quality: screencastQuality,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  });

  const waitForLoad = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, loadTimeoutMs);
      const off = onEvent("Page.loadEventFired", done);
      function done() {
        clearTimeout(timer);
        off();
        resolve();
      }
    });

  const mouse = ({
    type,
    x,
    y,
    button = "none",
    clickCount = 0,
    modifiers = 0,
  }: MouseInput) =>
    send("Input.dispatchMouseEvent", {
      type:
        type === "move"
          ? "mouseMoved"
          : type === "down"
            ? "mousePressed"
            : "mouseReleased",
      x,
      y,
      button,
      clickCount,
      modifiers,
    }).then(() => {});

  const key = (input: KeyInput) =>
    send("Input.dispatchKeyEvent", keyEventParams(input)).then(() => {});

  const press = async (combo: string) => {
    const down = parseKeyCombo(combo);
    await key(down);
    await key({ ...down, type: "up" });
  };

  let lastRefs: Record<string, number> = {};
  const resolveRef = (ref: string): number => {
    const nodeId = lastRefs[ref];
    if (nodeId === undefined) {
      throw new Error(
        `${ref} is not on the page you last read; read the page again.`
      );
    }
    return nodeId;
  };

  const locate = async (backendNodeId: number) => {
    await send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
    const { model } = await send<{ model: { content: number[] } }>(
      "DOM.getBoxModel",
      { backendNodeId }
    );
    return centreOf(model.content);
  };

  return {
    async navigate(url) {
      const check = await checkUrl(url, cachedLookup);
      if (!check.ok) {
        return { ok: false, reason: check.reason };
      }
      const load = waitForLoad();
      const result = await send<{ errorText?: string }>("Page.navigate", {
        url: check.url.toString(),
      });
      if (result.errorText) {
        return { ok: false, reason: result.errorText };
      }
      await load;
      return { ok: true, ...(await pageInfo()) };
    },

    async back() {
      const { currentIndex, entries } = await send<{
        currentIndex: number;
        entries: { id: number }[];
      }>("Page.getNavigationHistory");
      const entry = entries[currentIndex - 1];
      if (entry) {
        await send("Page.navigateToHistoryEntry", { entryId: entry.id });
      }
    },

    async forward() {
      const { currentIndex, entries } = await send<{
        currentIndex: number;
        entries: { id: number }[];
      }>("Page.getNavigationHistory");
      const entry = entries[currentIndex + 1];
      if (entry) {
        await send("Page.navigateToHistoryEntry", { entryId: entry.id });
      }
    },

    async reload() {
      await send("Page.reload");
    },

    mouse,

    async wheel({ x, y, deltaX, deltaY, modifiers = 0 }) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
        modifiers,
      });
    },

    key,

    async insertText(text) {
      await send("Input.insertText", { text });
    },

    press,

    async click(ref) {
      const at = await locate(resolveRef(ref));
      await mouse({ type: "move", ...at });
      await mouse({ type: "down", ...at, button: "left", clickCount: 1 });
      await mouse({ type: "up", ...at, button: "left", clickCount: 1 });
      return at;
    },

    async type(ref, text, submit = false) {
      const backendNodeId = resolveRef(ref);
      const at = await locate(backendNodeId);
      const { object } = await send<{ object: { objectId?: string } }>(
        "DOM.resolveNode",
        { backendNodeId }
      );
      if (object.objectId) {
        await send("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration:
            "function() { this.focus(); if ('value' in this && !this.isContentEditable) { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); } }",
        });
      }
      await send("Input.insertText", { text });
      if (submit) {
        await press("Enter");
      }
      return at;
    },

    async readOutline() {
      const { nodes } = await send<{ nodes: AxNode[] }>(
        "Accessibility.getFullAXTree"
      );
      const outline = outlineFromAxTree(nodes);
      lastRefs = outline.refs;
      return outline;
    },

    pageInfo,

    async screenshot() {
      const { data } = await send<{ data: string }>("Page.captureScreenshot", {
        format: "jpeg",
        quality: screencastQuality,
      });
      return data;
    },

    isOpen: () => open,

    async close() {
      if (!open) {
        return;
      }
      open = false;
      await client.send("Target.closeTarget", { targetId }).catch(() => {});
      if (browserContextId) {
        await client
          .send("Target.disposeBrowserContext", { browserContextId })
          .catch(() => {});
      }
      client.close();
    },
  };
}
