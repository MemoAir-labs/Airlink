import type { AgentConfig } from "@memo-air/agents";

import type { VoiceKeys } from "./livekit.ts";
import {
  canTalk,
  openEar,
  openVoice,
  speechProviderOf,
  talkerLlmFor,
} from "./livekit.ts";
import type { VoiceActor, VoicePerson, VoiceRoom } from "./room.ts";
import { createVoiceRoom } from "./room.ts";
import type { SpeechProviderId, VoiceOption } from "./voices.ts";
import { defaultVoices, voiceFor } from "./voices.ts";

export type { VoiceKeys } from "./livekit.ts";
export { speechProviderOf } from "./livekit.ts";
export type { VoiceActor, VoicePerson } from "./room.ts";
export type { SpeechProviderId, VoiceOption } from "./voices.ts";
export { defaultVoices, voiceFor } from "./voices.ts";

export type VoiceSetup = {
  liveKitUrl: string;
  mintToken(
    grant: { identity: string; name: string; hidden: boolean },
    room: string
  ): Promise<string>;
  keys(): VoiceKeys;
  talkerModel(): string;
};

export type VoiceHost = {
  agentsIn(callDoc: string): Promise<AgentConfig[]>;
  route(text: string, agents: AgentConfig[]): Promise<string[]>;
  work(agent: AgentConfig, callDoc: string, task: string): Promise<string>;
  postToChat(agent: AgentConfig, callDoc: string, text: string): Promise<void>;
  writeLine(
    callDoc: string,
    actor: VoiceActor,
    line: { id: string; text: string; cut?: boolean }
  ): Promise<void>;
  // Posts a note in the call's chat from no agent in particular; without it notes are only logged.
  postNotice?(callDoc: string, text: string): Promise<void>;
  // The voices the provider offers this account; a saved voice outside it is not used.
  voiceCatalog?(): Promise<VoiceOption[]>;
  logger: {
    info(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
  };
};

// One VoiceRoom per call doc, opened when the first person joins and closed when the last leaves.
// Without a speech key or a talker the host keeps its text-only path (isAvailable() is false).
export function createVoice(setup: VoiceSetup, host: VoiceHost) {
  const rooms = new Map<string, VoiceRoom>();
  const isAvailable = () => {
    const keys = setup.keys();
    return (
      speechProviderOf(keys) !== null && canTalk(setup.talkerModel(), keys)
    );
  };

  const closeIfEmpty = async (callDoc: string, room: VoiceRoom) => {
    if (rooms.get(callDoc) === room && room.isEmpty()) {
      rooms.delete(callDoc);
      await room.close();
    }
  };

  const catalogFor = async (provider: SpeechProviderId) => {
    const fetched = await host.voiceCatalog?.().catch(() => null);
    return fetched?.length ? fetched : defaultVoices[provider];
  };

  const roomFor = (callDoc: string) => {
    const existing = rooms.get(callDoc);
    if (existing) {
      return existing;
    }
    const keys = setup.keys();
    const provider = speechProviderOf(keys);
    const talker = talkerLlmFor(setup.talkerModel(), keys);
    if (!provider || !talker) {
      return null;
    }
    const onError = (err: unknown, where: string) =>
      host.logger.error({ err, callDoc, where }, "voice: room error");
    const room = createVoiceRoom({
      openEar: async (person, events) =>
        openEar({
          url: setup.liveKitUrl,
          token: await setup.mintToken(
            {
              identity: `ear:${person.identity}`,
              name: `${person.name} (transcript)`,
              hidden: true,
            },
            callDoc
          ),
          person,
          provider,
          keys,
          events,
          onError,
        }),
      openVoice: async (agent, hooks) => {
        const agents = await host.agentsIn(callDoc);
        return openVoice({
          url: setup.liveKitUrl,
          token: await setup.mintToken(
            { identity: `agent:${agent.id}`, name: agent.name, hidden: false },
            callDoc
          ),
          agent,
          voice: voiceFor(agent, agents, await catalogFor(provider)),
          provider,
          keys,
          talker,
          work: hooks.work,
          said: hooks.said,
          onError,
        });
      },
      agents: () => host.agentsIn(callDoc),
      route: host.route,
      work: (agent, task) => host.work(agent, callDoc, task),
      postToChat: (agent, text) => host.postToChat(agent, callDoc, text),
      writeLine: (actor, line) => host.writeLine(callDoc, actor, line),
      nowMs: () => Date.now(),
      onError,
      notice: async (text) => {
        if (host.postNotice) {
          await host.postNotice(callDoc, text);
        } else {
          host.logger.info({ callDoc, text }, "voice: notice");
        }
      },
      onDrop: (text) =>
        host.logger.info({ callDoc, text }, "voice: dropped a line as echo"),
      onEmpty: () =>
        void closeIfEmpty(callDoc, room).catch((err: unknown) =>
          onError(err, "close")
        ),
    });
    rooms.set(callDoc, room);
    return room;
  };

  return {
    isAvailable,
    async join(callDoc: string, person: VoicePerson) {
      try {
        await roomFor(callDoc)?.join(person);
      } catch (err) {
        host.logger.error({ err, callDoc }, "voice: could not join the call");
      }
    },
    async leave(callDoc: string, identity: string) {
      const room = rooms.get(callDoc);
      if (room) {
        await room.leave(identity);
        await closeIfEmpty(callDoc, room);
      }
    },
    async close() {
      await Promise.all([...rooms.values()].map((room) => room.close()));
      rooms.clear();
    },
  };
}

export type VoiceService = ReturnType<typeof createVoice>;
