import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import { useEffect, useState } from "react";
import * as Y from "yjs";

export type LivePeer = {
  clientId: number;
  name: string;
  color: string;
  kind: "human" | "agent";
  hasCursor: boolean;
  // The signed-in user's id, so a person's own other tabs can be told apart from other people.
  userId: string | null;
  cell: { rowId: string; colId: string } | null;
  // On a canvas or a space: where the peer's pointer is, in scene coordinates.
  pointer: { x: number; y: number } | null;
  // On a space: the object an agent just placed.
  objectId: string | null;
  // An agent reading the object, with no caret or cell of its own there yet.
  reading: boolean;
  // On live slides: the slide and element the peer is on (an agent's focus or a person's
  // selection), and their pointer in slide coordinates.
  slide: {
    slideId: string;
    elementId: string | null;
    pointer: { x: number; y: number } | null;
  } | null;
};

function slidePresenceOf(state: Record<string, unknown>): LivePeer["slide"] {
  const focus = isRecord(state.slideFocus)
    ? state.slideFocus
    : isRecord(state.slideSelection)
      ? state.slideSelection
      : null;
  const pointer = isRecord(state.slidePointer) ? state.slidePointer : null;
  const slideId =
    typeof focus?.slideId === "string"
      ? focus.slideId
      : typeof pointer?.slideId === "string"
        ? pointer.slideId
        : null;
  if (!slideId) {
    return null;
  }
  return {
    slideId,
    elementId: typeof focus?.elementId === "string" ? focus.elementId : null,
    pointer:
      pointer?.slideId === slideId &&
      typeof pointer.x === "number" &&
      typeof pointer.y === "number"
        ? { x: pointer.x, y: pointer.y }
        : null,
  };
}

export type LiveDocSession = {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
};

const peerPalette = [
  "#2563eb",
  "#db2777",
  "#047857",
  "#b45309",
  "#a21caf",
  "#0e7490",
  "#dc2626",
];

export function colorForId(id: string): string {
  const hash = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return peerPalette[hash % peerPalette.length];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPeers(provider: HocuspocusProvider): LivePeer[] {
  const awareness = provider.awareness;
  if (!awareness) {
    return [];
  }
  return [...awareness.getStates().entries()].flatMap(([clientId, state]) => {
    const user: unknown = state.user;
    if (
      clientId === awareness.clientID ||
      !isRecord(user) ||
      typeof user.name !== "string"
    ) {
      return [];
    }
    return [
      {
        clientId,
        name: user.name,
        color: typeof user.color === "string" ? user.color : peerPalette[0],
        kind: user.kind === "agent" ? "agent" : "human",
        hasCursor:
          isRecord(state.cursor) ||
          isRecord(state.cell) ||
          isRecord(state.pointer) ||
          isRecord(state.slideFocus),
        userId: typeof user.id === "string" ? user.id : null,
        cell:
          isRecord(state.cell) &&
          typeof state.cell.rowId === "string" &&
          typeof state.cell.colId === "string"
            ? { rowId: state.cell.rowId, colId: state.cell.colId }
            : null,
        pointer:
          isRecord(state.pointer) &&
          typeof state.pointer.x === "number" &&
          typeof state.pointer.y === "number"
            ? { x: state.pointer.x, y: state.pointer.y }
            : null,
        objectId: typeof state.objectId === "string" ? state.objectId : null,
        reading: state.reading === true,
        slide: slidePresenceOf(state),
      },
    ];
  });
}

export function useLiveDocSession({
  url,
  docId,
  fetchToken,
}: {
  url: string | undefined;
  docId: string;
  fetchToken: () => Promise<string>;
}) {
  const [session, setSession] = useState<LiveDocSession | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  // Sticky: the editor mounts once, after the first full sync, so nothing typed before the
  // server state arrives can land in an empty doc. Reconnects keep it mounted.
  const [hasSynced, setHasSynced] = useState(false);
  const [peers, setPeers] = useState<LivePeer[]>([]);

  useEffect(() => {
    if (!url) {
      return;
    }
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url,
      name: docId,
      document: ydoc,
      token: fetchToken,
      onStatus: ({ status }) =>
        setIsConnected(status === WebSocketStatus.Connected),
      onSynced: ({ state }) => {
        if (state) {
          setHasSynced(true);
        }
      },
    });
    const onAwarenessChange = () => setPeers(readPeers(provider));
    provider.awareness?.on("change", onAwarenessChange);
    setSession({ ydoc, provider });

    return () => {
      provider.awareness?.off("change", onAwarenessChange);
      provider.destroy();
      ydoc.destroy();
      setSession(null);
      setHasSynced(false);
      setPeers([]);
    };
  }, [url, docId, fetchToken]);

  return {
    session,
    isConnected,
    hasSynced,
    peers,
  };
}
