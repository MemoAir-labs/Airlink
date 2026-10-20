// Posts one message to the room's chat as a person and prints the agent's reply, so the agent can
// be tried without a UI: npm run say -- "@Scout what can you do?"
import { observeNewMessages, postMessage } from "@memo-air/chat";
import { joinRoom } from "@memo-air/client";
import { signLiveToken } from "@memo-air/protocol/tokens";

const liveUrl = process.env.LIVE_URL ?? "ws://localhost:3020";
const secret = process.env.LIVE_JWT_SECRET;
const chatDoc = process.env.CHAT_DOC ?? "room-chat";
const replyTimeoutMs = 60_000;
const text = process.argv.slice(2).join(" ").trim();
const you = { kind: "human" as const, id: "you", name: "You" };

if (!secret || !text) {
  throw new Error(
    'Usage: npm run say -- "@Scout a question" (with LIVE_JWT_SECRET in .env)'
  );
}

const room = joinRoom({
  url: liveUrl,
  token: async () =>
    signLiveToken(
      {
        actor: you,
        workspaceId: "airlink-room",
        docName: chatDoc,
        access: "write",
      },
      secret,
      300
    ),
  docName: chatDoc,
  presence: { name: you.name },
});
const timer = setTimeout(() => {
  process.stderr.write("No reply in 60 s: is `npm start` running?\n");
  room.leave();
  process.exit(1);
}, replyTimeoutMs);

let sent = false;
room.events.subscribe((event) => {
  if (event.type !== "synced" || sent) {
    return;
  }
  sent = true;
  observeNewMessages(room.doc, (message) => {
    if (message.actor.kind === "agent") {
      process.stdout.write(`${message.actor.name}: ${message.text}\n`);
      clearTimeout(timer);
      room.leave();
      process.exit(0);
    }
  });
  postMessage(room.doc, { text }, you);
});
