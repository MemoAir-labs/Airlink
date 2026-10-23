import type { Decide, DecideInput, Decision } from "@memo-air/decide";
import { z } from "zod";

// Agents are horizontal: the host says who they are (a role and tags), and the room routes work
// to them — a mention wins, then a tag, then the decision node over the roles, then the host's
// own fallback. Nothing here names a particular agent; Airlink reads a config file, Memoair its
// agent configurations, and both arrive here as the same shape.

export const agentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().default(""),
  // The agent's own system prompt: what it is for, how it works, its tone and what it must not
  // do. The role is the one line routing reads; this is what makes two agents work differently.
  instructions: z.string().default(""),
  tags: z.array(z.string()).default([]),
  access: z.enum(["write", "suggest"]).default("write"),

  // The id of a harness the host runs this agent on: "pi" in-process, or an ACP harness it found.
  harness: z.string().default("pi"),
  // "<provider>/<model id>" Pi answers on; empty means the host's default model.
  model: z.string().optional(),
  // An OKF folder; agents given the same folder share their memory, and a person's vault is one.
  memoryDir: z.string().optional(),
  // How the agent sounds in a call: a provider voice id (empty picks a distinct one) and a pace.
  voice: z
    .object({ id: z.string().optional(), speed: z.number().default(1) })
    .default({ speed: 1 }),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

// Who an agent is, the same for every harness that runs it.
export function agentIdentity(agent: AgentConfig): string {
  const instructions = agent.instructions.trim();
  return [
    `You are ${agent.name}${agent.role ? `: ${agent.role}` : ""}.`,
    instructions ? `Your instructions:\n${instructions}` : null,
  ]
    .filter((part) => part !== null)
    .join("\n\n");
}

// What routing reads; a host that only routes (Memoair) never has to say how an agent runs.
export type RoutableAgent = Pick<AgentConfig, "id" | "name" | "role" | "tags">;

export type RegistryResult =
  | { ok: true; agents: AgentConfig[] }
  | { ok: false; error: string };

export function parseAgentRegistry(json: unknown): RegistryResult {
  const parsed = z.array(agentConfigSchema).safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  const ids = new Set(parsed.data.map((agent) => agent.id));
  if (ids.size !== parsed.data.length) {
    return { ok: false, error: "agent ids must be unique" };
  }

  return { ok: true, agents: parsed.data };
}

export type RoomMessage = {
  text: string;
  mentions: string[];
  tags: string[];
};

export type Route =
  | { kind: "mentioned"; agentIds: string[] }
  | {
      kind: "routed";
      agentId: string;
      by: "tag" | "decision";
      decision: Decision | null;
    }
  | { kind: "nobody"; decision: Decision }
  | { kind: "fallback"; agentId: string | null; decision: Decision | null };

// Measured on Jev 2026-10-18 (apps/bench/src/decide.ts): roles route at 0.89–1.00; a comment asking
// for help reads 0.70 and a question typed into a heading 0.52, while routine edits and page
// changes sit at 0.17–0.22, so the turn band opens at 0.5.
export const routeThreshold = 0.6;
export const turnThreshold = 0.5;
export const rememberThreshold = 0.5;
const maxStateChars = 2000;

// In chat a person who writes without naming anyone is asking the room, so an agent answers unless
// the message is plainly for another person; a call is mostly people talking, so there anything
// that needs no agent stays with them.
const noAgentInChat =
  "The message is addressed to another person in the room by name, not to an agent.";
const noAgentInCall =
  "The message is for a person in the room, or it needs no agent: small talk, a remark, something already answered.";

export function routeQuestion(
  text: string,
  candidates: RoutableAgent[],
  none: string = noAgentInChat
): DecideInput {
  const criteria: Record<string, string> = Object.fromEntries(
    candidates.map((agent) => [
      agent.id,
      agent.role ? `${agent.name}: ${agent.role}` : agent.name,
    ])
  );
  criteria.none = none;
  return {
    point: "agent",
    state: `A person wrote in a room shared with ${candidates.length} agents, naming nobody:\n${text.slice(0, maxStateChars)}`,
    questions: {
      agent: {
        type: "choice",
        instructions:
          "Which agent should answer this message, judged from the message and each agent's role alone. Pick the agent whose role covers what the person asked, else the one whose role is closest; pick none only when the message fits none's criterion.",
        criteria,
      },
    },
  };
}

