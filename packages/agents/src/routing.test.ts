import type { Decide, DecideInput } from "@memo-air/decide";
import { noOpinion } from "@memo-air/decide";
import { describe, expect, it } from "vitest";

import {
  agentsNamedIn,
  deservesTurn,
  parseAgentRegistry,
  rememberQuestion,
  routeMessage,
  routeSpoken,
  turnPrompt,
} from "./index.ts";

const agents = [
  {
    id: "juno",
    name: "Juno",
    role: "Analyst: numbers, sheets",
    tags: ["data"],
    access: "write" as const,
  },
  {
    id: "mira",
    name: "Mira",
    role: "Writer: drafts, docs",
    tags: ["writing"],
    access: "write" as const,
  },
];

function choosing(
  choice: string,
  confidence: number,
  calls: DecideInput[] = []
): Decide {
  return async (input) => {
    calls.push(input);
    return {
      provider: "fake",
      ms: 1,
      answers: {
        agent: {
          type: "choice",
          choice,
          confidence,
          probabilities: { juno: 1 - confidence, mira: confidence, none: 0 },
        },
      },
    };
  };
}

describe("routeMessage", () => {
  it("lets a mention beat everything and never asks", async () => {
    const calls: DecideInput[] = [];
    const route = await routeMessage(
      { text: "hi", mentions: ["mira", "nobody-here", "mira"], tags: ["data"] },
      agents,
      { decide: choosing("juno", 1, calls), fallbackAgentId: "juno" }
    );
    expect(route).toEqual({ kind: "mentioned", agentIds: ["mira"] });
    expect(calls).toEqual([]);
  });

  it("routes a unique tag match without a decision", async () => {
    const calls: DecideInput[] = [];
    const route = await routeMessage(
      { text: "draft the intro", mentions: [], tags: ["writing"] },
      agents,
      { decide: choosing("juno", 1, calls), fallbackAgentId: "juno" }
    );
    expect(route).toMatchObject({ kind: "routed", agentId: "mira", by: "tag" });
    expect(calls).toEqual([]);
  });

  it("picks exactly one speaker for two agents and keeps both agents' odds", async () => {
    const calls: DecideInput[] = [];
    const route = await routeMessage(
      { text: "can someone draft the summary?", mentions: [], tags: [] },
      agents,
      { decide: choosing("mira", 0.88, calls), fallbackAgentId: "juno" }
    );
    expect(route).toMatchObject({
      kind: "routed",
      agentId: "mira",
      by: "decision",
      decision: {
        answers: {
          agent: { probabilities: { juno: expect.any(Number), mira: 0.88 } },
        },
      },
    });
    expect(calls[0].questions.agent).toMatchObject({
      type: "choice",
      criteria: {
        juno: "Juno: Analyst: numbers, sheets",
        mira: "Mira: Writer: drafts, docs",
        none: expect.any(String),
      },
    });
    expect(calls[0].state).toContain("can someone draft the summary?");
  });

  it("sends an unsure pick to that agent, and falls back on no opinion and with one candidate", async () => {
    const message = { text: "hmm", mentions: [], tags: [] };
    expect(
      await routeMessage(message, agents, {
        decide: choosing("mira", 0.4),
        fallbackAgentId: "juno",
      })
    ).toMatchObject({ kind: "fallback", agentId: "mira" });
    const startedAt = performance.now();
    expect(
      await routeMessage(message, agents, {
        decide: noOpinion,
        fallbackAgentId: null,
      })
    ).toMatchObject({
      kind: "fallback",
      agentId: null,
      decision: { answers: null },
    });
    expect(performance.now() - startedAt).toBeLessThan(10);
    expect(
      await routeMessage(message, [agents[0]], {
        decide: choosing("juno", 1),
        fallbackAgentId: "juno",
      })
    ).toEqual({ kind: "fallback", agentId: "juno", decision: null });
  });

  it("routes to nobody when none is the confident choice", async () => {
    const route = await routeMessage(
      { text: "thanks all!", mentions: [], tags: [] },
      agents,
      { decide: choosing("none", 0.93), fallbackAgentId: "juno" }
    );
    expect(route.kind).toBe("nobody");
  });
});

describe("deservesTurn", () => {
  const yes: Decide = async () => ({
    provider: "fake",
    ms: 1,
    answers: { turn: { type: "noul", noul: 0.9 } },
  });

  it("never asks about an agent's own event or about presence", async () => {
    let asked = 0;
    const counting: Decide = async (input) => {
      asked += 1;
      return yes(input);
    };
    const juno = { kind: "agent" as const, id: "juno", name: "Juno" };
    const hana = { kind: "human" as const, id: "u1", name: "Hana" };
    expect(
      await deservesTurn(
        { type: "edit_settled", actor: juno, summary: "..." },
        { decide: counting }
      )
    ).toEqual({ turn: false, decision: null });
    expect(
      await deservesTurn(
        { type: "join", actor: hana, summary: "" },
        { decide: counting }
      )
    ).toEqual({ turn: false, decision: null });
    expect(asked).toBe(0);
    const turn = await deservesTurn(
      { type: "comment", actor: hana, summary: "Could you check B12?" },
      { decide: counting }
    );
    expect(turn.turn).toBe(true);
    expect(asked).toBe(1);
  });

  it("is no turn under the threshold or with no opinion", async () => {
    const hana = { kind: "human" as const, id: "u1", name: "Hana" };
    const low: Decide = async () => ({
      provider: "fake",
      ms: 1,
      answers: { turn: { type: "noul", noul: 0.4 } },
    });
    const event = { type: "browser_navigate", actor: hana, summary: "url" };
    expect((await deservesTurn(event, { decide: low })).turn).toBe(false);
    expect((await deservesTurn(event, { decide: noOpinion })).turn).toBe(false);
  });
});

