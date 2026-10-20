import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  acceptSuggestion,
  caretAtEndOf,
  deleteBlock,
  diffOutlines,
  docFragment,
  exportMarkdown,
  fillBlocks,
  insertBlocks,
  markdownToNodes,
  pendingSuggestions,
  readOutline,
  rejectSuggestion,
  replaceBlock,
  streamFrames,
  suggestionBlocks,
} from "./index.ts";

const agent = { id: "agent-1", name: "Analyst" };

function newDoc(md: string) {
  const fragment = docFragment(new Y.Doc());
  insertBlocks(fragment, null, md);
  return fragment;
}

function texts(fragment: Y.XmlFragment) {
  return readOutline(fragment).map((block) => `${block.type}:${block.text}`);
}

function blockIds(fragment: Y.XmlFragment) {
  return readOutline(fragment).map((block) => block.blockId);
}

describe("richtext ops", () => {
  it("inserts markdown as blocks with ids, after a given block", () => {
    const fragment = newDoc("# Plan\n\nIntro **bold**.\n\n- one\n- two");
    expect(texts(fragment)).toEqual([
      "heading1:Plan",
      "paragraph:Intro bold.",
      "bulletList:one\ntwo",
    ]);
    expect(blockIds(fragment).every((id) => typeof id === "string")).toBe(true);

    const [heading] = blockIds(fragment);
    insertBlocks(fragment, heading, "Inserted.");
    expect(texts(fragment)[1]).toBe("paragraph:Inserted.");
  });

  it("replaces and deletes blocks in edit mode", () => {
    const fragment = newDoc("A\n\nB\n\nC");
    const [a, b] = blockIds(fragment);
    replaceBlock(fragment, b, "## New B");
    deleteBlock(fragment, a);
    expect(texts(fragment)).toEqual(["heading2:New B", "paragraph:C"]);
  });

  it("reports a missing block without touching the doc", () => {
    const fragment = newDoc("A");
    const before = fragment.toJSON();
    expect(deleteBlock(fragment, "missing")).toEqual({
      ok: false,
      error: "No block with id missing.",
    });
    expect(fragment.toJSON()).toBe(before);
  });

  it("suggest + accept applies the change and clears the suggestion", () => {
    const fragment = newDoc("A\n\nB");
    const [, b] = blockIds(fragment);
    const suggest = { id: "s1", actor: agent, approver: "user-9" };
    replaceBlock(fragment, b, "B2", { suggest });
    insertBlocks(fragment, null, "Top", { suggest });

    expect(texts(fragment)).toEqual([
      "paragraph:Top",
      "paragraph:A",
      "paragraph:B",
      "paragraph:B2",
    ]);
    expect(pendingSuggestions(fragment)).toEqual([
      {
        id: "s1",
        kind: "insert",
        actorId: "agent-1",
        actorName: "Analyst",
        approver: "user-9",
      },
    ]);

    acceptSuggestion(fragment, "s1");
    expect(texts(fragment)).toEqual([
      "paragraph:Top",
      "paragraph:A",
      "paragraph:B2",
    ]);
    expect(pendingSuggestions(fragment)).toEqual([]);
  });

  it("suggest + reject restores the original exactly", () => {
    const fragment = newDoc("# Title\n\nA\n\nB");
    const original = fragment.toJSON();
    const [, a, b] = blockIds(fragment);
    const suggest = { id: "s2", actor: agent };
    replaceBlock(fragment, a, "A2\n\nA3", { suggest });
    deleteBlock(fragment, b, { suggest });
    insertBlocks(fragment, b, "Tail", { suggest });

    rejectSuggestion(fragment, "s2");
    expect(fragment.toJSON()).toBe(original);
  });

  it("only settles the named suggestion", () => {
    const fragment = newDoc("A");
    const [a] = blockIds(fragment);
    insertBlocks(fragment, a, "X", { suggest: { id: "x", actor: agent } });
    insertBlocks(fragment, a, "Y", { suggest: { id: "y", actor: agent } });
    rejectSuggestion(fragment, "x");
    expect(texts(fragment)).toEqual(["paragraph:A", "paragraph:Y"]);
    expect(pendingSuggestions(fragment).map((s) => s.id)).toEqual(["y"]);
  });

  it("merges an agent op with a concurrent edit to another block", () => {
    const agentDoc = new Y.Doc();
    const humanDoc = new Y.Doc();
    insertBlocks(docFragment(agentDoc), null, "Human here\n\nOther");
    Y.applyUpdate(humanDoc, Y.encodeStateAsUpdate(agentDoc));

    const [first, second] = blockIds(docFragment(agentDoc));
    insertBlocks(docFragment(agentDoc), second, "Agent block");

    const paragraph = docFragment(humanDoc).get(0);
    const text = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
    if (!(text instanceof Y.XmlText)) {
      throw new Error("expected a text node");
    }
    text.insert(10, " typing");

    Y.applyUpdate(humanDoc, Y.encodeStateAsUpdate(agentDoc));
    Y.applyUpdate(agentDoc, Y.encodeStateAsUpdate(humanDoc));
    for (const doc of [agentDoc, humanDoc]) {
      expect(texts(docFragment(doc))).toEqual([
        "paragraph:Human here typing",
        "paragraph:Other",
        "paragraph:Agent block",
      ]);
    }
    expect(blockIds(docFragment(humanDoc)).slice(0, 2)).toEqual([
      first,
      second,
    ]);
  });

  it("streams a skeleton with headings first, then fills text to the final state", () => {
    const fragment = newDoc("Keep");
    const [keep] = blockIds(fragment);
    const nodes = markdownToNodes(
      `# Heading\n\n${"x".repeat(60)}\n\n- ${"y".repeat(10)}`
    );
    const frames = streamFrames(nodes);

    insertBlocks(fragment, keep, frames[0], {
      suggest: { id: "s", actor: agent },
    });
    expect(texts(fragment)).toEqual([
      "paragraph:Keep",
      "heading1:Heading",
      "paragraph:",
      "bulletList:",
    ]);

    fillBlocks(fragment, frames[1]);
    expect(texts(fragment)[2]).toBe(`paragraph:${"x".repeat(24)}`);

    for (const frame of frames.slice(2)) {
      fillBlocks(fragment, frame);
    }
    expect(texts(fragment).slice(1)).toEqual([
      "heading1:Heading",
      `paragraph:${"x".repeat(60)}`,
      `bulletList:${"y".repeat(10)}`,
    ]);
    expect(pendingSuggestions(fragment).map((s) => s.id)).toEqual(["s"]);

    const caret = caretAtEndOf(fragment, nodes[1].attrs?.id);
    const position = Y.createRelativePositionFromJSON(caret?.anchor);
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      position,
      fragment.doc ?? new Y.Doc()
    );
    expect(absolute?.index).toBe(60);
  });

  it("exports the accepted view as markdown", () => {
    const fragment = newDoc("# Title\n\nBody");
    const [, body] = blockIds(fragment);
    replaceBlock(fragment, body, "New body", {
      suggest: { id: "s", actor: agent },
    });
    expect(exportMarkdown(fragment)).toBe("# Title\n\nBody");
  });

  it("diffs two versions by block id, keeping removed blocks in place", () => {
    const fragment = newDoc("# Plan\n\nKeep.\n\nDrop.\n\nEdit me.");
    const before = readOutline(fragment);
    const [, keep, drop, edit] = blockIds(fragment);
    deleteBlock(fragment, drop);
    replaceBlock(fragment, edit, "Edited.");
    insertBlocks(fragment, keep, "New.");
    expect(
      diffOutlines(before, readOutline(fragment)).map(
        (entry) => `${entry.change}:${(entry.after ?? entry.before)?.text}`
      )
    ).toEqual([
      "same:Plan",
      "same:Keep.",
      "removed:Drop.",
      "removed:Edit me.",
      "added:New.",
      "added:Edited.",
    ]);
  });

  it("lists each suggestion's insert and delete blocks", () => {
    const fragment = newDoc("Price: $10.");
    const [price] = blockIds(fragment);
    replaceBlock(fragment, price, "Price: $12.", {
      suggest: { id: "s1", actor: agent, approver: "Ada", approverId: "u1" },
    });
    const [entry] = suggestionBlocks(fragment);
    expect(entry).toMatchObject({
      id: "s1",
      approverId: "u1",
      deleteBlockIds: [price],
    });
    expect(entry.insertBlockIds).toHaveLength(1);
  });
});

describe("an empty doc", () => {
  it("reads as no blocks", () => {
    const fragment = new Y.Doc().getXmlFragment("default");
    expect(readOutline(fragment)).toEqual([]);
  });
});
