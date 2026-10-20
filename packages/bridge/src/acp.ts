import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type { ToolsMcp as RoomMcp } from "@memo-air/tools/mcp";
import type { Harness } from "./index.ts";
import { agentSystemPrompt } from "./pi.ts";

type Pending = {
  prompt: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
};

const asError = (err: unknown) =>
  err instanceof Error ? err : new Error(String(err));

// A harness may ask before any tool call. The room's own tools are already capped by the agent's
// token, so they are allowed once; anything else (a shell, a file write on the host) is refused.
// ponytail: matched by tool name in the request; a per-agent allow-list arrives with Settings (I).
function answerPermission(
  params: RequestPermissionRequest,
  roomToolNames: Set<string>
) {
  const asked = JSON.stringify(params.toolCall);
  const isRoomTool = [...roomToolNames].some((name) => asked.includes(name));
  const option = params.options.find((candidate) =>
    isRoomTool
      ? candidate.kind === "allow_once"
      : candidate.kind === "reject_once"
  );
  return option
    ? { outcome: { outcome: "selected" as const, optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" as const } };
}

// One child process and one ACP session per agent and channel, kept across turns. If the child
// exits, every waiting turn fails and the next turn starts a new one.
function startSession({
  command,
  cwd,
  mcpServer,
  roomToolNames,
}: {
  command: string[];
  cwd: string;
  mcpServer: ReturnType<RoomMcp["bind"]>;
  roomToolNames: Set<string>;
}) {
  const [bin, ...args] = command;
  const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "inherit"] });
  const inbox: Pending[] = [];
  let current: Pending | null = null;
  let wake: (() => void) | null = null;
  let dead: Error | null = null;

  const die = (err: Error) => {
    if (dead) {
      return;
    }
    dead = err;
    for (const pending of [...(current ? [current] : []), ...inbox]) {
      pending.reject(err);
    }
    inbox.length = 0;
    current = null;
  };
  child.once("exit", (code, signal) =>
    die(new Error(`harness exited (${signal ?? code})`))
  );
  child.once("error", (err) => die(err));

  const nextTurn = async (): Promise<Pending> => {
    while (inbox.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    const [turn] = inbox.splice(0, 1);
    return turn;
  };

  client({ name: "airlink" })
    .onRequest(methods.client.session.requestPermission, (ctx) =>
      answerPermission(ctx.params, roomToolNames)
    )
    .connectWith(
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
      async (ctx) => {
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await ctx
          .buildSession(cwd)
          .withMcpServer(mcpServer)
          .start();
        while (!dead) {
          current = await nextTurn();
          const turn = current;
          session.prompt(turn.prompt).catch(() => undefined);
          turn.resolve(await session.readText());
          current = null;
        }
      }
    )
    .catch((err) => die(asError(err)));

  return {
    alive: () => dead === null,
    prompt: (text: string) =>
      new Promise<string>((resolve, reject) => {
        if (dead) {
          reject(dead);
          return;
        }
        inbox.push({ prompt: text, resolve, reject });
        wake?.();
      }),
    close: () => {
      child.kill();
    },
  };
}

export function acpHarness({
  command,
  cwd = process.cwd(),
  mcp,
}: {
  command: string[];
  cwd?: string;
  mcp: RoomMcp;
}): Harness {
  const sessions = new Map<string, ReturnType<typeof startSession>>();
  return {
    async run({ sessionKey, agent, prompt, tools }) {
      const mcpServer = mcp.bind(sessionKey, tools);
      const existing = sessions.get(sessionKey);
      const isNew = existing?.alive() !== true;
      const session =
        existing && !isNew
          ? existing
          : startSession({
              command,
              cwd,
              mcpServer,
              roomToolNames: new Set(tools.map((tool) => tool.name)),
            });
      sessions.set(sessionKey, session);
      try {
        // An ACP harness keeps its own system prompt, so a new session learns who it is and how
        // the room works from its first message — the same words Pi gets as its system prompt.
        return await session.prompt(
          isNew
            ? `${agentSystemPrompt(agent, {
                memory: tools.some((tool) => tool.name === "remember"),
              })}\n\n---\n\n${prompt}`
            : prompt
        );
      } catch (err) {
        sessions.delete(sessionKey);
        session.close();
        throw err;
      }
    },
    close() {
      for (const session of sessions.values()) {
        session.close();
      }
      sessions.clear();
    },
  };
}
