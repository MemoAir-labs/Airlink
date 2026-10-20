import { HocuspocusProvider } from "@hocuspocus/provider";
import type {
  BrowserInput,
  BrowserMessage,
  DesktopInput,
  DesktopMessage,
  MediaMessage,
  MediaSignalInput,
} from "@memo-air/protocol";
import {
  activityMessageSchema,
  browserMessageSchema,
  desktopMessageSchema,
  mediaMessageSchema,
} from "@memo-air/protocol";
import * as Y from "yjs";

// The public surface of a live room, for people's clients and for agents alike: join with a
// token the host minted, read and write the room's objects, subscribe to everything that
// happens, send input, speak, and bind your own values into the room. Humans and agents use the
// same calls; what each may do is decided by the token, not by the SDK.

export type Peer = {
  clientId: number;
  name: string;
  color: string;
  kind: "human" | "agent";
  state: Record<string, unknown>;
};

export type RoomEvent =
  | { type: "synced" }
  | { type: "status"; connected: boolean }
  | { type: "update"; origin: "local" | "remote" }
  | { type: "peers"; peers: Peer[] }
  | { type: "browser"; message: BrowserMessage }
  | { type: "desktop"; message: DesktopMessage }
  | { type: "media"; message: MediaMessage }
  | { type: "activity"; summary: unknown }
  | { type: "message"; payload: string };

export type JoinOptions = {
  url: string;
  token: string | (() => Promise<string>);
  docName: string;
  presence?: { name: string; color?: string; kind?: "human" | "agent" };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function peersOf(provider: HocuspocusProvider): Peer[] {
  const awareness = provider.awareness;
  if (!awareness) {
    return [];
  }
  return [...awareness.getStates().entries()].flatMap(([clientId, state]) => {
    const user: unknown = state.user;
    if (clientId === awareness.clientID || !isRecord(user)) {
      return [];
    }
    return [
      {
        clientId,
        name: typeof user.name === "string" ? user.name : "",
        color: typeof user.color === "string" ? user.color : "#888888",
        kind: user.kind === "agent" ? "agent" : "human",
        state: isRecord(state) ? state : {},
      },
    ];
  });
}

function parseStateless(payload: string): RoomEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return { type: "message", payload };
  }
  const browser = browserMessageSchema.safeParse(raw);
  if (browser.success) {
    return { type: "browser", message: browser.data };
  }
  const desktop = desktopMessageSchema.safeParse(raw);
  if (desktop.success) {
    return { type: "desktop", message: desktop.data };
  }
  const media = mediaMessageSchema.safeParse(raw);
  if (media.success) {
    return { type: "media", message: media.data };
  }
  const activity = activityMessageSchema.safeParse(raw);
  if (activity.success) {
    return { type: "activity", summary: activity.data.summary };
  }
  return { type: "message", payload };
}

const bindingsRoot = "bindings";

export function joinRoom({ url, token, docName, presence }: JoinOptions) {
  const doc = new Y.Doc();
  const listeners = new Set<(event: RoomEvent) => void>();
  const emit = (event: RoomEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  const provider = new HocuspocusProvider({
    url,
    name: docName,
    document: doc,
    token,
    onSynced: ({ state }) => {
      if (state) {
        emit({ type: "synced" });
      }
    },
    onStatus: ({ status }) =>
      emit({ type: "status", connected: status === "connected" }),
    onStateless: ({ payload }) => emit(parseStateless(payload)),
  });
  if (presence) {
    provider.setAwarenessField("user", {
      name: presence.name,
      color: presence.color ?? "#2563eb",
      kind: presence.kind ?? "human",
    });
  }
  provider.awareness?.on("change", () =>
    emit({ type: "peers", peers: peersOf(provider) })
  );
  doc.on("update", (_update: Uint8Array, origin: unknown) =>
    emit({ type: "update", origin: origin === provider ? "remote" : "local" })
  );

  const send = (input: BrowserInput | DesktopInput | MediaSignalInput) =>
    provider.sendStateless(JSON.stringify(input));

  return {
    doc,
    provider,

    objects: {
      map: (name: string) => doc.getMap<unknown>(name),
      array: (name: string) => doc.getArray<unknown>(name),
      text: (name: string) => doc.getText(name),
      fragment: (name: string) => doc.getXmlFragment(name),
      names: () => [...doc.share.keys()],
    },

    events: {
      subscribe(listener: (event: RoomEvent) => void): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },

    presence: {
      set(fields: Record<string, unknown>) {
        for (const [key, value] of Object.entries(fields)) {
          provider.setAwarenessField(key, value);
        }
      },
      list: () => peersOf(provider),
    },

    // Raw input for a shared browser, desktop or room; the token decides whether it is applied.
    input: { send },

    // Keeps one of your own values in the room: reads come from the doc, writes go to it, and
    // every peer that bound the same key sees the change. The guard says what a valid value
    // looks like, since another peer may have written anything under that key.
    bind: <T>(
      key: string,
      initial: T,
      isValue: (value: unknown) => value is T,
      onChange: (value: T) => void
    ) => bindValue(doc, key, initial, isValue, onChange),

    leave() {
      provider.destroy();
      doc.destroy();
      listeners.clear();
    },
  };
}

export type LiveRoom = ReturnType<typeof joinRoom>;

export type Binding<T> = {
  get(): T;
  set(value: T): void;
  unbind(): void;
};

export function bindValue<T>(
  doc: Y.Doc,
  key: string,
  initial: T,
  isValue: (value: unknown) => value is T,
  onChange: (value: T) => void
): Binding<T> {
  const bindings = doc.getMap<unknown>(bindingsRoot);
  if (!bindings.has(key)) {
    bindings.set(key, initial);
  }
  const current = (): T => {
    const value = bindings.get(key);
    return isValue(value) ? value : initial;
  };
  const observer = (event: Y.YMapEvent<unknown>) => {
    if (event.keysChanged.has(key)) {
      onChange(current());
    }
  };
  bindings.observe(observer);
  return {
    get: current,
    set(value: T) {
      bindings.set(key, value);
    },
    unbind() {
      bindings.unobserve(observer);
    },
  };
}

// Agents act through HTTP with their own token, using @memo-air/agent: the same client the
// host's tools use. It stays out of this package so browser bundles never pull in Node code.

export type {
  BrowserInput,
  BrowserMessage,
  DesktopInput,
  DesktopMessage,
  MediaMessage,
  MediaSignalInput,
} from "@memo-air/protocol";
