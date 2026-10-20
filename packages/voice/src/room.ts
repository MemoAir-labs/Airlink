import type { AgentConfig } from "@memo-air/agents";

import { createEchoFilter } from "./echo.ts";
import type { Floor } from "./floor.ts";
import { createFloor } from "./floor.ts";
import { isBargeIn } from "./gate.ts";

// `identity` is the person's LiveKit participant (one per tab); `id` is who the transcript credits.
export type VoicePerson = { id: string; name: string; identity: string };
export type Ear = { close(): Promise<void> };
export type EarEvents = {
  onSpeechStart(): void;
  onSpeechStop(): void;
  onInterim(words: string, voicedMs: number): void;
  onTurn(text: string): void;
  // The ear's session died (STT gone, LiveKit dropped); the room opens a new one.
  onLost(): void;
  // The person left LiveKit without saying so (tab closed, crash, network gone); the room lets
  // them go as if they had left.
  onGone(): void;
};
export type Spoken = { said: string; cut: boolean };
export type Voice = {
  // Speaks a reply to the turn; resolves when it finished or was cut, with what was said.
  reply(turn: string): Promise<Spoken>;
  // Speaks the result of finished work in a sentence or two.
  report(result: string): Promise<Spoken>;
  stop(): void;
  close(): Promise<void>;
};
export type VoiceActor = { kind: "human" | "agent"; id: string; name: string };
export type VoiceRoomDeps = {
  openEar(person: VoicePerson, events: EarEvents): Promise<Ear>;
  openVoice(
    agent: AgentConfig,
    hooks: { work(task: string): Promise<string>; said(text: string): void }
  ): Promise<Voice>;
  agents(): Promise<AgentConfig[]>;
  route(text: string, agents: AgentConfig[]): Promise<string[]>;
  work(agent: AgentConfig, task: string): Promise<string>;
  postToChat(agent: AgentConfig, text: string): Promise<void>;
  writeLine(
    actor: VoiceActor,
    line: { id: string; text: string; cut?: boolean }
  ): Promise<void>;
  nowMs(): number;
  onError?(err: unknown, where: string): void;
  // Tells the call's chat something people should know, such as a person nobody can hear.
  notice?(text: string): Promise<void>;
  // A person's line was dropped as an agent's own echo.
  onDrop?(text: string): void;
  // The last person went without leaving; the host closes the room.
  onEmpty?(): void;
};

const earRetryFirstMs = 1000;
const earRetryMaxMs = 30_000;
export const earMaxFailures = 5;
export const routeTimeoutMs = 3000;
export const voiceIdleMs = 600_000;
export const maxTurnMs = 90_000;

