import { postMessage } from "@memo-air/chat";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createBriefs } from "./brief.ts";
import type { createStore } from "./store.ts";

const lin = { kind: "human" as const, id: "lin", name: "Lin" };
const channel = { id: "c1", chatDoc: "chat1" };

const fakeStore = () => {
  let kept: { summary: string; uptoMessage: string } | null = null;
  return {
    store: {
      docOf: async (docName: string) =>
        docName === channel.chatDoc ? { role: "chat", channel } : null,
      brief: async () => kept,
      saveBrief: async (_id: string, summary: string, uptoMessage: string) => {
        kept = { summary, uptoMessage };
      },
    } as unknown as ReturnType<typeof createStore>,
    kept: () => kept,
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("channel summaries", () => {
  it("folds chat into the summary once enough has piled up past it, measured as sent, and starts the next fold after it", async () => {
    const doc = new Y.Doc();
    const prompts: string[] = [];
    const { store, kept } = fakeStore();
    const briefs = createBriefs({
      store,
      complete:
        async () =>
        async ({ prompt }) => {
          prompts.push(prompt);
          return `summary ${prompts.length}`;
        },
      logger: { error: () => {} },
    });

    postMessage(doc, { id: "m1", text: "Acme wants net 45" }, lin);
    await briefs.stored("chat1", doc);
    await settle();
    expect(prompts).toEqual([]);

    for (let i = 2; i <= 7; i++) {
      postMessage(doc, { id: `m${i}`, text: "x".repeat(1_000) }, lin);
    }
    await briefs.stored("chat1", doc);
    await settle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Summary so far:\n(none yet)");
    expect(prompts[0]).toContain("[m1] Lin: Acme wants net 45");
    expect(kept()).toEqual({ summary: "summary 1", uptoMessage: "m7" });
    expect(await briefs.summaryOf("chat1")).toBe("summary 1");

    for (let i = 8; i <= 13; i++) {
      postMessage(doc, { id: `m${i}`, text: "y".repeat(1_000) }, lin);
    }
    await briefs.stored("chat1", doc);
    await settle();
    expect(prompts[1]).toContain("Summary so far:\nsummary 1");
    expect(prompts[1]).not.toContain("[m1]");
    expect(prompts[1]).toContain("[m8] Lin: yyy");
    expect(kept()?.uptoMessage).toBe("m13");
  });
});
