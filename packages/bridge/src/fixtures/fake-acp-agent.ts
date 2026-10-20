import { existsSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// A stand-in harness for the bridge tests: on each prompt it calls the room's read_live_sheet over
// the MCP server it was handed, asks to run a shell command, and answers with what it saw. With
// --exit-once=<file> it dies right after the tool call the first time, as a crashing harness would,
// and leaves the file behind so the next process it is restarted as answers.
const servers = new Map<
  string,
  { url: string; headers: Record<string, string> }
>();

agent({ name: "fake" })
  .onRequest("initialize", () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false, mcpCapabilities: { http: true } },
  }))
  .onRequest("session/new", (ctx) => {
    const sessionId = crypto.randomUUID();
    const room = ctx.params.mcpServers.find((server) => "url" in server);
    if (room && "url" in room) {
      servers.set(sessionId, {
        url: room.url,
        headers: Object.fromEntries(room.headers.map((h) => [h.name, h.value])),
      });
    }
    return { sessionId };
  })
  .onRequest("session/prompt", async (ctx) => {
    const { sessionId } = ctx.params;
    const room = servers.get(sessionId);
    if (!room) {
      throw new Error("no room server");
    }
    const mcp = new Client({ name: "fake", version: "0.0.0" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(room.url), {
        requestInit: { headers: room.headers },
      })
    );
    const read = await mcp.callTool({
      name: "read_live_sheet",
      arguments: { doc_id: "ldoc_s" },
    });
    await mcp.close();
    const exitOnce = process.argv
      .find((arg) => arg.startsWith("--exit-once="))
      ?.slice("--exit-once=".length);
    if (exitOnce && !existsSync(exitOnce)) {
      writeFileSync(exitOnce, "exited");
      process.exit(1);
    }
    const shell = await ctx.client.request(
      methods.client.session.requestPermission,
      {
        sessionId,
        toolCall: {
          toolCallId: "t2",
          title: "Run rm -rf /tmp/x",
          kind: "execute",
        },
        options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
      }
    );
    const content = Array.isArray(read.content) ? read.content : [];
    const first = content[0];
    const text =
      first && first.type === "text" ? first.text.split("\n")[0] : "";
    const verdict =
      shell.outcome.outcome === "selected"
        ? shell.outcome.optionId
        : "cancelled";
    await ctx.client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `saw: ${text} | shell: ${verdict}` },
      },
    });
    return { stopReason: "end_turn" };
  })
  .connect(
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
  );
