import type { Connection } from "@hocuspocus/server";
import type {
  BrowserSession,
  PageInfo,
  ScreencastFrame,
} from "@memo-air/browser/session";
import type {
  ExtensionMessage,
  ExtensionRequest,
  LiveActor,
} from "@memo-air/protocol";
import { extensionMessageSchema } from "@memo-air/protocol";
import type { Logger } from "pino";

const requestTimeoutMs = 90_000;
const unsupported = () =>
  Promise.reject(
    new Error(
      "The person's own tab takes input from them, not from the room; ask them, or use click and type by reference."
    )
  );

type Pending = {
  resolve: (
    message: Extract<ExtensionMessage, { type: "ext_response" }>
  ) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

// A browser session served by the person's own tab through the extension. Reads and the page
// come back on their own; clicks, typing and navigation come back only once the person has
// approved them in the sidebar, which is why requests may take a while.
export function createExtensionSession({
  connection,
  actor,
  onFrame,
  onNavigated,
  onClosed,
  logger,
}: {
  connection: Connection;
  actor: LiveActor;
  onFrame: (frame: ScreencastFrame) => void;
  onNavigated: (page: PageInfo) => void;
  onClosed: () => void;
  logger: Logger;
}) {
  const pending = new Map<string, Pending>();
  let open = true;
  let lastFrame: ScreencastFrame | null = null;
  let page: PageInfo = { url: "about:blank", title: "" };

  const request = (
    requester: LiveActor,
    body: ExtensionRequest["request"]
  ): Promise<Extract<ExtensionMessage, { type: "ext_response" }>> =>
    new Promise((resolve, reject) => {
      if (!open) {
        reject(new Error("The shared tab is no longer connected."));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("The person did not answer in time."));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      const message: ExtensionRequest = {
        type: "ext_request",
        id,
        actor: requester,
        request: body,
      };
      connection.sendStateless(JSON.stringify(message));
    });

  const act = async (
    requester: LiveActor,
    body: ExtensionRequest["request"]
  ) => {
    const response = await request(requester, body);
    if (!response.ok) {
      throw new Error(response.error ?? "The person declined.");
    }
    return response;
  };

  let requester: LiveActor = actor;

  const session: BrowserSession & {
    handle(payload: string): boolean;
    detach(): void;
    actingFor(actor: LiveActor): void;
  } = {
    actingFor(next) {
      requester = next;
    },

    handle(payload) {
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return false;
      }
      const message = extensionMessageSchema.safeParse(raw);
      if (!message.success) {
        return false;
      }
      switch (message.data.type) {
        case "ext_frame":
          lastFrame = {
            data: message.data.data,
            width: message.data.width,
            height: message.data.height,
          };
          onFrame(lastFrame);
          return true;
        case "ext_page":
          page = { url: message.data.url, title: message.data.title };
          onNavigated(page);
          return true;
        case "ext_response": {
          const waiter = pending.get(message.data.id);
          if (waiter) {
            pending.delete(message.data.id);
            clearTimeout(waiter.timer);
            waiter.resolve(message.data);
          }
          return true;
        }
      }
    },

    detach() {
      if (!open) {
        return;
      }
      open = false;
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("The shared tab disconnected."));
      }
      pending.clear();
      onClosed();
    },

    async navigate(url) {
      try {
        const response = await act(requester, { kind: "navigate", url });
        page = response.page ?? page;
        return { ok: true, ...page };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : "navigation failed",
        };
      }
    },
    back: async () => {
      await act(requester, { kind: "back" });
    },
    forward: async () => {
      await act(requester, { kind: "forward" });
    },
    reload: async () => {
      await act(requester, { kind: "reload" });
    },
    mouse: unsupported,
    wheel: unsupported,
    key: unsupported,
    insertText: unsupported,
    async press(combo) {
      await act(requester, { kind: "press", key: combo });
    },
    async click(ref) {
      await act(requester, { kind: "click", ref });
      return { x: 0, y: 0 };
    },
    async type(ref, text, submit) {
      await act(requester, { kind: "type", ref, text, submit });
      return { x: 0, y: 0 };
    },
    async readOutline() {
      const response = await act(requester, { kind: "read" });
      return response.outline ?? { lines: [], refs: {} };
    },
    async pageInfo() {
      const response = await request(requester, { kind: "page" }).catch(
        (err) => {
          logger.warn({ err }, "live: shared tab page read failed");
          return null;
        }
      );
      page = response?.page ?? page;
      return page;
    },
    async screenshot() {
      return lastFrame?.data ?? "";
    },
    isOpen: () => open,
    async close() {
      session.detach();
    },
  };
  return session;
}

export type ExtensionSession = ReturnType<typeof createExtensionSession>;
