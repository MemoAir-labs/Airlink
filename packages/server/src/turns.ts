import type { Hocuspocus } from "@hocuspocus/server";
import type { RoomEvent } from "@memo-air/agents";
import { deservesTurn } from "@memo-air/agents";
import { readBrowserState } from "@memo-air/browser";
import { readCanvas } from "@memo-air/canvas";
import type { ChatMessage } from "@memo-air/chat";
import { isChatDoc, readMessages } from "@memo-air/chat";
import type { Decide, Decision, DecisionRecord } from "@memo-air/decide";
import { loggedDecide } from "@memo-air/decide";
import type { LiveActor } from "@memo-air/protocol";
import { signLiveServiceToken } from "@memo-air/protocol/tokens";
import { docFragment, exportMarkdown, readThreads } from "@memo-air/richtext";
import { readGrid } from "@memo-air/sheet";
import { readDeck } from "@memo-air/slides";
import { readSpace } from "@memo-air/space";
import type { Logger } from "pino";
import type * as Y from "yjs";

import { kindOf } from "./kind.ts";
import type { LiveMetrics } from "./metrics.ts";
import type { LivePersistence } from "./persistence.ts";

// Full duplex is a property of the loop: an agent may act on any room event, not only on a
// message. The events are here and the agents are the host's, so live-server decides *whether*
// an event deserves a turn — one yes/no, logged with its odds — and tells the host, which decides
// who. A person's edits count once they stop: the settle timer turns a burst into one event.

export type Turn = {
  docName: string;
  workspaceId: string | null;
  event: {
    type: string;
    actor: LiveActor;
    payload: Record<string, unknown>;
    summary: string;
  };
  // Null for a chat message: who answers a message is the host's routing, not a yes/no here.
  decision: Decision | null;
};

export const messageEventType = "message";

export const settledEventType = "edit_settled";
const candidateTypes = new Set([
  settledEventType,
  "comment",
  "browser_navigate",
  "suggestion_accepted",
  "suggestion_rejected",
]);
const maxSummaryChars = 2000;

// People comment by writing the doc, so open threads ride along with the text; a `comment` event
// names the thread an agent route touched, which comes first.
const textKeys = /^(text|title|label|body|notes|content|name|caption)$/i;

// The words a person wrote in a view's fields, never its ids, colours or geometry.
const wordsIn = (value: unknown, key = ""): string[] =>
  typeof value === "string"
    ? textKeys.test(key) && value.trim()
      ? [value.trim()]
      : []
    : Array.isArray(value)
      ? value.flatMap((item) => wordsIn(item, key))
      : value && typeof value === "object"
        ? Object.entries(value).flatMap(([k, v]) => wordsIn(v, k))
        : [];

// What a live object says, as plain text for a search index. A `--- <place> ---` line marks where
// each part is, so a hit can name the slide or row range to open.
export function docText(document: Y.Doc): string {
  switch (kindOf(document)) {
    case "doc":
      return exportMarkdown(docFragment(document));
    case "sheet":
      return readGrid(document)
        .inputs.flatMap((row, index) =>
          row.some((cell) => cell.trim())
            ? [`Row ${index + 1}: ${row.join("\t")}`]
            : []
        )
        .join("\n");
    case "slides":
      return readDeck(document)
        .slides.map(
          (slide, index) =>
            `--- Slide ${index + 1} ---\n${[...new Set(wordsIn(slide))].join("\n")}`
        )
        .join("\n\n");
    case "canvas":
      return wordsIn(readCanvas(document)).join("\n");
    default:
      return "";
  }
}

function summarize(document: Y.Doc, payload: Record<string, unknown>): string {
  switch (kindOf(document)) {
    case "doc": {
      const threads = readThreads(document)
        .filter((thread) => !thread.resolved)
        .sort((a, b) =>
          a.id === payload.threadId ? -1 : b.id === payload.threadId ? 1 : 0
        )
        .map(
          (thread) =>
            `Open comment on "${thread.quote}":\n${thread.messages.map((m) => `${m.actor.name}: ${m.body}`).join("\n")}`
        );
      return [...threads, exportMarkdown(docFragment(document))].join("\n\n");
    }
    case "sheet":
      return readGrid(document)
        .inputs.map((row) => row.join("\t"))
        .join("\n");
    case "chat":
      return readMessages(document, { limit: 20 })
        .map((message) => `${message.actor.name}: ${message.text}`)
        .join("\n");
    case "browser": {
      const state = readBrowserState(document);
      return `${state.title}\n${state.url}`;
    }
    case "canvas":
      return JSON.stringify(readCanvas(document));
    case "slides":
      return JSON.stringify(readDeck(document));
    case "space":
      return JSON.stringify(readSpace(document));
    case "desktop":
    case "media":
      return "";
  }
}

