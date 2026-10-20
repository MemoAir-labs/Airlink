import { parseArgs } from "node:util";
import {
  routeQuestion,
  turnQuestion,
} from "../../../packages/agents/src/index.ts";
import { systemOneProvider } from "../../../packages/decide/src/index.ts";
import { percentiles } from "./stats.ts";

// The decision path's budget (spec, "Where the time goes"): decide() ≤ 120 ms on CPU, so a
// routing decision never dominates a turn. Sends the two Phase F questions to a System One server
// (Laya or Jev) and prints the round trip and what it decided.
const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8000/v1/systemone" },
    key: { type: "string" },
    model: { type: "string" },
    samples: { type: "string", default: "10" },
  },
});

const decide = systemOneProvider({
  name: new URL(args.url).hostname,
  url: args.url,
  apiKey: args.key,
  model: args.model,
  timeoutMs: 10_000,
});

const agents = [
  {
    id: "juno",
    name: "Juno",
    role: "Chief of staff: the person's day, priorities, inbox, meetings, follow-ups. Tools: gmail, google_calendar.",
    tags: [],
    access: "write" as const,
  },
  {
    id: "am",
    name: "Account Manager",
    role: "Keeps every customer account healthy from signed to renewed: quiet accounts, renewals, contract dates. Tools: hubspot.",
    tags: [],
    access: "write" as const,
  },
];

const messages = [
  "Which of my accounts renew next month? One line each.",
  "What should I focus on today, in three bullets?",
  "thanks all!",
  "Can someone pull the Q3 numbers into the sheet?",
];

const events = [
  {
    type: "edit_settled",
    summary: "Q3 plan\n\nRevenue: 12, 14, 19\nCosts: 8, 9, 11\nNet: ",
  },
  {
    type: "edit_settled",
    summary:
      'Open comment on "Net:":\nHana: can someone fill in the net row and check Q2?\n\nQ3 plan',
  },
  {
    type: "browser_navigate",
    summary: "Pricing - Acme\nhttps://acme.example/pricing",
  },
  { type: "edit_settled", summary: "Meeting notes\n\n- intro\n- agenda" },
];

const hana = { kind: "human" as const, id: "u1", name: "Hana" };
const samples = Number(args.samples);
const timings: number[] = [];

for (const text of messages) {
  const decision = await decide(routeQuestion(text, agents));
  const answer = decision.answers?.agent;
  console.log(
    `agent | ${decision.ms} ms | ${text} → ${answer?.type === "choice" ? `${answer.choice} @ ${answer.confidence.toFixed(2)}` : decision.error}`
  );
}
for (const event of events) {
  const decision = await decide(turnQuestion({ ...event, actor: hana }));
  const answer = decision.answers?.turn;
  console.log(
    `turn  | ${decision.ms} ms | ${event.type}: ${event.summary.split("\n")[0]} → ${answer?.type === "noul" ? answer.noul.toFixed(2) : decision.error}`
  );
}
for (let i = 0; i < samples; i++) {
  const decision = await decide(
    routeQuestion(messages[i % messages.length], agents)
  );
  if (decision.answers) {
    timings.push(decision.ms);
  }
}
const stats = percentiles(timings);
console.log(
  `\n${args.url}: one choice over ${agents.length + 1} options, ${stats.n} samples — p50 ${stats.p50} / p95 ${stats.p95} / p99 ${stats.p99} ms`
);
