import { resolve } from "node:path";
import { createLiveAgentClient } from "@memo-air/agent";
import type { AgentConfig } from "@memo-air/agents";
import {
  rememberQuestion,
  rememberThreshold,
  routeMessage,
  routeSpoken,
  turnPrompt,
} from "@memo-air/agents";
import type { Decide, Decision } from "@memo-air/decide";
import { memoryTools, okfDirectoryStore } from "@memo-air/memory";
import type { LiveAccess, LiveActor, SpaceOp } from "@memo-air/protocol";
import { signLiveToken } from "@memo-air/protocol/tokens";
import type { RoomObject, RoomToolCall, RoomToolName } from "@memo-air/tools";
import {
  isRunnableToolName,
  parseRoomToolCall,
  roomToolAccess,
  roomTools,
  runRoomTool,
} from "@memo-air/tools";
import type { ServedTool } from "@memo-air/tools/mcp";
import { jsonParameters, serveToolsMcp } from "@memo-air/tools/mcp";
import { z } from "zod";

export type { ToolsMcp as RoomMcp } from "@memo-air/tools/mcp";
export { acpHarness } from "./acp.ts";
export type { DetectedHarness } from "./detect.ts";
export { detectHarnesses } from "./detect.ts";
export type { PiSessions } from "./pi.ts";
export { piDecide, piHarness } from "./pi.ts";

// The bridge is Airlink's agent runtime: live-server hands it a turn, it picks who answers with
// the room's routing, runs that agent on its harness with the room's tools, and posts the reply
// in the channel. Every action goes through live-server under the agent's own token, so an agent
// reaches only the room's objects and never more than its configured access.

export type BridgeTurn = {
  docName: string;
  workspaceId: string | null;
  event: {
    type: string;
    actor: LiveActor;
    payload: Record<string, unknown>;
    summary: string;
  };
  decision: Decision | null;
};

export type BridgeTool = ServedTool;

const spokenEventType = "spoken";

export const serveRoomMcp = () => serveToolsMcp({ name: "room" });

export type Harness = {
  run(input: {
    sessionKey: string;
    agent: AgentConfig;
    prompt: string;
    tools: BridgeTool[];
  }): Promise<string>;
  // Ends whatever the harness keeps running between turns (child processes).
  close?(): void;
};

export type BridgeRoom = {
  // The channel's chat doc for any object placed in it (itself for the chat doc).
  chatDocOf(docName: string): Promise<string | null>;
  objectsOf(chatDoc: string): Promise<RoomObject[]>;
  createObject(input: {
    chatDoc: string;
    agent: AgentConfig;
    tool: RoomToolName;
    args: unknown;
  }): Promise<{ ok: boolean; text: string }>;
  // The channel's desktop, when the host draws its objects as windows agents may arrange.
  spaceDocOf?(chatDoc: string): Promise<string | null>;
  // The agents a channel has; null, or absent, when every agent is in every channel.
  agentIdsOf?(chatDoc: string): Promise<string[] | null>;
  // An uploaded file's contents as text, when the host keeps uploads.
  readFile?(docName: string): Promise<{ ok: boolean; text: string }>;
  // Runs agent-written code in a runner object (a new one when runnerId is null); a host that cannot run code leaves both out.
  runCode?(input: {
    chatDoc: string;
    agent: AgentConfig;
    language: "python" | "node";
    code: string;
    title: string;
    runnerId: string | null;
  }): Promise<{ ok: boolean; text: string }>;
  scheduleRunner?(input: {
    chatDoc: string;
    agent: AgentConfig;
    runnerId: string;
    refreshMinutes: number;
  }): Promise<{ ok: boolean; text: string }>;
};