// One call: an ear per person, a voice per agent that has been addressed, one floor. A person's
// finished turn is written to the transcript, routed, and handed to the floor; a person talking
// over an agent stops it; an agent's finished work comes back as news.
export function createVoiceRoom(
  deps: VoiceRoomDeps,
  floor: Floor = createFloor()
) {
  const ears = new Map<string, Ear>();
  const joining = new Map<string, Promise<void>>();
  // Identities in the call; an ear is retried only while its person is still here.
  const present = new Set<string>();
  const earFailures = new Map<string, number>();
  const earCappedFailures = new Map<string, number>();
  const earRetries = new Map<string, ReturnType<typeof setTimeout>>();
  const voices = new Map<string, Promise<Voice>>();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const agentsSeen = new Map<string, AgentConfig>();
  const pending = new Map<string, string[]>();
  const echo = createEchoFilter();
  // Turns route in the order they were said, however long each route takes.
  let routed: Promise<void> = Promise.resolve();
  let closed = false;

  const fail = (where: string) => (err: unknown) => deps.onError?.(err, where);

  const actorOf = (agent: AgentConfig): VoiceActor => ({
    kind: "agent",
    id: agent.id,
    name: agent.name,
  });

  const spoke = async (agent: AgentConfig, spoken: Spoken) => {
    if (!spoken.said) {
      return;
    }
    echo.agentSaid(spoken.said, deps.nowMs());
    await deps.writeLine(actorOf(agent), {
      id: crypto.randomUUID(),
      text: spoken.said,
      ...(spoken.cut ? { cut: true } : {}),
    });
  };

  // Drops a voice only if it is still the one that failed, so a newer one survives, and closes it
  // so its session does not linger in the call.
  const forget = (agentId: string, voice: Promise<Voice>) => {
    if (voices.get(agentId) !== voice) {
      return;
    }
    voices.delete(agentId);
    clearTimeout(idleTimers.get(agentId));
    idleTimers.delete(agentId);
    void voice
      .then(
        (each) => each.close(),
        () => undefined
      )
      .catch(fail("voice close"));
  };

  // A voice nobody has heard from in a while leaves the call; the next turn opens a new one.
  const touch = (agentId: string, voice: Promise<Voice>) => {
    if (voices.get(agentId) !== voice) {
      return;
    }
    clearTimeout(idleTimers.get(agentId));
    idleTimers.set(
      agentId,
      setTimeout(() => forget(agentId, voice), voiceIdleMs)
    );
  };

  // A playout that never resolves would hold the floor for good, so a turn has a ceiling.
  const speakWith = async (
    agent: AgentConfig,
    voice: Promise<Voice>,
    say: (each: Voice) => Promise<Spoken>
  ): Promise<Spoken> => {
    const each = await voice;
    touch(agent.id, voice);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const overran = new Promise<Spoken>((resolve) => {
      watchdog = setTimeout(() => {
        fail("floor")(new Error(`${agent.name} spoke past ${maxTurnMs} ms`));
        each.stop();
        forget(agent.id, voice);
        resolve({ said: "", cut: true });
      }, maxTurnMs);
    });
    try {
      return await Promise.race([say(each), overran]);
    } finally {
      clearTimeout(watchdog);
      touch(agent.id, voice);
    }
  };

  const voiceOf = (agent: AgentConfig): Promise<Voice> => {
    const existing = voices.get(agent.id);
    if (existing) {
      return existing;
    }
    if (closed) {
      return Promise.reject(new Error("voice room is closed"));
    }
    const opened = deps.openVoice(agent, {
      said: (text) => echo.agentSaid(text, deps.nowMs()),
      // Runs detached from the talker, so nothing may escape it: a failed harness is reported and
      // the call is told in chat rather than left waiting for news that never comes.
      work: async (task) => {
        try {
          // The harness has already posted its result in chat, so a closed call or a dead voice
          // loses only the spoken summary.
          const result = await deps.work(agent, task);
          if (closed) {
            return result;
          }
          floor.request({
            agentId: agent.id,
            kind: "news",
            speak: async () => {
              let spoken: Spoken;
              const voice = voiceOf(agent);
              try {
                spoken = await speakWith(agent, voice, (each) =>
                  each.report(result)
                );
              } catch (err) {
                fail("news")(err);
                forget(agent.id, voice);
                return;
              }
              await spoke(agent, spoken).catch(fail("transcript"));
            },
          });
          return result;
        } catch (err) {
          fail("work")(err);
          const stopped = `${agent.name} stopped before finishing.`;
          await deps.postToChat(agent, stopped).catch(fail("work"));
          return stopped;
        }
      },
    });
    voices.set(agent.id, opened);
    touch(agent.id, opened);
    opened.catch(() => forget(agent.id, opened));
    return opened;
  };

  const answer = (agent: AgentConfig) => {
    if (closed) {
      return;
    }
    floor.request({
      agentId: agent.id,
      kind: "reply",
      speak: async () => {
        // A turn still routing may be for this agent too; one reply answers both, and the request
        // that turn makes finds nothing left to say.
        await routed;
        const turn = (pending.get(agent.id) ?? []).join(" ");
        pending.delete(agent.id);
        if (!turn) {
          return;
        }
        let spoken: Spoken;
        const voice = voiceOf(agent);
        try {
          spoken = await speakWith(agent, voice, (each) => each.reply(turn));
        } catch (err) {
          // No voice (talker or TTS down): the harness answers in chat, slower but still right, and
          // off the floor so the call is not held for the whole run.
          fail("voice")(err);
          forget(agent.id, voice);
          void deps.work(agent, turn).catch(fail("fallback"));
          return;
        }
        await spoke(agent, spoken).catch(fail("transcript"));
      },
    });
  };

  // Turns route one after another, so a route that never settles would stall every later turn and
  // hold a granted reply on the floor; past the limit the line is treated as meant for nobody.
  const routeOrGiveUp = (text: string, agents: AgentConfig[]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<string[]>((resolve) => {
      timer = setTimeout(() => {
        fail("route timeout")(
          new Error(`routing took longer than ${routeTimeoutMs} ms`)
        );
        resolve([]);
      }, routeTimeoutMs);
    });
    return Promise.race([deps.route(text, agents), timedOut]).finally(() =>
      clearTimeout(timer)
    );
  };

  const heard = async (person: VoicePerson, text: string) => {
    if (echo.isEcho(text, deps.nowMs())) {
      deps.onDrop?.(text);
      return;
    }
    await deps.writeLine(
      { kind: "human", id: person.id, name: person.name },
      { id: crypto.randomUUID(), text }
    );
    const agents = await deps.agents();
    for (const agentId of await routeOrGiveUp(text, agents)) {
      const agent = agents.find((each) => each.id === agentId);
      if (agent) {
        agentsSeen.set(agent.id, agent);
        pending.set(agent.id, [...(pending.get(agent.id) ?? []), text]);
        answer(agent);
      }
    }
  };

  const bargeIn = (words: string, voicedMs: number) => {
    const agentId = floor.speakingAgent();
    if (
      !agentId ||
      echo.isEcho(words, deps.nowMs()) ||
      !isBargeIn({ voicedMs, words })
    ) {
      return;
    }
    voices.get(agentId)?.then((voice) => voice.stop(), fail("barge-in"));
  };

  const leave = async (identity: string) => {
    present.delete(identity);
    clearTimeout(earRetries.get(identity));
    earRetries.delete(identity);
    earFailures.delete(identity);
    earCappedFailures.delete(identity);
    await joining.get(identity);
    const ear = ears.get(identity);
    ears.delete(identity);
    floor.personStopped(identity);
    await ear?.close();
  };

  // Someone who went without leaving; the host closes the room when they were the last.
  const letGo = (identity: string) =>
    void leave(identity)
      .catch(fail("ear"))
      .then(() => {
        if (!closed && present.size === 0) {
          deps.onEmpty?.();
        }
      });

  const open = async (person: VoicePerson): Promise<void> => {
    let opened: Ear;
    const isCurrent = () => ears.get(person.identity) === opened;
    const events: EarEvents = {
      onSpeechStart: () => floor.personStarted(person.identity),
      onSpeechStop: () => floor.personStopped(person.identity),
      onInterim: bargeIn,
      onTurn: (text) => {
        routed = routed.then(() => heard(person, text)).catch(fail("turn"));
      },
      onLost: () => {
        if (!isCurrent()) {
          return;
        }
        ears.delete(person.identity);
        floor.personStopped(person.identity);
        if (!closed) {
          void reopen(person);
        }
      },
      onGone: () => {
        if (isCurrent()) {
          letGo(person.identity);
        }
      },
    };
    try {
      opened = await deps.openEar(person, events);
    } catch (err) {
      fail("ear")(err);
      const failures = earFailures.get(person.identity) ?? 0;
      earFailures.set(person.identity, failures + 1);
      if (failures === 0) {
        void deps
          .notice?.(
            `I can't hear ${person.name} right now; their speech isn't being transcribed.`
          )
          .catch(fail("notice"));
      }
      if (closed || !present.has(person.identity)) {
        return;
      }
      const delayMs = Math.min(earRetryMaxMs, earRetryFirstMs * 2 ** failures);
      const capped =
        (earCappedFailures.get(person.identity) ?? 0) +
        (delayMs === earRetryMaxMs ? 1 : 0);
      earCappedFailures.set(person.identity, capped);
      // An ear that never opens cannot see its person leave, so after enough failures at the
      // slowest pace they are taken to be gone.
      if (capped >= earMaxFailures) {
        fail("ear gave up")(
          new Error(`no ear for ${person.identity} after ${failures + 1} tries`)
        );
        letGo(person.identity);
        return;
      }
      earRetries.set(
        person.identity,
        setTimeout(() => {
          earRetries.delete(person.identity);
          void reopen(person);
        }, delayMs)
      );
      return;
    }
    earFailures.delete(person.identity);
    earCappedFailures.delete(person.identity);
    if (closed || !present.has(person.identity)) {
      await opened.close().catch(fail("ear"));
      return;
    }
    ears.set(person.identity, opened);
  };

  const reopen = (person: VoicePerson) => {
    if (ears.has(person.identity) || joining.has(person.identity)) {
      return joining.get(person.identity) ?? Promise.resolve();
    }
    const attempt = open(person).finally(() => joining.delete(person.identity));
    joining.set(person.identity, attempt);
    return attempt;
  };

  return {
    async join(person: VoicePerson): Promise<void> {
      present.add(person.identity);
      await reopen(person);
    },
    leave,
    async close() {
      closed = true;
      present.clear();
      for (const timer of [...earRetries.values(), ...idleTimers.values()]) {
        clearTimeout(timer);
      }
      earRetries.clear();
      idleTimers.clear();
      for (const agentId of new Set([...agentsSeen.keys(), ...voices.keys()])) {
        floor.cancel(agentId);
      }
      await Promise.all(joining.values());
      await Promise.all([...ears.values()].map((ear) => ear.close()));
      await Promise.all(
        [...voices.values()].map((voice) =>
          voice.then(
            (each) => each.close(),
            () => {}
          )
        )
      );
      ears.clear();
      voices.clear();
    },
    isEmpty: () => present.size === 0,
  };
}

export type VoiceRoom = ReturnType<typeof createVoiceRoom>;
