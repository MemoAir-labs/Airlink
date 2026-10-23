import type { ChatMessage } from "@memo-air/chat";
import { readAddedAfter } from "@memo-air/chat";
import type * as Y from "yjs";
import type { Complete } from "./settings.ts";
import type { createStore } from "./store.ts";

type Store = ReturnType<typeof createStore>;

// A summary is rewritten once this much chat has piled up past it, so the gap between the summary
// and a turn's latest messages stays small.
const foldChars = 6_000;
// One rewrite reads at most this much new chat; a long backlog folds in over several saves.
const batchChars = 40_000;
const messageChars = 1_000;

const system = `You keep the running summary of a team chat channel where people and AI agents work together. You get the summary so far and the messages since. Rewrite the whole summary to include them, in at most 500 words of plain Markdown:
- Decisions made, and who made them
- Open questions and requests, and who they wait on
- Who owns what, and deadlines
- Key facts, figures and names, exactly as written
- Live objects (docs, sheets, slides, files) mentioned, by title
Drop small talk and anything already superseded. Cite the message id in [brackets] for each decision or figure so it can be read in full. Write only the summary.`;

const line = (message: ChatMessage) =>
  `[${message.id}] ${message.actor.name}${message.actor.kind === "agent" ? " (agent)" : ""}: ${message.text.slice(0, messageChars)}`;

// Each channel keeps one summary of its chat, stored with the last message it covers.
// ponytail: the one-rewrite-at-a-time guard is per process; a second instance may rewrite the same
// fold once, and the later write wins.
export function createBriefs({
  store,
  complete,
  logger,
}: {
  store: Store;
  complete: () => Promise<Complete | null>;
  logger: { error(obj: object, msg: string): void };
}) {
  const folding = new Set<string>();

  const fold = async (channelId: string, document: Y.Doc) => {
    const kept = await store.brief(channelId);
    const pending = readAddedAfter(document, kept?.uptoMessage ?? null);
    if (pending.map(line).join("\n").length < foldChars) {
      return;
    }
    const batch: string[] = [];
    let size = 0;
    let upto = "";
    for (const message of pending) {
      const text = line(message);
      if (size + text.length > batchChars && batch.length > 0) {
        break;
      }
      batch.push(text);
      size += text.length + 1;
      upto = message.id;
    }
    const write = await complete();
    const summary = await write?.({
      system,
      prompt: `Summary so far:\n${kept?.summary ?? "(none yet)"}\n\nMessages since, oldest first:\n${batch.join("\n")}`,
      maxTokens: 1_200,
    });
    if (summary) {
      await store.saveBrief(channelId, summary, upto);
    }
  };

  return {
    // Called after a chat is saved; the rewrite runs in the background and never holds the save.
    stored: async (docName: string, document: Y.Doc) => {
      const found = await store.docOf(docName);
      if (found?.role !== "chat" || folding.has(found.channel.id)) {
        return;
      }
      const channelId = found.channel.id;
      folding.add(channelId);
      void fold(channelId, document)
        .catch((err) =>
          logger.error({ err, channelId }, "airlink: summary failed")
        )
        .finally(() => folding.delete(channelId));
    },
    summaryOf: async (chatDoc: string) => {
      const found = await store.docOf(chatDoc);
      return found
        ? ((await store.brief(found.channel.id))?.summary ?? null)
        : null;
    },
  };
}

export type Briefs = ReturnType<typeof createBriefs>;
