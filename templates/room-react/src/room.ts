import type { LiveHostDoc } from "@memo-air/react";

// The room's objects. The space places the other three as windows the first time a writer opens it.
export const roomDocs: LiveHostDoc[] = [
  { sId: "room-space", title: "Room", kind: "space", conversationId: "room" },
  { sId: "room-notes", title: "Notes", kind: "doc", conversationId: "room" },
  {
    sId: "room-sheet",
    title: "Numbers",
    kind: "sheet",
    conversationId: "room",
  },
  {
    sId: "room-canvas",
    title: "Sketch",
    kind: "canvas",
    conversationId: "room",
  },
];
