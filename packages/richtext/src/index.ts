import {
  type AnyExtension,
  Extension,
  getSchema,
  type JSONContent,
} from "@tiptap/core";
import UniqueID from "@tiptap/extension-unique-id";
import { MarkdownManager } from "@tiptap/markdown";
import { Node as PmNode, type Schema } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import {
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";

export type { JSONContent } from "@tiptap/core";

export const blockTypes = [
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "horizontalRule",
];

export type Suggestion = {
  id: string;
  kind: "insert" | "delete";
  actorId: string;
  actorName: string;
  approver?: string;
  approverId?: string;
};

// Built on first use, not at import: an app that only reads the Y.Doc never pays for TipTap.
const suggestionAttribute = () =>
  Extension.create({
    name: "suggestion",
    addGlobalAttributes() {
      return [
        {
          types: blockTypes,
          attributes: {
            suggestion: {
              default: null,
              parseHTML: (element) => {
                const raw = element.getAttribute("data-suggestion");
                return raw ? JSON.parse(raw) : null;
              },
              renderHTML: (attributes) =>
                attributes.suggestion
                  ? {
                      "data-suggestion": JSON.stringify(attributes.suggestion),
                      "data-suggestion-kind": attributes.suggestion.kind,
                    }
                  : {},
            },
          },
        },
      ];
    },
  });

let extensions: AnyExtension[] | undefined;
export function richTextExtensions(): AnyExtension[] {
  extensions ??= [
    StarterKit.configure({ undoRedo: false }),
    UniqueID.configure({ types: blockTypes }),
    suggestionAttribute(),
  ];
  return extensions;
}

let schema: Schema | undefined;
export function richTextSchema(): Schema {
  schema ??= getSchema(richTextExtensions());
  return schema;
}

let markdownManager: MarkdownManager | undefined;
const markdown = () => {
  markdownManager ??= new MarkdownManager({ extensions: richTextExtensions() });
  return markdownManager;
};

export const docFragmentName = "default";

export function docFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(docFragmentName);
}

export type OutlineBlock = {
  blockId: string;
  type: string;
  text: string;
  suggestion: Suggestion | null;
};

