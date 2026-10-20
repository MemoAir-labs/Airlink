import * as Y from "yjs";

// A chat is one Y.Array of message maps. People post by writing the doc through their own
// connection; agents post through `chat-ops`, which streams a message by appending to its
// Y.Text — nothing is ever rewritten, so chat has none of the block-rewrite ceiling of rich text.
// Chat is never binding: there are no suggestions, and a message is edited only by its author.

export type ChatActor = {
  kind: "human" | "agent";
  id: string;
  name: string;
  color?: string;
  onBehalfOf?: { id: string; name: string };
};

export type ChatMention = { kind: "human" | "agent"; id: string; name: string };

export type ChatAttachment = { docName: string; title?: string };

export type ChatMessage = {
  id: string;
  actor: ChatActor;
  text: string;
  mentions: ChatMention[];
  attachments: ChatAttachment[];
  ts: number;
  editedAt?: number;
  reactions: Record<string, string[]>;
};

export type ChatOpResult =
  | { ok: true; id: string }
  | { ok: false; error: "not_found" | "not_author" | "duplicate" };

export type PostMessageInput = {
  id?: string;
  text: string;
  mentions?: ChatMention[];
  attachments?: ChatAttachment[];
  ts?: number;
};

export const chatMessages = (doc: Y.Doc) =>
  doc.getArray<Y.Map<unknown>>("chatMessages");

export const isChatDoc = (doc: Y.Doc) => chatMessages(doc).length > 0;

const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isActorKind(value: unknown): value is "human" | "agent" {
  return value === "human" || value === "agent";
}

function isMention(value: unknown): value is ChatMention {
  return (
    isRecord(value) &&
    isActorKind(value.kind) &&
    typeof value.id === "string" &&
    typeof value.name === "string"
  );
}

function isActor(value: unknown): value is ChatActor {
  if (!isRecord(value)) {
    return false;
  }
  const { kind, id, name, color, onBehalfOf } = value;
  return (
    isActorKind(kind) &&
    typeof id === "string" &&
    typeof name === "string" &&
    (color === undefined || typeof color === "string") &&
    (onBehalfOf === undefined ||
      (isRecord(onBehalfOf) &&
        typeof onBehalfOf.id === "string" &&
        typeof onBehalfOf.name === "string"))
  );
}

