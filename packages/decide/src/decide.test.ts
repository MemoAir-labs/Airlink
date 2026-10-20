import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type DecisionRecord,
  loggedDecide,
  noOpinion,
  systemOneProvider,
  withFallback,
} from "./index.ts";

type Handler = (body: unknown) => { status: number; body?: unknown } | "hang";

let server: Server;
let baseUrl: string;
let handler: Handler = () => ({ status: 500 });
const received: unknown[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
      received.push({ body, authorization: request.headers.authorization });
      const result = handler(body);
      if (result === "hang") {
        return;
      }
      response.writeHead(result.status, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(result.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no port");
  }
  baseUrl = `http://127.0.0.1:${address.port}/v1/systemone`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const input = {
  point: "agent",
  state: "Hana wrote: can someone pull the Q3 numbers?",
  questions: {
    agent: {
      type: "choice" as const,
      instructions: "Which agent answers?",
      criteria: { juno: "Juno: analyst", mira: "Mira: writer", none: "nobody" },
    },
    turn: {
      type: "noul" as const,
      instructions: "Does this deserve a turn?",
    },
  },
};

describe("systemOneProvider", () => {
  it("parses choice probabilities and noul from the wire, by question type", async () => {
    handler = () => ({
      status: 200,
      body: {
        answers: {
          agent: {
            choice: "juno",
            confidence: 0.91,
            probabilities: { juno: 0.91, mira: 0.07, none: 0.02 },
          },
          turn: { noul: 0.83 },
        },
      },
    });
    const decide = systemOneProvider({
      name: "fake",
      url: baseUrl,
      apiKey: "k",
      model: "m",
      timeoutMs: 1000,
    });
    const decision = await decide(input);
    expect(decision).toMatchObject({
      provider: "fake",
      answers: {
        agent: {
          type: "choice",
          choice: "juno",
          confidence: 0.91,
          probabilities: { juno: 0.91, mira: 0.07, none: 0.02 },
        },
        turn: { type: "noul", noul: 0.83 },
      },
    });
    expect(decision.ms).toBeGreaterThanOrEqual(0);
    expect(received.at(-1)).toMatchObject({
      authorization: "Bearer k",
      body: { model: "m", state: input.state, questions: input.questions },
    });
  });

  it("has no opinion within the timeout when the server never answers", async () => {
    handler = () => "hang";
    const decide = systemOneProvider({
      name: "slow",
      url: baseUrl,
      timeoutMs: 50,
    });
    const startedAt = performance.now();
    const decision = await decide(input);
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(decision.answers).toBeNull();
    expect(decision.error).toMatch(/abort|timeout/i);
    server.closeAllConnections();
  });

  it("has no opinion on a server error or a malformed answer", async () => {
    handler = () => ({ status: 500 });
    const decide = systemOneProvider({ name: "down", url: baseUrl });
    expect((await decide(input)).answers).toBeNull();
    handler = () => ({
      status: 200,
      body: { answers: { agent: { choice: "juno", confidence: 0.9 } } },
    });
    const partial = await decide(input);
    expect(partial.answers).toBeNull();
    expect(partial.error).toMatch(/turn/);
  });
});

describe("withFallback", () => {
  const sure = async () => ({
    provider: "sure",
    ms: 1,
    answers: {
      agent: { type: "choice" as const, choice: "juno", confidence: 0.9 },
    },
  });
  const unsure = async () => ({
    provider: "unsure",
    ms: 1,
    answers: {
      agent: { type: "choice" as const, choice: "mira", confidence: 0.4 },
    },
  });

  it("asks the fallback only on no opinion or under the confidence band", async () => {
    const simple = { point: "p", state: "s", questions: {} };
    expect((await withFallback(sure, unsure)(simple)).provider).toBe("sure");
    expect((await withFallback(noOpinion, sure)(simple)).provider).toBe("sure");
    expect(
      (await withFallback(unsure, sure, { belowConfidence: 0.6 })(simple))
        .provider
    ).toBe("sure");
    expect((await withFallback(unsure, sure)(simple)).provider).toBe("unsure");
    expect(
      (await withFallback(unsure, noOpinion, { belowConfidence: 0.6 })(simple))
        .provider
    ).toBe("unsure");
    const nothing = await withFallback(noOpinion, noOpinion)(simple);
    expect(nothing.answers).toBeNull();
  });
});

describe("loggedDecide", () => {
  it("hands the sink a record with a stable state hash and no state text", async () => {
    const records: DecisionRecord[] = [];
    const decide = loggedDecide(noOpinion, (record) => records.push(record));
    await decide(input);
    await decide(input);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      point: "agent",
      provider: "none",
      answers: null,
      questions: input.questions,
    });
    expect(records[0].stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(records[0].stateHash).toBe(records[1].stateHash);
    expect(JSON.stringify(records[0])).not.toContain("Q3 numbers");
  });
});
