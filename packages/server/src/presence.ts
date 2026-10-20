import type { Document } from "@hocuspocus/server";
import type { LiveActor } from "@memo-air/protocol";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";

import type { LiveActivity } from "./activity.ts";

const caretLingerMs = 5000;
// An agent re-reading what it just wrote is still writing; only a read after a pause reads.
const rereadMs = 2000;
const agentColor = "#6d28d9";

// An agent's caret, cell, pointer or focus is a synthetic awareness entry on the doc, so every
// client renders it the way it renders a person. It lingers a moment after the last op and is
// then removed, which also clears the "writing" line on the card.
export function createPresence({ activity }: { activity: LiveActivity }) {
  const entries = new Map<
    string,
    { awareness: Awareness; timer: NodeJS.Timeout | null; wroteAtMs: number }
  >();

  return {
    show(
      document: Document,
      docName: string,
      actor: LiveActor,
      position: Record<string, unknown>,
      section: string | null,
      // A read shows where the agent is looking but writes nothing: it keeps any caret the agent
      // already has there, adds that it is reading, and never marks it as writing.
      { writing = true }: { writing?: boolean } = {}
    ) {
      const key = `${docName}\u0000${actor.id}`;
      const existing = entries.get(key);
      const entry = existing ?? {
        awareness: new Awareness(new Y.Doc()),
        timer: null,
        wroteAtMs: 0,
      };
      entries.set(key, entry);
      const linger = () => {
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
        entry.timer = setTimeout(() => {
          removeAwarenessStates(
            document.awareness,
            [entry.awareness.clientID],
            "agent"
          );
          entry.awareness.destroy();
          entries.delete(key);
          activity.clearWriter(docName, actor.id);
        }, caretLingerMs);
      };
      if (existing && !writing && Date.now() - entry.wroteAtMs < rereadMs) {
        linger();
        return;
      }
      if (existing && !writing) {
        entry.awareness.setLocalState({
          ...entry.awareness.getLocalState(),
          reading: true,
        });
        applyAwarenessUpdate(
          document.awareness,
          encodeAwarenessUpdate(entry.awareness, [entry.awareness.clientID]),
          "agent"
        );
        linger();
        return;
      }
      entry.awareness.setLocalState({
        user: {
          name: actor.name,
          color: actor.color ?? agentColor,
          kind: "agent",
        },
        ...position,
      });
      if (writing) {
        entry.wroteAtMs = Date.now();
        activity.noteWriter(docName, actor, section);
      }
      applyAwarenessUpdate(
        document.awareness,
        encodeAwarenessUpdate(entry.awareness, [entry.awareness.clientID]),
        "agent"
      );
      linger();
    },

    // Ends an agent's presence at once, as when the reply it was typing has landed.
    hide(document: Document, docName: string, actor: LiveActor) {
      const key = `${docName}\u0000${actor.id}`;
      const entry = entries.get(key);
      if (!entry) {
        return;
      }
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      removeAwarenessStates(
        document.awareness,
        [entry.awareness.clientID],
        "agent"
      );
      entry.awareness.destroy();
      entries.delete(key);
      activity.clearWriter(docName, actor.id);
    },
  };
}

export type LivePresence = ReturnType<typeof createPresence>;