export function createTurns({
  hocuspocus,
  persistence,
  decide,
  onTurn,
  metrics,
  logger,
  settleMs = 8_000,
}: {
  hocuspocus: Hocuspocus;
  persistence: LivePersistence;
  decide: Decide;
  onTurn: ((turn: Turn) => Promise<void>) | null;
  metrics: LiveMetrics;
  logger: Logger;
  settleMs?: number;
}) {
  const workspaces = new Map<string, string>();
  const settleTimers = new Map<string, NodeJS.Timeout>();

  const record = (
    entry: DecisionRecord & { docName?: string; workspaceId?: string }
  ) => {
    metrics.decideMs.observe({ provider: entry.provider }, entry.ms);
    persistence
      .recordDecision(entry)
      .catch((err) =>
        logger.error({ err, docName: entry.docName }, "live: decision failed")
      );
  };

  const consider = async (
    docName: string,
    type: string,
    actor: LiveActor,
    payload: Record<string, unknown>
  ) => {
    if (!onTurn || !candidateTypes.has(type) || actor.kind !== "human") {
      return;
    }
    const document = hocuspocus.documents.get(docName);
    if (!document) {
      return;
    }
    const workspaceId = workspaces.get(docName) ?? null;
    const event: RoomEvent & { payload: Record<string, unknown> } = {
      type,
      actor,
      payload,
      summary: summarize(document, payload).slice(0, maxSummaryChars),
    };
    const logged = loggedDecide(decide, (entry) =>
      record({ ...entry, docName, ...(workspaceId ? { workspaceId } : {}) })
    );
    const { turn, decision } = await deservesTurn(event, { decide: logged });
    if (!turn || !decision) {
      return;
    }
    // ponytail: at most once, no retry; upgrade to a live_turns queue when a missed turn matters.
    await onTurn({ docName, workspaceId, event, decision });
  };

  return {
    noteWorkspace(docName: string, workspaceId: string | null) {
      if (workspaceId) {
        workspaces.set(docName, workspaceId);
      }
    },

    // A burst of edits by a person becomes one event when the doc has been quiet for settleMs.
    // A chat is the exception: each message is its own event, so typing in it never settles.
    noteEdit(docName: string, actor: LiveActor) {
      if (!onTurn || actor.kind !== "human") {
        return;
      }
      const document = hocuspocus.documents.get(docName);
      if (document && isChatDoc(document)) {
        return;
      }
      clearTimeout(settleTimers.get(docName));
      settleTimers.set(
        docName,
        setTimeout(() => {
          settleTimers.delete(docName);
          consider(docName, settledEventType, actor, {}).catch((err) =>
            logger.error({ err, docName }, "live: turn failed")
          );
        }, settleMs)
      );
    },

    // A person's chat message goes to the host at once and undecided: it is addressed to the
    // room, and the host routes it by mention, tag and the decision node.
    noteMessage(docName: string, message: ChatMessage) {
      if (!onTurn || message.actor.kind !== "human") {
        return;
      }
      clearTimeout(settleTimers.get(docName));
      settleTimers.delete(docName);
      onTurn({
        docName,
        workspaceId: workspaces.get(docName) ?? null,
        event: {
          type: messageEventType,
          actor: message.actor,
          payload: {
            messageId: message.id,
            text: message.text,
            mentions: message.mentions,
          },
          summary: message.text.slice(0, maxSummaryChars),
        },
        decision: null,
      }).catch((err) =>
        logger.error({ err, docName }, "live: message turn failed")
      );
    },

    consider(
      docName: string,
      type: string,
      actor: LiveActor,
      payload: Record<string, unknown>
    ) {
      consider(docName, type, actor, payload).catch((err) =>
        logger.error({ err, docName, type }, "live: turn failed")
      );
    },

    record,

    destroy() {
      for (const timer of settleTimers.values()) {
        clearTimeout(timer);
      }
      settleTimers.clear();
    },
  };
}

export type LiveTurns = ReturnType<typeof createTurns>;

// A host that runs live-server as its own process receives turns over HTTP, signed with the
// secret both already share, the way the host signs its own service calls.
export function turnWebhook({
  url,
  jwtSecret,
  timeoutMs = 10_000,
}: {
  url: string;
  jwtSecret: string;
  timeoutMs?: number;
}): (turn: Turn) => Promise<void> {
  return async (turn) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${signLiveServiceToken(turn.workspaceId ?? "", jwtSecret)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(turn),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`turn hook responded ${response.status}`);
    }
  };
}
