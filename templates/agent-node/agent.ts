// An agent in one file: it joins the room's chat as a peer, answers when mentioned with one model
// call, and keeps a running summary doc through live-server's ops route.

import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createLiveAgentClient } from "@memo-air/agent";
import type { ChatMessage } from "@memo-air/chat";
import { observeNewMessages, postMessage } from "@memo-air/chat";
import { joinRoom } from "@memo-air/client";
import { signLiveToken } from "@memo-air/protocol/tokens";

const liveUrl = process.env.LIVE_URL ?? "ws://localhost:3020";
const secret = process.env.LIVE_JWT_SECRET;
const chatDoc = process.env.CHAT_DOC ?? "room-chat";
const summaryDoc = process.env.SUMMARY_DOC ?? "room-summary";
const agent = {
  kind: "agent" as const,
  id: "scout",
  name: process.env.AGENT_NAME ?? "Scout",
};
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

if (!secret) {
  throw new Error(
    "Set LIVE_JWT_SECRET in .env: the value docker compose gives live-server."
  );
}
const choice = anthropicKey
  ? {
      provider: anthropicProvider(),
      id: "anthropic",
      key: anthropicKey,
      model: "claude-haiku-5-5",
    }
  : openaiKey
    ? {
        provider: openaiProvider(),
        id: "openai",
        key: openaiKey,
        model: "gpt-6-luna",
      }
    : null;
if (!choice) {
  throw new Error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.");
}
const credentials = new InMemoryCredentialStore();
const models = createModels({ credentials });
models.setProvider(choice.provider);
await credentials.modify(choice.id, async () => ({
  type: "api_key",
  key: choice.key,
}));
const model = models.getModel(choice.id, choice.model);
if (!model) {
  throw new Error(
    `${choice.id} has no model "${choice.model}"; pick another in agent.ts.`
  );
}

const tokenFor = (docName: string) =>
  signLiveToken(
    { actor: agent, workspaceId: "airlink-room", docName, access: "write" },
    secret,
    300
  );

const mentionsMe = (message: ChatMessage) =>
  message.actor.id !== agent.id &&
  (message.mentions.some((mention) => mention.id === agent.id) ||
    message.text.toLowerCase().includes(`@${agent.name.toLowerCase()}`));

const answer = async (message: ChatMessage): Promise<string> => {
  const result = await models.completeSimple(
    model,
    {
      systemPrompt: `You are ${agent.name}, an agent in a shared room. Answer in two or three sentences.`,
      messages: [
        { role: "user", content: message.text, timestamp: Date.now() },
      ],
    },
    { maxTokens: 400 }
  );
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    return `I could not answer: ${result.errorMessage ?? result.stopReason}.`;
  }
  return result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
};

const room = joinRoom({
  url: liveUrl,
  token: async () => tokenFor(chatDoc),
  docName: chatDoc,
  presence: { name: agent.name, kind: "agent" },
});

const reply = async (message: ChatMessage) => {
  const text = await answer(message);
  postMessage(
    room.doc,
    {
      text,
      mentions: [
        {
          kind: message.actor.kind,
          id: message.actor.id,
          name: message.actor.name,
        },
      ],
    },
    agent
  );
  await createLiveAgentClient({
    baseUrl: liveUrl.replace(/^ws/, "http"),
    docName: summaryDoc,
    token: tokenFor(summaryDoc),
  }).ops({
    ops: [
      {
        type: "insert",
        afterBlockId: null,
        markdown: `**${message.actor.name}:** ${message.text}\n\n**${agent.name}:** ${text}`,
      },
    ],
  });
};

// Listen only after the first sync, so messages already in the chat are not answered again.
let listening = false;
room.events.subscribe((event) => {
  if (event.type !== "synced" || listening) {
    return;
  }
  listening = true;
  observeNewMessages(room.doc, (message) => {
    if (mentionsMe(message)) {
      reply(message).catch((error) =>
        process.stderr.write(`${agent.name}: ${error}\n`)
      );
    }
  });
  process.stdout.write(
    `${agent.name} is in ${chatDoc}. Mention @${agent.name} to ask something.\n`
  );
});

process.on("SIGINT", () => {
  room.leave();
  process.exit(0);
});
