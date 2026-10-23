import type { ChatMessage } from "@memo-air/chat";
import { readLastAdded, readMessages } from "@memo-air/chat";
import { docText } from "@memo-air/server";
import type * as Y from "yjs";
import { fileText } from "./extract.ts";
import type { ChannelObject, createStore, SearchHit } from "./store.ts";

type Store = ReturnType<typeof createStore>;

const partChars = 1500;
// Each save re-reads this many of the latest-arrived messages, which completes a reply still
// streaming and catches a recent edit.
// ponytail: an edit to an older message keeps its old text in the index; re-read on edit if that bites.
const rereadMessages = 100;
const placeLine = /^--- .+ ---$/;
const textKinds = new Set(["doc", "sheet", "slides", "canvas"]);

// Splits text into parts of about partChars at line ends, so a hit is a passage rather than a
// whole file. A part that starts inside a page, sheet or slide repeats that place's marker line.
export function chunkText(text: string): string[] {
  const parts: string[] = [];
  let lines: string[] = [];
  let size = 0;
  let place: string | null = null;
  const flush = () => {
    const body = lines.join("\n").trim();
    if (body) {
      parts.push(body);
    }
    lines = [];
    size = 0;
  };
  for (const line of text.split("\n")) {
    if (placeLine.test(line)) {
      place = line;
    }
    for (let start = 0; start < Math.max(line.length, 1); start += partChars) {
      const piece = line.slice(start, start + partChars);
      if (size + piece.length > partChars && size > 0) {
        flush();
        if (place && piece !== place) {
          lines.push(place);
          size = place.length;
        }
      }
      lines.push(piece);
      size += piece.length + 1;
    }
  }
  flush();
  return parts;
}

const searchMessage = (message: ChatMessage) => ({
  id: message.id,
  author:
    message.actor.kind === "agent"
      ? `${message.actor.name} (agent)`
      : message.actor.name,
  text: message.text,
  atMs: message.ts,
});

// Keeps each channel's search index in step with its docs: live-server calls `stored` after it
// saves a doc, an upload is indexed once, and `backfill` fills in whatever predates the index.
export function createSearchIndex({
  store,
  readDoc,
}: {
  store: Store;
  readDoc: <T>(docName: string, read: (document: Y.Doc) => T) => Promise<T>;
}) {
  const indexChat = (channelId: string, messages: ChatMessage[]) =>
    store.indexMessages(channelId, messages.map(searchMessage));

  const indexFile = async (object: ChannelObject) => {
    const file = await store.fileBytes(object.docName);
    const read = file ? await fileText(file) : null;
    await store.indexObject(object, read?.ok ? chunkText(read.text) : []);
  };

  const stored = async (docName: string, document: Y.Doc) => {
    const found = await store.docOf(docName);
    if (found?.role === "chat") {
      await indexChat(
        found.channel.id,
        readLastAdded(document, rereadMessages)
      );
    } else if (found?.role === "object" && textKinds.has(found.object.kind)) {
      await store.indexObject(found.object, chunkText(docText(document)));
    }
  };

  // ponytail: one pass over every channel at start; index on demand if start time ever matters.
  const backfill = async () => {
    for (const channel of await store.listChannels()) {
      await readDoc(channel.chatDoc, (document) =>
        indexChat(channel.id, readMessages(document))
      );
      for (const object of await store.objects(channel.id)) {
        if (await store.isIndexed(object.docName)) {
          continue;
        }
        if (object.kind === "file") {
          await indexFile(object);
        } else if (textKinds.has(object.kind)) {
          const text = await readDoc(object.docName, docText);
          await store.indexObject(object, chunkText(text));
        }
      }
    }
  };

  const searchRoom = async (
    chatDoc: string,
    query: string,
    { kinds, limit }: { kinds: string[] | null; limit: number }
  ): Promise<SearchHit[]> => {
    const found = await store.docOf(chatDoc);
    return found ? store.search(found.channel.id, query, { kinds, limit }) : [];
  };

  return { stored, indexFile, backfill, searchRoom };
}

export type SearchIndex = ReturnType<typeof createSearchIndex>;