// Speech has no @-mentions: an agent in a call is addressed by saying its name.
export function agentsNamedIn<T extends { name: string }>(
  text: string,
  agents: T[]
): T[] {
  return agents.filter((agent) =>
    new RegExp(
      `\\b${agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "i"
    ).test(text)
  );
}

// Who answers a line said in a call: the agents it names, else the one the decision node is sure
// the line is for by role. Unlike chat there is no fallback, since most of a call is people
// talking to each other.
export async function routeSpoken(
  text: string,
  agents: RoutableAgent[],
  { decide, threshold = routeThreshold }: { decide: Decide; threshold?: number }
): Promise<string[]> {
  const named = agentsNamedIn(text, agents);
  if (named.length > 0 || agents.length === 0) {
    return named.map((agent) => agent.id);
  }
  const decision = await decide({
    ...routeQuestion(text, agents, noAgentInCall),
    state: `A person said this aloud in a call shared with ${agents.length} agents, naming nobody:\n${text.slice(0, maxStateChars)}`,
  });
  const answer = decision.answers?.agent;
  return answer?.type === "choice" &&
    answer.confidence >= threshold &&
    agents.some((agent) => agent.id === answer.choice)
    ? [answer.choice]
    : [];
}

export async function routeMessage(
  message: RoomMessage,
  agents: RoutableAgent[],
  {
    decide,
    fallbackAgentId,
    threshold = routeThreshold,
  }: { decide: Decide; fallbackAgentId: string | null; threshold?: number }
): Promise<Route> {
  const ids = new Set(agents.map((agent) => agent.id));
  const mentioned = [...new Set(message.mentions.filter((id) => ids.has(id)))];
  if (mentioned.length > 0) {
    return { kind: "mentioned", agentIds: mentioned };
  }
  const tags = new Set(message.tags);
  const tagged = agents.filter((agent) =>
    agent.tags.some((tag) => tags.has(tag))
  );
  if (tagged.length === 1) {
    return { kind: "routed", agentId: tagged[0].id, by: "tag", decision: null };
  }
  const candidates = tagged.length > 1 ? tagged : agents;
  if (candidates.length < 2) {
    return { kind: "fallback", agentId: fallbackAgentId, decision: null };
  }
  const decision = await decide(routeQuestion(message.text, candidates));
  const answer = decision.answers?.agent;
  const confident = answer?.type === "choice" && answer.confidence >= threshold;
  if (answer?.type === "choice" && answer.choice === "none" && confident) {
    return { kind: "nobody", decision };
  }
  // Agents are flat: the decision node's pick answers even when unsure, and is told so.
  if (answer?.type === "choice" && ids.has(answer.choice)) {
    return confident
      ? { kind: "routed", agentId: answer.choice, by: "decision", decision }
      : { kind: "fallback", agentId: answer.choice, decision };
  }
  return { kind: "fallback", agentId: fallbackAgentId, decision };
}

export type RoomEvent = {
  type: string;
  actor: { kind: "human" | "agent"; id: string; name: string };
  summary: string;
};

// Presence and motion never earn a turn; the server also keeps cursors and typing off this path.
const neverATurn = new Set(["join", "leave", "cursor", "typing"]);

export function turnQuestion(event: RoomEvent): DecideInput {
  return {
    point: "turn",
    state: `In a shared room, ${event.actor.name} (a person) caused the event "${event.type}".\n${event.summary.slice(0, maxStateChars)}`,
    questions: {
      turn: {
        type: "noul",
        instructions:
          "Should an agent in this room act on this now, without being asked?",
        criteria: {
          true: "The event leaves work an agent can take up right away: a question or request in a comment, a section, column or list the person finished that an agent can continue or check, a page that holds what the room was looking for.",
          false:
            "The person is still working, the event is routine (opening, scrolling, a small edit, a settled suggestion with nothing left to do), or acting now would interrupt them.",
        },
      },
    },
  };
}

export async function deservesTurn(
  event: RoomEvent,
  { decide, threshold = turnThreshold }: { decide: Decide; threshold?: number }
): Promise<{ turn: boolean; decision: Decision | null }> {
  if (event.actor.kind === "agent" || neverATurn.has(event.type)) {
    return { turn: false, decision: null };
  }
  const decision = await decide(turnQuestion(event));
  const answer = decision.answers?.turn;
  return {
    turn: answer?.type === "noul" && answer.noul >= threshold,
    decision,
  };
}

const turnVerbs: Record<string, string> = {
  edit_settled: "stopped editing",
  comment: "commented in",
  browser_navigate: "opened a page in",
  suggestion_accepted: "accepted a suggestion in",
  suggestion_rejected: "rejected a suggestion in",
};

export type TurnPromptInput = {
  event: { type: string; actor: { name: string }; summary: string };
  // The live object the event happened in; absent for a chat message, which is its own object.
  object?: { id: string; title: string; kind: string };
  // The decision node picked this agent below its band, or had no pick at all.
  unsure: boolean;
};

// The note that starts an agent's turn when the room, not a person, chose it. Both hosts send it
// as a message the person never sees, so it says so and forbids pretending to have been asked.
export function turnPrompt({ event, object, unsure }: TurnPromptInput): string {
  const name = event.actor.name;
  const unsureLine = unsure
    ? "The room was not sure this was meant for you. If it is not, say so in one short line and leave it."
    : null;
  if (event.type === "spoken") {
    return [
      `${name} said to you in the channel's call${object ? ` (live room ${object.id})` : ""}:`,
      `> ${event.summary}`,
      "Your reply is spoken aloud to everyone in the call: answer in one to three short sentences of plain speech, with no markdown, lists or links. When the answer belongs in a doc, sheet or other live object, put it there with your live tools and say so in one sentence.",
    ].join("\n\n");
  }
  if (!object) {
    return [
      `${name} wrote in the channel:`,
      event.summary
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
      "Answer them here, directly. When the answer belongs in a doc, sheet or other live object in the room, put it there with your live tools and say in one line where it is.",
      unsureLine,
    ]
      .filter((part) => part !== null)
      .join("\n\n");
  }
  const verb = turnVerbs[event.type] ?? `caused "${event.type}" in`;
  return [
    `${name} ${verb} the live ${object.kind} "${object.title}" (live doc ${object.id}). Nobody asked you; the room judged this worth a look, and ${name} does not see this note.`,
    "Read it, and act there through your live tools only if there is work to take up: a question or request in a comment, a part they finished that you can continue or check. Do not rewrite what they are still writing, and do not say that someone asked you.",
    "Reply here in one short line on what you did, or say plainly that there was nothing to do.",
    unsureLine,
    "What the room saw:",
    event.summary,
  ]
    .filter((part) => part !== null)
    .join("\n\n");
}

export type RememberEntry = { type: string; title: string; body: string };

// Asked before an agent's memory write: the agent chose to remember, the room checks that the
// entry outlives the conversation, so a folder a person reads does not fill with task chatter.
export function rememberQuestion(
  entry: RememberEntry,
  agentName: string
): DecideInput {
  return {
    point: "remember",
    state:
      `${agentName} wants to remember this (${entry.type}):\n${entry.title}\n${entry.body}`.slice(
        0,
        maxStateChars
      ),
    questions: {
      remember: {
        type: "noul",
        instructions:
          "Will this entry help the agent in a later conversation, not only in this one?",
        criteria: {
          true: "A lasting fact about a person, team, project or customer; a stated preference or standing instruction; a decision and its reason; a procedure that worked. Something the agent would otherwise have to ask again.",
          false:
            "It only matters now: progress on the current task, a one-off number, small talk, a guess. Also false for any password, card number or one-time code.",
        },
      },
    },
  };
}