function isAttachment(value: unknown): value is ChatAttachment {
  return (
    isRecord(value) &&
    typeof value.docName === "string" &&
    (value.title === undefined || typeof value.title === "string")
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// ponytail: a linear scan per op; index by id if a chat grows past thousands of messages.
function findMessage(doc: Y.Doc, id: string): Y.Map<unknown> | null {
  for (const message of chatMessages(doc)) {
    if (message.get("id") === id) {
      return message;
    }
  }
  return null;
}

function textOf(message: Y.Map<unknown>): Y.Text | null {
  const text = message.get("text");
  return text instanceof Y.Text ? text : null;
}

function authored(
  message: Y.Map<unknown>,
  actor: ChatActor
): { ok: true; id: string } | { ok: false; error: "not_author" } {
  const author = message.get("actor");
  const id = message.get("id");
  return isActor(author) && author.id === actor.id && typeof id === "string"
    ? { ok: true, id }
    : { ok: false, error: "not_author" };
}

export function postMessage(
  doc: Y.Doc,
  input: PostMessageInput,
  actor: ChatActor
): ChatOpResult {
  const id = input.id ?? newId();
  if (input.id && findMessage(doc, id)) {
    return { ok: false, error: "duplicate" };
  }
  doc.transact(() => {
    const message = new Y.Map<unknown>();
    message.set("id", id);
    message.set("actor", actor);
    message.set("text", new Y.Text(input.text));
    message.set("mentions", input.mentions ?? []);
    message.set("attachments", input.attachments ?? []);
    message.set("ts", input.ts ?? Date.now());
    message.set("reactions", new Y.Map<string[]>());
    chatMessages(doc).push([message]);
  });
  return { ok: true, id };
}

export function appendMessageText(
  doc: Y.Doc,
  id: string,
  delta: string,
  actor: ChatActor
): ChatOpResult {
  const message = findMessage(doc, id);
  const text = message && textOf(message);
  if (!message || !text) {
    return { ok: false, error: "not_found" };
  }
  const owned = authored(message, actor);
  if (!owned.ok) {
    return owned;
  }
  doc.transact(() => text.insert(text.length, delta));
  return owned;
}

export function editMessage(
  doc: Y.Doc,
  id: string,
  newText: string,
  actor: ChatActor
): ChatOpResult {
  const message = findMessage(doc, id);
  const text = message && textOf(message);
  if (!message || !text) {
    return { ok: false, error: "not_found" };
  }
  const owned = authored(message, actor);
  if (!owned.ok) {
    return owned;
  }
  doc.transact(() => {
    text.delete(0, text.length);
    text.insert(0, newText);
    message.set("editedAt", Date.now());
  });
  return owned;
}

export function react(
  doc: Y.Doc,
  id: string,
  emoji: string,
  actor: ChatActor
): ChatOpResult {
  const message = findMessage(doc, id);
  const reactions = message?.get("reactions");
  if (!message || !(reactions instanceof Y.Map)) {
    return { ok: false, error: "not_found" };
  }
  const current = reactions.get(emoji);
  const ids = isStringArray(current) ? current : [];
  const next = ids.includes(actor.id)
    ? ids.filter((actorId) => actorId !== actor.id)
    : [...ids, actor.id];
  doc.transact(() => {
    if (next.length === 0) {
      reactions.delete(emoji);
    } else {
      reactions.set(emoji, next);
    }
  });
  return { ok: true, id };
}

function readMessage(message: Y.Map<unknown>): ChatMessage | null {
  const id = message.get("id");
  const actor = message.get("actor");
  const text = textOf(message);
  const ts = message.get("ts");
  if (
    typeof id !== "string" ||
    !isActor(actor) ||
    !text ||
    typeof ts !== "number"
  ) {
    return null;
  }
  const mentions = message.get("mentions");
  const attachments = message.get("attachments");
  const editedAt = message.get("editedAt");
  const reactions = message.get("reactions");
  return {
    id,
    actor,
    text: text.toString(),
    mentions: Array.isArray(mentions) ? mentions.filter(isMention) : [],
    attachments: Array.isArray(attachments)
      ? attachments.filter(isAttachment)
      : [],
    ts,
    ...(typeof editedAt === "number" ? { editedAt } : {}),
    reactions:
      reactions instanceof Y.Map
        ? Object.fromEntries(
            [...reactions.entries()].flatMap(([emoji, ids]) =>
              isStringArray(ids) ? [[emoji, ids]] : []
            )
          )
        : {},
  };
}

// Messages in time order with the id as tiebreak, so every peer and the server read the same
// sequence whatever order concurrent posts landed in the array.
export function readMessages(
  doc: Y.Doc,
  { since, limit }: { since?: number; limit?: number } = {}
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const message of chatMessages(doc)) {
    const read = readMessage(message);
    if (read && (since === undefined || read.ts > since)) {
      messages.push(read);
    }
  }
  messages.sort(
    (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return limit === undefined ? messages : messages.slice(-limit);
}

// Calls back once per message added to the doc after this point, with the transaction's origin,
// so a host can treat a person's post as an event the moment it lands; edits, reactions and
// streamed text are not new messages.
export function observeNewMessages(
  doc: Y.Doc,
  listener: (message: ChatMessage, origin: unknown) => void
): () => void {
  const messages = chatMessages(doc);
  const observer = (event: Y.YArrayEvent<Y.Map<unknown>>) => {
    for (const delta of event.changes.delta) {
      for (const added of delta.insert ?? []) {
        const read = added instanceof Y.Map ? readMessage(added) : null;
        if (read) {
          listener(read, event.transaction.origin);
        }
      }
    }
  };
  messages.observe(observer);
  return () => messages.unobserve(observer);
}
