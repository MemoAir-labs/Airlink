import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { AgentConfig } from "@memo-air/agents";
import { agentIdentity } from "@memo-air/agents";
import type { Answer, Decide, Question } from "@memo-air/decide";
import { z } from "zod";

import type { BridgeTool, Harness } from "./index.ts";

export function agentSystemPrompt(
  agent: AgentConfig,
  { memory, runner }: { memory: boolean; runner: boolean }
): string {
  return [
    agentIdentity(agent),
    "You work in a shared room with people and other agents: a chat channel plus live objects (docs, sheets, canvases, slides, a browser) that everyone watches change as you work.",
    "Do the work in the live objects through your live tools; their ids start with ldoc_ and each request lists the room's objects at the end; where a tool description says 'this conversation', it means this channel. Your final answer is posted in the channel under your name: keep it to what the person needs, and put anything longer than a few lines in a live object and say where it is.",
    "Use mode 'suggest' for binding content such as prices, dates, terms and commitments; a person accepts it.",
    runner
      ? "A dashboard, chart or report someone wants kept live is a runner, not a sheet: call run_code with a script that reads its data (the room's sheets through the room module, or the web) and writes an index.html to /out, then schedule_runner so it refreshes. Use a sheet only for a table people will edit by hand."
      : null,
    memory
      ? "You keep a memory across conversations: call recall_memory before work that may depend on what you learned earlier, and remember when you learn something lasting; the remember tool says what qualifies."
      : null,
    "Never claim a change a tool did not confirm. Never type a password, card number or one-time code nobody handed you.",
  ]
    .filter((part) => part !== null)
    .join("\n\n");
}

const toPiTool = (tool: BridgeTool): AgentTool => ({
  name: tool.name,
  label: tool.name,
  description: tool.description,
  parameters: tool.parameters,
  execute: async (_toolCallId, params) => {
    const result = await tool.run(params);
    return {
      content: [{ type: "text", text: result.text }],
      details: undefined,
      isError: !result.ok,
    };
  },
});

// Pi runs in-process, so the only thing a person needs for an agent is an LLM key. One Pi agent
// per agent and channel keeps the conversation across turns.
// A host that rebuilds harnesses when settings change passes the same `sessions` each time, so a
// model or key change keeps every conversation.
// Sessions live in memory and start over on restart or once they pass maxSessionMessages: every
// turn's prompt carries the channel's latest messages, and search_room and read_chat reach the
// rest, so a fresh session loses nothing durable and a long one never piles up stale context.
export type PiSessions = Map<string, Agent>;
const maxSessionMessages = 60;

export function piHarness({
  model,
  streamFn,
  sessions = new Map(),
}: {
  model: Model<Api>;
  streamFn: StreamFn;
  sessions?: PiSessions;
}): Harness {
  return {
    async run({ sessionKey, agent, prompt, tools }) {
      const kept = sessions.get(sessionKey);
      const session =
        kept && kept.state.messages.length <= maxSessionMessages
          ? kept
          : new Agent({
              initialState: {
                systemPrompt: agentSystemPrompt(agent, {
                  memory: tools.some((tool) => tool.name === "remember"),
                  runner: tools.some((tool) => tool.name === "run_code"),
                }),
                model,
              },
              streamFn,
            });
      sessions.set(sessionKey, session);
      session.state.model = model;
      session.streamFunction = streamFn;
      session.state.tools = tools.map(toPiTool);
      await session.prompt(prompt);
      const last = session.state.messages.at(-1);
      if (!last || last.role !== "assistant") {
        throw new Error(session.state.errorMessage ?? "no answer");
      }
      if (last.stopReason === "error" || last.stopReason === "aborted") {
        throw new Error(last.errorMessage ?? last.stopReason);
      }
      return last.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
    },
  };
}

// The LLM decision provider (spec D5): the System One questions put to a chat model as one prompt
// that must answer in JSON. A chat model reports its own confidence rather than calibrated odds,
// so the thresholds read it as a hint. It never throws, as every Decide.
export function piDecide({
  models,
  model,
}: {
  models: Pick<Models, "completeSimple">;
  model: Model<Api>;
}): Decide {
  const provider = `pi:${model.provider}/${model.id}`;
  return async ({ state, questions }) => {
    const startedAt = performance.now();
    const ms = () => Math.round(performance.now() - startedAt);
    const asked = Object.entries(questions).map(([id, question]) => {
      switch (question.type) {
        case "choice":
          return `"${id}": ${question.instructions}\nOptions:\n${Object.entries(
            question.criteria
          )
            .map(([option, meaning]) => `- ${option}: ${meaning}`)
            .join(
              "\n"
            )}\nAnswer {"choice": "<option>", "confidence": <0 to 1>}.`;
        case "noul":
          return `"${id}": ${question.instructions}\nAnswer {"probability": <0 to 1 that the answer is yes>}.`;
        case "score":
          return `"${id}": ${question.instructions}\nLevels:\n${question.levels
            .map((level, index) => `${index}: ${level}`)
            .join("\n")}\nAnswer {"score": <level number>}.`;
      }
    });
    try {
      const reply = await models.completeSimple(
        model,
        {
          systemPrompt:
            "You are a router. You answer typed questions about a block of text and reply with one JSON object only, keyed by question id, no prose and no code fence.",
          messages: [
            {
              role: "user",
              content: `Text:\n${state}\n\nQuestions:\n\n${asked.join("\n\n")}`,
              timestamp: Date.now(),
            },
          ],
        },
        { maxTokens: 300 }
      );
      if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        return {
          provider,
          ms: ms(),
          answers: null,
          error: reply.errorMessage ?? reply.stopReason,
        };
      }
      const text = reply.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      const raw: Record<string, unknown> = JSON.parse(
        text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
      );
      const answers: Record<string, Answer> = {};
      for (const [id, question] of Object.entries(questions)) {
        const answer = piAnswer(question, raw[id]);
        if (answer) {
          answers[id] = answer;
        }
      }
      return { provider, ms: ms(), answers };
    } catch (err) {
      return {
        provider,
        ms: ms(),
        answers: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

const unit = z.number().min(0).max(1);

function piAnswer(question: Question, raw: unknown): Answer | null {
  switch (question.type) {
    case "choice": {
      const parsed = z
        .object({ choice: z.string(), confidence: unit })
        .safeParse(raw);
      return parsed.success && parsed.data.choice in question.criteria
        ? { type: "choice", ...parsed.data }
        : null;
    }
    case "noul": {
      const parsed = z.object({ probability: unit }).safeParse(raw);
      return parsed.success
        ? { type: "noul", noul: parsed.data.probability }
        : null;
    }
    case "score": {
      const parsed = z.object({ score: z.number() }).safeParse(raw);
      return parsed.success
        ? { type: "score", score: parsed.data.score }
        : null;
    }
  }
}
