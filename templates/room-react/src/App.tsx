import type { LiveDocViewProps } from "@memo-air/react";
import {
  createLiveServerHost,
  LiveHostProvider,
  LiveSpaceView,
} from "@memo-air/react";
import { LiveCanvasView } from "@memo-air/react/canvas";
import { LiveDocView } from "@memo-air/react/doc";
import { LiveSheetView } from "@memo-air/react/sheet";
import type { ComponentType } from "react";

import { roomDocs } from "./room.ts";

// One guest per tab, so two tabs show two people's cursors.
const guestId =
  sessionStorage.getItem("airlink-guest") ??
  `guest-${crypto.randomUUID().slice(0, 8)}`;
sessionStorage.setItem("airlink-guest", guestId);
const user = { id: guestId, name: `Guest ${guestId.slice(6, 10)}` };

const host = createLiveServerHost({
  liveUrl: import.meta.env.VITE_LIVE_URL ?? "ws://localhost:3020",
  docs: roomDocs,
  user,
  getToken: async (docId) => {
    const query = new URLSearchParams({
      doc: docId,
      id: user.id,
      name: user.name,
    });
    const response = await fetch(`/api/token?${query}`);
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "token" in body &&
      typeof body.token === "string"
    ) {
      return body.token;
    }
    throw new Error(`No token for ${docId} (${response.status}).`);
  },
});

const views: Record<string, ComponentType<LiveDocViewProps>> = {
  doc: LiveDocView,
  sheet: LiveSheetView,
  canvas: LiveCanvasView,
};
const kindOf = new Map(roomDocs.map((doc) => [doc.sId, doc.kind]));

export function App() {
  return (
    <LiveHostProvider host={host}>
      <LiveSpaceView
        docId="room-space"
        agents={[]}
        className="h-full"
        renderHeader={({ title, actions }) => (
          <header className="flex items-center justify-between border-b border-border px-4 py-2">
            <h1 className="text-sm font-semibold">{title}</h1>
            {actions}
          </header>
        )}
        renderObject={(object) => {
          const View = views[kindOf.get(object.docId) ?? ""];
          return View ? <View {...object} /> : null;
        }}
      />
    </LiveHostProvider>
  );
}