export type BridgeLogger = {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

const messageSchema = z.object({
  text: z.string(),
  mentions: z
    .array(z.object({ kind: z.enum(["human", "agent"]), id: z.string() }))
    .default([]),
});

// Exports produce files, and where a file goes is the host's; Airlink adds them with its storage.
const offeredTools = Object.values(roomTools).filter(
  (tool) => tool.effect !== "export"
);

const typingIntervalMs = 3000;

const capAccess = (wanted: LiveAccess, agent: AgentConfig): LiveAccess =>
  wanted === "write" && agent.access === "suggest" ? "suggest" : wanted;

// An agent's memory folder: `<memoryRoot>/<agent id>` unless the agent names its own. One place,
// so the bridge that writes it and a host that shows it read the same folder.
const spaceOpsBatch = 50;

type WindowAction =
  | "open"
  | "close"
  | "minimize"
  | "maximize"
  | "restore"
  | "front";

// One arrange action on one object, as the space op that does it; null when there is nothing to
// do (closing a window that is already closed).
function windowOp(
  action: WindowAction,
  object: RoomObject,
  window: { id: string } | undefined
): SpaceOp | null {
  if (action === "open") {
    return window
      ? { type: "set_state", id: window.id, state: "open" }
      : {
          type: "place",
          docName: object.id,
          kind: object.kind,
          title: object.title,
        };
  }
  if (!window) {
    return null;
  }
  switch (action) {
    case "close":
      return { type: "remove", id: window.id };
    case "minimize":
      return { type: "set_state", id: window.id, state: "minimized" };
    case "maximize":
      return { type: "set_state", id: window.id, state: "maximized" };
    case "restore":
      return { type: "set_state", id: window.id, state: "open" };
    case "front":
      return { type: "bring_to_front", id: window.id };
  }
}

const readFileSchema = {
  doc_id: z.string().describe("The file's id from the room's list."),
};

const runCodeSchema = {
  language: z.enum(["python", "node"]),
  code: z.string().min(1).max(200_000).describe("The whole script."),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("The runner window's title."),
  runner_id: z
    .string()
    .optional()
    .describe(
      "A runner's id from 'Live objects in this room', to change and re-run it. Leave out to make a new runner."
    ),
};

const scheduleRunnerSchema = {
  runner_id: z
    .string()
    .describe("A runner's id from 'Live objects in this room'."),
  refresh_minutes: z
    .number()
    .int()
    .min(0)
    .max(1440)
    .describe("Re-run every this many minutes; 0 turns the refresh off."),
};

const arrangeWindowsSchema = {
  actions: z
    .array(
      z.object({
        id: z
          .string()
          .describe("An object's id from the room's list, or \"all\"."),
        action: z.enum([
          "open",
          "close",
          "minimize",
          "maximize",
          "restore",
          "front",
        ]),
      })
    )
    .max(50)
    .optional()
    .describe("What to change, in order. Leave out to only list the windows."),
};

export function agentMemory(memoryRoot: string, agent: AgentConfig) {
  const dir = resolve(memoryRoot, agent.memoryDir ?? agent.id);
  return { dir, store: okfDirectoryStore(dir) };
}

export function createBridge({
  liveUrl,
  jwtSecret,
  agents,
  decide,
  harnesses,
  room,
  logger,
  memoryRoot,
  queues = new Map(),
}: {
  liveUrl: string;
  jwtSecret: string;
  agents: AgentConfig[];
  decide: Decide;
  harnesses: Record<string, Harness>;
  room: BridgeRoom;
  logger: BridgeLogger;
  // Where agents keep memory: `<memoryRoot>/<agent id>` unless the agent names its own folder.
  // Without it agents have no memory tools.
  memoryRoot?: string;
  // A host that rebuilds the bridge passes the same map each time, so a turn still running on
  // the old bridge stays ahead of the next one for that agent and channel.
  queues?: Map<string, Promise<void>>;
}) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));

  const clientFor = (
    agent: AgentConfig,
    workspaceId: string,
    docName: string,
    access: LiveAccess
  ) =>
    createLiveAgentClient({
      baseUrl: liveUrl,
      docName,
      token: signLiveToken(
        {
          actor: { kind: "agent", id: agent.id, name: agent.name },
          workspaceId,
          docName,
          access: capAccess(access, agent),
        },
        jwtSecret
      ),
    });

  // Memory is the agent's across channels; the room only gates what is worth keeping.
  const memoryToolsFor = (
    agent: AgentConfig,
    chatDoc: string
  ): BridgeTool[] => {
    if (memoryRoot === undefined) {
      return [];
    }
    const { store } = agentMemory(memoryRoot, agent);
    return memoryTools(store, {
      resource: `room:${chatDoc}`,
      gate: async (entry) => {
        const answer = (await decide(rememberQuestion(entry, agent.name)))
          .answers?.remember;
        // A decision that failed saves: a lost memory costs more than a stray note a person deletes.
        return answer?.type === "noul" && answer.noul < rememberThreshold
          ? "the room judged this useful only in this conversation. Keep it in the chat or a live object."
          : null;
      },
    }).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: jsonParameters(tool.schema),
      run: tool.run,
    }));
  };

  const toolsFor = (
    agent: AgentConfig,
    workspaceId: string,
    chatDoc: string
  ): BridgeTool[] => [
    ...offeredTools.map(
      (tool): BridgeTool => ({
        name: tool.name,
        description: tool.description,
        parameters: jsonParameters(tool.schema),
        run: async (args) => {
          if (!isRunnableToolName(tool.name)) {
            return room.createObject({ chatDoc, agent, tool: tool.name, args });
          }
          const parsed = parseRoomToolCall(tool.name, args);
          if (!parsed.ok) {
            return { ok: false, text: parsed.error };
          }
          return runInRoom(agent, workspaceId, chatDoc, parsed.call);
        },
      })
    ),
    ...memoryToolsFor(agent, chatDoc),
    ...windowToolsFor(agent, workspaceId, chatDoc),
    ...fileToolsFor(chatDoc),
    ...runnerToolsFor(agent, chatDoc),
  ];

  // Uploaded files live with the host, not in a live doc, so the host reads them.
  const fileToolsFor = (chatDoc: string): BridgeTool[] => {
    const readFile = room.readFile;
    if (!readFile) {
      return [];
    }
    return [
      {
        name: "read_live_file",
        description:
          "Read a file someone uploaded to this channel (a \"file\" in 'Live objects in this room'): text and code as they are, a PDF's text page by page, a spreadsheet (.xlsx) as CSV per sheet. Read it before answering about it.",
        parameters: jsonParameters(readFileSchema),
        run: async (args) => {
          const parsed = z.object(readFileSchema).safeParse(args);
          if (!parsed.success) {
            return { ok: false, text: parsed.error.message };
          }
          const found = (await room.objectsOf(chatDoc)).find(
            (object) =>
              object.id === parsed.data.doc_id && object.kind === "file"
          );
          return found
            ? readFile(found.id)
            : {
                ok: false,
                text: `No file ${parsed.data.doc_id} is in this room.`,
              };
        },
      },
    ];
  };

  // Code runs with the host, in a runner object the whole channel sees; a runner id from another
  // channel is refused here, before the host is asked.
  const runnerToolsFor = (
    agent: AgentConfig,
    chatDoc: string
  ): BridgeTool[] => {
    const { runCode, scheduleRunner } = room;
    if (!runCode || !scheduleRunner) {
      return [];
    }
    const inRoom = async (id: string) =>
      (await room.objectsOf(chatDoc)).some(
        (object) => object.id === id && object.kind === "runner"
      );
    return [
      {
        name: "run_code",
        description:
          "Run a Python 3 or Node 22 script in a runner window everyone in this channel sees. The channel's uploaded files are read-only in /files; write results to /out (the working directory): images, CSV, JSON, and an index.html, which becomes the runner's live dashboard and may load the other /out files by relative path. Python has pandas, numpy, matplotlib (save figures with savefig), requests and openpyxl; Node has its built-ins and fetch. The network is on. A run stops after 60 s; past 20 files or 50 MB, output is left out. You get the status, exit code, the end of stdout and stderr, and the files written: fix the script and call again with runner_id to re-run the same runner instead of making another. People see the code and output and can press Re-run, but cannot edit it.",
        parameters: jsonParameters(runCodeSchema),
        run: async (args) => {
          const parsed = z.object(runCodeSchema).safeParse(args);
          if (!parsed.success) {
            return { ok: false, text: parsed.error.message };
          }
          const runnerId = parsed.data.runner_id ?? null;
          if (runnerId && !(await inRoom(runnerId))) {
            return {
              ok: false,
              text: `No runner ${runnerId} is in this room.`,
            };
          }
          return runCode({
            chatDoc,
            agent,
            language: parsed.data.language,
            code: parsed.data.code,
            title: parsed.data.title,
            runnerId,
          });
        },
      },
      {
        name: "schedule_runner",
        description:
          "Make a runner re-run on its own every refresh_minutes (0 turns it off), so its dashboard stays current. Runs never overlap; anyone in the channel can pause it; three failed refreshes in a row pause it and say so in the chat.",
        parameters: jsonParameters(scheduleRunnerSchema),
        run: async (args) => {
          const parsed = z.object(scheduleRunnerSchema).safeParse(args);
          if (!parsed.success) {
            return { ok: false, text: parsed.error.message };
          }
          if (!(await inRoom(parsed.data.runner_id))) {
            return {
              ok: false,
              text: `No runner ${parsed.data.runner_id} is in this room.`,
            };
          }
          return scheduleRunner({
            chatDoc,
            agent,
            runnerId: parsed.data.runner_id,
            refreshMinutes: parsed.data.refresh_minutes,
          });
        },
      },
    ];
  };

  // Arranging the channel's windows is a participant's right, like a person's: open, close (it
  // waits on the desktop, nothing is lost), minimize, maximize, restore, bring to front. Deleting
  // is not offered; that stays with people.
  const windowToolsFor = (
    agent: AgentConfig,
    workspaceId: string,
    chatDoc: string
  ): BridgeTool[] => {
    const spaceDocOf = room.spaceDocOf;
    if (!spaceDocOf) {
      return [];
    }
    return [
      {
        name: "arrange_windows",
        description:
          "See and arrange the windows on this channel's shared desktop; everyone in the channel sees the change. With no actions it lists every object and whether its window is open, minimized, maximized or closed. Actions: open (a closed window comes back), close (it goes to the desktop as an icon; nothing is deleted), minimize (to the dock), maximize, restore, front. Use the ids from 'Live objects in this room', or \"all\" to act on every window at once.",
        parameters: jsonParameters(arrangeWindowsSchema),
        run: async (args) => {
          const parsed = z.object(arrangeWindowsSchema).safeParse(args);
          if (!parsed.success) {
            return { ok: false, text: parsed.error.message };
          }
          const spaceDoc = await spaceDocOf(chatDoc);
          if (!spaceDoc) {
            return { ok: false, text: "This channel has no desktop." };
          }
          const space = clientFor(agent, workspaceId, spaceDoc, "write");
          const objects = await room.objectsOf(chatDoc);
          const windowsNow = async () =>
            new Map(
              (await space.readSpace()).objects.map((object) => [
                object.docName,
                object,
              ])
            );
          let windows = await windowsNow();
          const ops = (parsed.data.actions ?? []).flatMap((step) =>
            (step.id === "all"
              ? objects
              : objects.filter((o) => o.id === step.id)
            ).flatMap((object) => {
              const op = windowOp(step.action, object, windows.get(object.id));
              return op ? [op] : [];
            })
          );
          const failed: string[] = [];
          for (let at = 0; at < ops.length; at += spaceOpsBatch) {
            const response = await space.spaceOps({
              ops: ops.slice(at, at + spaceOpsBatch),
            });
            failed.push(
              ...response.results.flatMap((result) =>
                result.ok ? [] : [result.error]
              )
            );
          }
          windows = await windowsNow();
          const lines = objects.map((object) => {
            const window = windows.get(object.id);
            return `- ${object.kind} "${object.title}" (${object.id}): ${window ? window.state : "closed"}`;
          });
          return {
            ok: failed.length === 0,
            text: [
              ops.length
                ? `Applied ${ops.length - failed.length} of ${ops.length} changes${failed.length ? ` (refused: ${[...new Set(failed)].join(", ")})` : ""}.`
                : null,
              "Windows on the desktop:",
              ...lines,
            ]
              .filter((line) => line !== null)
              .join("\n"),
          };
        },
      },
    ];
  };

  const runInRoom = async (
    agent: AgentConfig,
    workspaceId: string,
    chatDoc: string,
    call: RoomToolCall
  ) => {
    const object = (await room.objectsOf(chatDoc)).find(
      (candidate) => candidate.id === call.args.doc_id
    );
    const kinds: readonly string[] = roomTools[call.name].kinds;
    if (!object || !kinds.includes(object.kind)) {
      return {
        ok: false,
        text: `No live ${kinds.join(" or ")} ${call.args.doc_id} is in this room.`,
      };
    }
    const result = await runRoomTool(
      clientFor(agent, workspaceId, object.id, roomToolAccess(call)),
      call,
      object
    );
    return result.ok
      ? { ok: true, text: result.text }
      : { ok: false, text: result.error };
  };

  const postReply = async (
    agent: AgentConfig,
    workspaceId: string,
    chatDoc: string,
    text: string
  ) => {
    await clientFor(agent, workspaceId, chatDoc, "write").chatOps({
      ops: [{ type: "post_message", text }],
    });
  };

  // The channel shows the agent typing while it works; presence lapses on its own if this
  // process dies mid-turn.
  const startTyping = (
    agent: AgentConfig,
    workspaceId: string,
    chatDoc: string
  ) => {
    const typing = () =>
      clientFor(agent, workspaceId, chatDoc, "write")
        .chatOps({ ops: [{ type: "typing" }] })
        .catch(() => undefined);
    void typing();
    const typingTimer = setInterval(() => void typing(), typingIntervalMs);
    return () => clearInterval(typingTimer);
  };

  const runAgent = async (
    agent: AgentConfig,
    turn: BridgeTurn,
    {
      workspaceId,
      chatDoc,
      unsure,
    }: {
      workspaceId: string;
      chatDoc: string;
      unsure: boolean;
    }
  ) => {
    const harness = harnesses[agent.harness] ?? harnesses.pi;
    if (!harness) {
      logger.error(
        { agentId: agent.id, harnessId: agent.harness },
        "bridge: no harness for agent"
      );
      return;
    }
    const objects = await room.objectsOf(chatDoc);
    const object =
      turn.docName === chatDoc
        ? undefined
        : objects.find((candidate) => candidate.id === turn.docName);
    const prompt = [
      turnPrompt({ event: turn.event, object, unsure }),
      objects.length
        ? `Live objects in this room:\n${objects
            .map(
              (candidate) =>
                `- ${candidate.kind} "${candidate.title}" (${candidate.id})`
            )
            .join("\n")}`
        : "This room has no live objects yet.",
    ].join("\n\n");
    const stopTyping = startTyping(agent, workspaceId, chatDoc);
    try {
      const reply = await harness.run({
        sessionKey: `${agent.id}:${chatDoc}`,
        agent,
        prompt,
        tools: toolsFor(agent, workspaceId, chatDoc),
      });
      if (!reply.trim()) {
        return;
      }
      await postReply(agent, workspaceId, chatDoc, reply.trim());
    } catch (err) {
      logger.error({ err, agentId: agent.id, chatDoc }, "bridge: turn failed");
      await postReply(
        agent,
        workspaceId,
        chatDoc,
        `${agent.name} stopped before finishing.`
      ).catch((postErr) =>
        logger.error({ err: postErr, chatDoc }, "bridge: stop notice failed")
      );
    } finally {
      stopTyping();
    }
  };

  // One turn at a time per agent per channel, in arrival order: a second message waits for the
  // first answer instead of racing it.
  const enqueue = (key: string, work: () => Promise<void>) => {
    const next = (queues.get(key) ?? Promise.resolve())
      .then(work)
      .catch((err) =>
        logger.error({ err, key }, "bridge: a turn failed before it started")
      );
    queues.set(key, next);
    return next;
  };

  return {
    async post({
      agent,
      chatDoc,
      workspaceId,
      text,
    }: {
      agent: AgentConfig;
      chatDoc: string;
      workspaceId: string;
      text: string;
    }): Promise<void> {
      await postReply(agent, workspaceId, chatDoc, text);
    },

    async work({
      agent,
      chatDoc,
      workspaceId,
      task,
    }: {
      agent: AgentConfig;
      chatDoc: string;
      workspaceId: string;
      task: string;
    }): Promise<string> {
      const harness = harnesses[agent.harness] ?? harnesses.pi;
      if (!harness) {
        return `${agent.name} has no harness to work on.`;
      }
      let result = `${agent.name} stopped before finishing.`;
      // The same session as the agent's chat turns, so it waits its turn in the same queue.
      await enqueue(`${agent.id}:${chatDoc}`, async () => {
        const stopTyping = startTyping(agent, workspaceId, chatDoc);
        try {
          const reply = (
            await harness.run({
              sessionKey: `${agent.id}:${chatDoc}`,
              agent,
              prompt: `Someone asked you in the call: ${task}\nDo it with your live tools. Your reply is posted in the channel's chat and summarised aloud.`,
              tools: toolsFor(agent, workspaceId, chatDoc),
            })
          ).trim();
          if (reply) {
            await postReply(agent, workspaceId, chatDoc, reply);
          }
          result = reply || "Done.";
        } catch (err) {
          logger.error(
            { err, agentId: agent.id, chatDoc },
            "bridge: voice work failed"
          );
        } finally {
          stopTyping();
        }
      });
      return result;
    },

    async onTurn(turn: BridgeTurn): Promise<void> {
      const workspaceId = turn.workspaceId ?? "airlink";
      const chatDoc = await room.chatDocOf(turn.docName);
      if (!chatDoc) {
        return;
      }
      const message =
        turn.event.type === "message"
          ? messageSchema.safeParse(turn.event.payload)
          : null;
      if (message && !message.success) {
        return;
      }
      const mentions = message?.data.mentions ?? [];
      // A message addressed only to people is theirs to answer.
      if (
        mentions.length > 0 &&
        mentions.every((mention) => mention.kind === "human")
      ) {
        return;
      }
      const memberIds = (await room.agentIdsOf?.(chatDoc)) ?? null;
      const inRoom = memberIds
        ? agents.filter((agent) => memberIds.includes(agent.id))
        : agents;
      // People mostly talk to each other in a call; an agent answers only when named or clearly meant.
      if (turn.event.type === spokenEventType) {
        const agentIds = await routeSpoken(turn.event.summary, inRoom, {
          decide,
        });
        logger.info(
          { docName: turn.docName, route: "spoken", agentIds },
          "bridge: turn routed"
        );
        await Promise.all(
          agentIds.flatMap((agentId) => {
            const agent = byId.get(agentId);
            return agent
              ? [
                  enqueue(`${agent.id}:${chatDoc}`, () =>
                    runAgent(agent, turn, {
                      workspaceId,
                      chatDoc,
                      unsure: false,
                    })
                  ),
                ]
              : [];
          })
        );
        return;
      }
      const route = await routeMessage(
        {
          text: message?.data.text ?? turn.event.summary,
          mentions: mentions
            .filter((mention) => mention.kind === "agent")
            .map((mention) => mention.id),
          tags: [],
        },
        inRoom,
        {
          decide,
          fallbackAgentId: inRoom[0]?.id ?? null,
        }
      );
      const chosen =
        route.kind === "mentioned"
          ? route.agentIds
          : route.kind === "routed"
            ? [route.agentId]
            : route.kind === "fallback" && route.agentId
              ? [route.agentId]
              : [];
      logger.info(
        { docName: turn.docName, route: route.kind, agentIds: chosen },
        "bridge: turn routed"
      );
      await Promise.all(
        chosen.flatMap((agentId) => {
          const agent = byId.get(agentId);
          return agent
            ? [
                enqueue(`${agent.id}:${chatDoc}`, () =>
                  runAgent(agent, turn, {
                    workspaceId,
                    chatDoc,
                    unsure:
                      route.kind === "fallback" && route.decision !== null,
                  })
                ),
              ]
            : [];
        })
      );
    },
  };
}

export type Bridge = ReturnType<typeof createBridge>;