describe("parseAgentRegistry", () => {
  it("fills defaults and refuses duplicate ids", () => {
    expect(parseAgentRegistry([{ id: "a", name: "A" }])).toEqual({
      ok: true,
      agents: [
        {
          id: "a",
          name: "A",
          role: "",
          instructions: "",
          tags: [],
          access: "write",
          harness: "pi",
          voice: { speed: 1 },
        },
      ],
    });
    expect(
      parseAgentRegistry([
        { id: "a", name: "A" },
        { id: "a", name: "B" },
      ])
    ).toMatchObject({ ok: false });

    expect(parseAgentRegistry("nope")).toMatchObject({ ok: false });
  });
});

describe("turnPrompt", () => {
  it("quotes a chat message verbatim and adds the unsure line only when asked", () => {
    const message = {
      event: {
        type: "message",
        actor: { name: "Hana" },
        summary: "Can someone total column B?\nThe Q3 sheet",
      },
    };
    expect(turnPrompt({ ...message, unsure: false })).toBe(
      "Hana wrote in the channel:\n\n> Can someone total column B?\n> The Q3 sheet\n\nAnswer them here, directly. When the answer belongs in a doc, sheet or other live object in the room, put it there with your live tools and say in one line where it is."
    );
    expect(turnPrompt({ ...message, unsure: true })).toContain(
      "The room was not sure this was meant for you."
    );
  });

  it("names the object and the event, and keeps the summary last", () => {
    const text = turnPrompt({
      event: {
        type: "edit_settled",
        actor: { name: "Hana" },
        summary: "Q3: 12, 14, 19",
      },
      object: { id: "ldoc_1", title: "Q3 plan", kind: "sheet" },
      unsure: false,
    });
    expect(
      text.startsWith(
        'Hana stopped editing the live sheet "Q3 plan" (live doc ldoc_1).'
      )
    ).toBe(true);
    expect(text).toContain("do not say that someone asked you");
    expect(text.endsWith("What the room saw:\n\nQ3: 12, 14, 19")).toBe(true);
  });
});

describe("rememberQuestion", () => {
  it("asks one yes/no over the entry, bounded, and the registry takes a memory folder", () => {
    const question = rememberQuestion(
      { type: "preference", title: "Short answers", body: "x".repeat(5000) },
      "Juno"
    );
    expect(question.point).toBe("remember");
    expect(
      question.state.startsWith(
        "Juno wants to remember this (preference):\nShort answers\nxxx"
      )
    ).toBe(true);
    expect(question.state.length).toBe(2000);
    expect(Object.values(question.questions).map((q) => q.type)).toEqual([
      "noul",
    ]);
    const parsed = parseAgentRegistry([
      { id: "juno", name: "Juno", memoryDir: "/vault" },
    ]);
    expect(parsed.ok && parsed.agents[0].memoryDir).toBe("/vault");
  });
});

describe("agentsNamedIn", () => {
  it("finds an agent addressed by name in speech, whole words only", () => {
    const named = [
      { name: "Juno" },
      { name: "Market researcher" },
      { name: "C++ helper" },
    ];
    expect(agentsNamedIn("juno, what did we decide?", named)).toEqual([
      { name: "Juno" },
    ]);
    expect(agentsNamedIn("Ask the market researcher.", named)).toEqual([
      { name: "Market researcher" },
    ]);
    expect(agentsNamedIn("Junot said nothing", named)).toEqual([]);
  });
});

describe("routeSpoken", () => {
  it("answers by name without asking, else by a confident role match, else nobody", async () => {
    const calls: DecideInput[] = [];
    expect(
      await routeSpoken("Mira, draft that up", agents, {
        decide: choosing("juno", 1, calls),
      })
    ).toEqual(["mira"]);
    expect(calls).toEqual([]);
    expect(
      await routeSpoken("what were Q3 sales?", agents, {
        decide: choosing("juno", 0.9),
      })
    ).toEqual(["juno"]);
    expect(
      await routeSpoken("yeah that works for me", [agents[0]], {
        decide: choosing("juno", 0.3),
      })
    ).toEqual([]);
    expect(
      await routeSpoken("sounds good", agents, {
        decide: choosing("none", 0.95),
      })
    ).toEqual([]);
  });
});
