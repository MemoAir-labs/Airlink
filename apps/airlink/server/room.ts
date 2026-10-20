import { createLiveAgentClient } from "@memo-air/agent";
import type { AgentConfig } from "@memo-air/agents";
import type { BridgeRoom } from "@memo-air/bridge";
import type { LiveActor } from "@memo-air/protocol";
import { signLiveToken } from "@memo-air/protocol/tokens";
import {
  createdObject,
  fillCreatedObject,
  isCreateToolName,
  parseCreateToolCall,
} from "@memo-air/tools";
import { fileText } from "./extract.ts";
import type { Runner } from "./runner.ts";
import { describeRun, unreachableText } from "./runner.ts";
import type { Store } from "./store.ts";

import { workspaceId } from "./workspace.ts";

export { workspaceId };

export function createRoom({
  store,
  liveUrl,
  jwtSecret,
  runner,
}: {
  store: Store;
  liveUrl: string;
  jwtSecret: string;
  runner?: Runner;
}): BridgeRoom {
  const clientFor = (actor: LiveActor, docName: string) =>
    createLiveAgentClient({
      baseUrl: liveUrl,
      docName,
      token: signLiveToken(
        { actor, workspaceId, docName, access: "write" },
        jwtSecret
      ),
    });

  // A new runner joins the channel and is placed in its space like an agent's new sheet, then runs.
  const runnerTools = (
    runner: Runner
  ): Pick<BridgeRoom, "runCode" | "scheduleRunner"> => ({
    runCode: async ({ chatDoc, agent, language, code, title, runnerId }) => {
      let created = false;
      let placed = false;
      try {
        const found = await store.docOf(chatDoc);
        if (!found) {
          return { ok: false, text: "This channel no longer exists." };
        }
        if (!(await runner.reachable())) {
          return { ok: false, text: unreachableText };
        }
        if (runnerId) {
          const row = await store.runner(runnerId);
          if (!row || row.channel.id !== found.channel.id) {
            return {
              ok: false,
              text: `No runner ${runnerId} is in this room.`,
            };
          }
          if (runner.isRunning(runnerId)) {
            return {
              ok: false,
              text: "That runner is still running its last job; wait for it to finish, then call run_code again.",
            };
          }
          await store.updateRunner(runnerId, { title, language, code });
        }
        const docName =
          runnerId ??
          (
            await store.addRunner({
              channelId: found.channel.id,
              title,
              language,
              code,
              createdBy: agent.id,
            })
          ).docName;
        if (!runnerId) {
          created = true;
          await clientFor(agentActor(agent), found.channel.spaceDoc).spaceOps({
            ops: [{ type: "place", docName, kind: "runner", title }],
          });
          placed = true;
        }
        const outcome = await runner.run(docName, agentActor(agent));
        return {
          ok: outcome.ok && outcome.status === "ok",
          text: describeRun(outcome),
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          text:
            created && !placed
              ? `The runner was created but not placed in the channel's space, and did not run: ${reason}`
              : `The code could not be run: ${reason}`,
        };
      }
    },
    scheduleRunner: async ({ chatDoc, runnerId, refreshMinutes }) => {
      try {
        const found = await store.docOf(chatDoc);
        const row = await store.runner(runnerId);
        if (!found || !row || row.channel.id !== found.channel.id) {
          return { ok: false, text: `No runner ${runnerId} is in this room.` };
        }
        await runner.setRefresh(runnerId, refreshMinutes);
        return {
          ok: true,
          text: refreshMinutes
            ? `The runner re-runs every ${refreshMinutes} minute${refreshMinutes === 1 ? "" : "s"} while the channel exists; anyone in the channel can pause it.`
            : "The runner's refresh is off.",
        };
      } catch (err) {
        return {
          ok: false,
          text: `The refresh could not be set: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });

  return {
    chatDocOf: async (docName) =>
      (await store.docOf(docName))?.channel.chatDoc ?? null,
    spaceDocOf: async (chatDoc) =>
      (await store.docOf(chatDoc))?.channel.spaceDoc ?? null,
    readFile: async (docName) => {
      const file = await store.fileBytes(docName);
      return file ? fileText(file) : { ok: false, text: "That file is gone." };
    },
    agentIdsOf: async (chatDoc) => {
      const found = await store.docOf(chatDoc);
      return !found || found.channel.open
        ? null
        : (await store.membersOf(found.channel.id)).agents;
    },

    objectsOf: async (chatDoc) => {
      const found = await store.docOf(chatDoc);
      return found
        ? (await store.objects(found.channel.id)).map((object) => ({
            id: object.docName,
            title: object.title,
            kind: object.kind,
          }))
        : [];
    },

    // The bridge offers an agent every create tool; the object joins the channel, is placed in
    // its space at once (no person needs to be watching) and starts with what the agent wrote.
    createObject: async ({ chatDoc, agent, tool, args }) => {
      if (!isCreateToolName(tool)) {
        return { ok: false, text: `${tool} is not available in AirLink.` };
      }
      const parsed = parseCreateToolCall(tool, args);
      if (!parsed.ok) {
        return { ok: false, text: parsed.error };
      }
      const found = await store.docOf(chatDoc);
      if (!found) {
        return { ok: false, text: "This channel no longer exists." };
      }
      const { kind, title, onePerRoom } = createdObject(parsed.call);
      const { object, existing } = await store.findOrAddObject({
        channelId: found.channel.id,
        kind,
        title,
        onePerRoom,
        createdBy: agent.id,
      });
      const actor = agentActor(agent);
      try {
        if (!existing) {
          await clientFor(actor, found.channel.spaceDoc).spaceOps({
            ops: [
              {
                type: "place",
                docName: object.docName,
                kind,
                title: object.title,
              },
            ],
          });
        }
        const text = await fillCreatedObject(
          clientFor(actor, object.docName),
          parsed.call,
          { id: object.docName, title: object.title, kind },
          { existing }
        );
        return { ok: true, text };
      } catch (err) {
        return {
          ok: false,
          text: `The ${kind} was created but could not be filled: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    ...(runner?.available ? runnerTools(runner) : {}),
  };
}

const agentActor = (agent: AgentConfig): LiveActor => ({
  kind: "agent",
  id: agent.id,
  name: agent.name,
});