// y-tiptap 3.0.10+ validates the doc and throws on an empty or not-yet-synced fragment; a doc
// with nothing readable yet reads as no blocks instead of unmounting every view that reads it.
function rootNodeOf(fragment: Y.XmlFragment): PmNode | null {
  try {
    return yXmlFragmentToProseMirrorRootNode(fragment, richTextSchema());
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
}

export function readBlocks(fragment: Y.XmlFragment): JSONContent[] {
  return rootNodeOf(fragment)?.toJSON().content ?? [];
}

export function readOutline(fragment: Y.XmlFragment): OutlineBlock[] {
  return (rootNodeOf(fragment)?.content.content ?? []).map((node) => ({
    blockId: node.attrs.id,
    type:
      node.type.name === "heading"
        ? `heading${node.attrs.level}`
        : node.type.name,
    text: node.textBetween(0, node.content.size, "\n", "\n"),
    suggestion: node.attrs.suggestion,
  }));
}

function withIds(node: JSONContent): JSONContent {
  const needsId = blockTypes.includes(node.type ?? "") && !node.attrs?.id;
  return {
    ...node,
    ...(needsId ? { attrs: { ...node.attrs, id: crypto.randomUUID() } } : {}),
    ...(node.content ? { content: node.content.map(withIds) } : {}),
  };
}

export function markdownToNodes(md: string): JSONContent[] {
  return (markdown().parse(md).content ?? []).map(withIds);
}

function toNodes(content: string | JSONContent[]): JSONContent[] {
  return typeof content === "string"
    ? markdownToNodes(content)
    : content.map(withIds);
}

export function nodesToMarkdown(nodes: JSONContent[]): string {
  return markdown().serialize({ type: "doc", content: nodes });
}

function writeBlocks(fragment: Y.XmlFragment, blocks: JSONContent[]): void {
  const doc = fragment.doc;
  if (!doc) {
    throw new Error("The fragment must belong to a Y.Doc.");
  }
  const root = PmNode.fromJSON(richTextSchema(), {
    type: "doc",
    content: blocks.length > 0 ? blocks.map(withIds) : [{ type: "paragraph" }],
  });
  root.check();
  updateYFragment(doc, fragment, root, {
    mapping: new Map(),
    isOMark: new Map(),
  });
}

export function editBlocks(
  fragment: Y.XmlFragment,
  edit: (blocks: JSONContent[]) => JSONContent[]
): void {
  writeBlocks(fragment, edit(readBlocks(fragment)));
}

export type OpOptions = {
  suggest?: {
    id: string;
    actor: { id: string; name: string };
    approver?: string;
    approverId?: string;
  };
};

function mark(
  nodes: JSONContent[],
  kind: Suggestion["kind"],
  opts: OpOptions
): JSONContent[] {
  const { suggest } = opts;
  if (!suggest) {
    return nodes;
  }
  const suggestion: Suggestion = {
    id: suggest.id,
    kind,
    actorId: suggest.actor.id,
    actorName: suggest.actor.name,
    ...(suggest.approver ? { approver: suggest.approver } : {}),
    ...(suggest.approverId ? { approverId: suggest.approverId } : {}),
  };
  return nodes.map((node) => ({
    ...node,
    attrs: { ...node.attrs, suggestion },
  }));
}

export type OpResult =
  | { ok: true; blockIds: string[] }
  | { ok: false; error: string };

function spliceBlocks(
  fragment: Y.XmlFragment,
  anchorBlockId: string | null,
  splice: (blocks: JSONContent[], at: number) => JSONContent[],
  blockIds: string[]
): OpResult {
  const blocks = readBlocks(fragment);
  const at =
    anchorBlockId === null
      ? -1
      : blocks.findIndex((block) => block.attrs?.id === anchorBlockId);
  if (anchorBlockId !== null && at === -1) {
    return { ok: false, error: `No block with id ${anchorBlockId}.` };
  }
  writeBlocks(fragment, splice(blocks, at));
  return { ok: true, blockIds };
}

function idsOf(nodes: JSONContent[]): string[] {
  return nodes.map((node) => node.attrs?.id);
}

export function insertBlocks(
  fragment: Y.XmlFragment,
  afterBlockId: string | null,
  content: string | JSONContent[],
  opts: OpOptions = {}
): OpResult {
  const inserted = mark(toNodes(content), "insert", opts);
  return spliceBlocks(
    fragment,
    afterBlockId,
    (blocks, at) => [
      ...blocks.slice(0, at + 1),
      ...inserted,
      ...blocks.slice(at + 1),
    ],
    idsOf(inserted)
  );
}

export function replaceBlock(
  fragment: Y.XmlFragment,
  blockId: string,
  content: string | JSONContent[],
  opts: OpOptions = {}
): OpResult {
  const inserted = mark(toNodes(content), "insert", opts);
  return spliceBlocks(
    fragment,
    blockId,
    (blocks, at) => [
      ...blocks.slice(0, at),
      ...(opts.suggest ? mark([blocks[at]], "delete", opts) : []),
      ...inserted,
      ...blocks.slice(at + 1),
    ],
    idsOf(inserted)
  );
}

export function deleteBlock(
  fragment: Y.XmlFragment,
  blockId: string,
  opts: OpOptions = {}
): OpResult {
  return spliceBlocks(
    fragment,
    blockId,
    (blocks, at) => [
      ...blocks.slice(0, at),
      ...(opts.suggest ? mark([blocks[at]], "delete", opts) : []),
      ...blocks.slice(at + 1),
    ],
    []
  );
}

function settleSuggestion(
  fragment: Y.XmlFragment,
  id: string,
  dropKind: Suggestion["kind"]
): void {
  editBlocks(fragment, (blocks) =>
    blocks.flatMap((block) => {
      const suggestion: Suggestion | null = block.attrs?.suggestion ?? null;
      if (suggestion?.id !== id) {
        return [block];
      }
      return suggestion.kind === dropKind
        ? []
        : [{ ...block, attrs: { ...block.attrs, suggestion: null } }];
    })
  );
}

export function acceptSuggestion(fragment: Y.XmlFragment, id: string): void {
  settleSuggestion(fragment, id, "delete");
}

export function rejectSuggestion(fragment: Y.XmlFragment, id: string): void {
  settleSuggestion(fragment, id, "insert");
}

export function pendingSuggestions(fragment: Y.XmlFragment): Suggestion[] {
  const byId = new Map<string, Suggestion>();
  for (const block of readOutline(fragment)) {
    if (block.suggestion && !byId.has(block.suggestion.id)) {
      byId.set(block.suggestion.id, block.suggestion);
    }
  }
  return [...byId.values()];
}

export type SuggestionBlocks = Suggestion & {
  insertBlockIds: string[];
  deleteBlockIds: string[];
};

export function suggestionBlocks(fragment: Y.XmlFragment): SuggestionBlocks[] {
  const byId = new Map<string, SuggestionBlocks>();
  for (const block of readOutline(fragment)) {
    const { suggestion } = block;
    if (!suggestion) {
      continue;
    }
    const entry = byId.get(suggestion.id) ?? {
      ...suggestion,
      insertBlockIds: [],
      deleteBlockIds: [],
    };
    byId.set(suggestion.id, {
      ...entry,
      ...(suggestion.kind === "insert"
        ? { insertBlockIds: [...entry.insertBlockIds, block.blockId] }
        : { deleteBlockIds: [...entry.deleteBlockIds, block.blockId] }),
    });
  }
  return [...byId.values()];
}

export type BlockDiff = {
  blockId: string;
  change: "added" | "removed" | "changed" | "same";
  before: OutlineBlock | null;
  after: OutlineBlock | null;
};

// Blocks keep their ids across edits, so a diff by id is exact; removed blocks are placed after
// the block that preceded them in the earlier version.
export function diffOutlines(
  before: OutlineBlock[],
  after: OutlineBlock[]
): BlockDiff[] {
  const beforeById = new Map(before.map((block) => [block.blockId, block]));
  const afterIds = new Set(after.map((block) => block.blockId));
  const removedAfter = new Map<string | null, OutlineBlock[]>();
  let previous: string | null = null;
  for (const block of before) {
    if (!afterIds.has(block.blockId)) {
      removedAfter.set(previous, [
        ...(removedAfter.get(previous) ?? []),
        block,
      ]);
    } else {
      previous = block.blockId;
    }
  }
  const removed = (anchor: string | null): BlockDiff[] =>
    (removedAfter.get(anchor) ?? []).map((block) => ({
      blockId: block.blockId,
      change: "removed",
      before: block,
      after: null,
    }));
  return [
    ...removed(null),
    ...after.flatMap((block): BlockDiff[] => {
      const earlier = beforeById.get(block.blockId) ?? null;
      const change = !earlier
        ? "added"
        : earlier.text === block.text &&
            earlier.type === block.type &&
            earlier.suggestion?.id === block.suggestion?.id
          ? "same"
          : "changed";
      return [
        { blockId: block.blockId, change, before: earlier, after: block },
        ...removed(block.blockId),
      ];
    }),
  ];
}

export function fragmentFromState(state: Uint8Array | null): Y.XmlFragment {
  const doc = new Y.Doc();
  if (state) {
    Y.applyUpdate(doc, state);
  }
  return docFragment(doc);
}

// Restoring writes the old blocks forward as a normal edit, so it is attributed like any other
// change and blocks that did not change keep their Y items.
export function restoreBlocks(
  fragment: Y.XmlFragment,
  version: Y.XmlFragment
): void {
  writeBlocks(fragment, readBlocks(version));
}

export function exportMarkdown(fragment: Y.XmlFragment): string {
  return nodesToMarkdown(
    readBlocks(fragment).filter(
      (block) => block.attrs?.suggestion?.kind !== "insert"
    )
  );
}

function truncateText(
  node: JSONContent,
  budget: number
): { node: JSONContent | null; budget: number } {
  if (node.type === "heading") {
    return { node, budget };
  }
  if (node.type === "text") {
    const text = (node.text ?? "").slice(0, budget);
    return {
      node: text ? { ...node, text } : null,
      budget: budget - text.length,
    };
  }
  let left = budget;
  const content: JSONContent[] = [];
  for (const child of node.content ?? []) {
    const truncated = truncateText(child, left);
    left = truncated.budget;
    if (truncated.node) {
      content.push(truncated.node);
    }
  }
  return { node: node.content ? { ...node, content } : node, budget: left };
}

function streamedLength(node: JSONContent): number {
  if (node.type === "heading") {
    return 0;
  }
  return (
    (node.text?.length ?? 0) +
    (node.content ?? []).reduce((sum, child) => sum + streamedLength(child), 0)
  );
}

// ponytail: frames rewrite whole blocks by id, so a human typing inside a block while the agent
// streams it loses those keystrokes; upgrade by appending deltas to the block's Y.XmlText.
export function streamFrames(
  nodes: JSONContent[],
  { chunkChars = 24, maxFrames = 100 } = {}
): JSONContent[][] {
  const total = nodes.reduce((sum, node) => sum + streamedLength(node), 0);
  const step = Math.max(chunkChars, Math.ceil(total / maxFrames));
  const frames: JSONContent[][] = [];
  for (let shown = 0; shown < total; shown += step) {
    frames.push(
      truncateText({ type: "doc", content: nodes }, shown).node?.content ??
        nodes
    );
  }
  return [...frames, nodes];
}

export function fillBlocks(
  fragment: Y.XmlFragment,
  nodes: JSONContent[]
): void {
  const byId = new Map(nodes.map((node) => [node.attrs?.id, node]));
  editBlocks(fragment, (blocks) =>
    blocks.map((block) => {
      const filled = byId.get(block.attrs?.id);
      return filled ? { ...block, content: filled.content } : block;
    })
  );
}

function lastText(type: Y.XmlElement): Y.XmlText | null {
  for (const child of type.toArray().reverse()) {
    if (child instanceof Y.XmlText) {
      return child;
    }
    if (child instanceof Y.XmlElement) {
      const nested = lastText(child);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

export function caretAtEndOf(
  fragment: Y.XmlFragment,
  blockId: string
): { anchor: unknown; head: unknown } | null {
  const block = fragment
    .toArray()
    .find(
      (child) =>
        child instanceof Y.XmlElement && child.getAttribute("id") === blockId
    );
  if (!(block instanceof Y.XmlElement)) {
    return null;
  }
  const text = lastText(block);
  const position = Y.relativePositionToJSON(
    text
      ? Y.createRelativePositionFromTypeIndex(text, text.length)
      : Y.createRelativePositionFromTypeIndex(block, block.length)
  );
  return { anchor: position, head: position };
}

// The heading of the section a caret sits in, from a Yjs relative position (what awareness
// cursors carry). Null when the caret is before the first heading or no longer resolves.
export function sectionAtPosition(
  doc: Y.Doc,
  relativePosition: unknown
): string | null {
  let absolute: Y.AbsolutePosition | null = null;
  try {
    absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(relativePosition),
      doc
    );
  } catch {
    return null;
  }
  const fragment = docFragment(doc);
  let node: Y.AbstractType<unknown> | null = absolute?.type ?? null;
  while (node && node.parent !== fragment) {
    node = node.parent instanceof Y.AbstractType ? node.parent : null;
  }
  const blockId = node instanceof Y.XmlElement ? node.getAttribute("id") : null;
  const outline = readOutline(fragment);
  const at = outline.findIndex((block) => block.blockId === blockId);
  if (at === -1) {
    return null;
  }
  for (let i = at; i >= 0; i--) {
    if (outline[i].type.startsWith("heading")) {
      return outline[i].text;
    }
  }
  return null;
}

export type CommentActor = {
  kind: "human" | "agent";
  id: string;
  name: string;
};

export type CommentMessage = {
  id: string;
  actor: CommentActor;
  body: string;
  createdAt: number;
};

export type CommentThread = {
  id: string;
  blockId: string;
  quote: string;
  resolved: boolean;
  detached: boolean;
  createdAt: number;
  messages: CommentMessage[];
};

const commentsMapName = "comments";

export function commentsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(commentsMapName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCommentMessage(value: unknown): value is CommentMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.body === "string" &&
    typeof value.createdAt === "number" &&
    isRecord(value.actor) &&
    (value.actor.kind === "human" || value.actor.kind === "agent") &&
    typeof value.actor.id === "string" &&
    typeof value.actor.name === "string"
  );
}

function newMessage(actor: CommentActor, body: string): CommentMessage {
  return {
    id: crypto.randomUUID(),
    actor: { kind: actor.kind, id: actor.id, name: actor.name },
    body,
    createdAt: Date.now(),
  };
}

export function addThread(
  doc: Y.Doc,
  {
    blockId,
    quote = "",
    actor,
    body,
  }: { blockId: string; quote?: string; actor: CommentActor; body: string }
): string {
  const id = crypto.randomUUID();
  doc.transact(() => {
    const thread = new Y.Map<unknown>();
    const messages = new Y.Array<CommentMessage>();
    messages.push([newMessage(actor, body)]);
    thread.set("blockId", blockId);
    thread.set("quote", quote);
    thread.set("resolved", false);
    thread.set("createdAt", Date.now());
    thread.set("messages", messages);
    commentsMap(doc).set(id, thread);
  });
  return id;
}

export function replyToThread(
  doc: Y.Doc,
  threadId: string,
  { actor, body }: { actor: CommentActor; body: string }
): boolean {
  const messages = commentsMap(doc).get(threadId)?.get("messages");
  if (!(messages instanceof Y.Array)) {
    return false;
  }
  doc.transact(() => {
    messages.push([newMessage(actor, body)]);
  });
  return true;
}

export function setThreadResolved(
  doc: Y.Doc,
  threadId: string,
  resolved: boolean
): boolean {
  const thread = commentsMap(doc).get(threadId);
  if (!thread) {
    return false;
  }
  thread.set("resolved", resolved);
  return true;
}

export function readThreads(doc: Y.Doc): CommentThread[] {
  const blockIds = new Set(
    readOutline(docFragment(doc)).map((block) => block.blockId)
  );
  const threads: CommentThread[] = [];
  commentsMap(doc).forEach((thread, id) => {
    const blockId = thread.get("blockId");
    const messages = thread.get("messages");
    if (typeof blockId !== "string" || !(messages instanceof Y.Array)) {
      return;
    }
    const quote = thread.get("quote");
    const createdAt = thread.get("createdAt");
    threads.push({
      id,
      blockId,
      quote: typeof quote === "string" ? quote : "",
      resolved: thread.get("resolved") === true,
      detached: !blockIds.has(blockId),
      createdAt: typeof createdAt === "number" ? createdAt : 0,
      messages: messages.toArray().filter(isCommentMessage),
    });
  });
  return threads.sort((a, b) => a.createdAt - b.createdAt);
}
