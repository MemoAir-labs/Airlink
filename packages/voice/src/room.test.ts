import { agentConfigSchema } from "@memo-air/agents";
import { describe, expect, it, vi } from "vitest";

import { createFloor, newsSilenceMs } from "./floor.ts";
import type { EarEvents, VoiceRoomDeps } from "./room.ts";
import {
  createVoiceRoom,
  earMaxFailures,
  maxTurnMs,
  routeTimeoutMs,
  voiceIdleMs,
} from "./room.ts";

const juno = agentConfigSchema.parse({ id: "juno", name: "Juno" });
const mira = agentConfigSchema.parse({ id: "mira", name: "Mira" });
const hanaPerson = { id: "hana", name: "Hana", identity: "user:hana" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const fakeClock = () => {
  let nowMs = 0;
  let timers: { atMs: number; run: () => void }[] = [];
  return {
    nowMs: () => nowMs,
    after: (ms: number, run: () => void) => {
      const timer = { atMs: nowMs + ms, run };
      timers = [...timers, timer];
      return () => {
        timers = timers.filter((each) => each !== timer);
      };
    },
    advance(ms: number) {
      nowMs += ms;
      const due = timers.filter((each) => each.atMs <= nowMs);
      timers = timers.filter((each) => each.atMs > nowMs);
      for (const timer of due) {
        timer.run();
      }
    },
  };
};

const setup = (
  route: (text: string) => string[],
  options: {
    work?: VoiceRoomDeps["work"];
    reportFails?: boolean;
    clock?: ReturnType<typeof fakeClock>;
  } = {}
) => {
  const ears = new Map<string, EarEvents>();
  const lines: { actor: string; text: string; cut?: boolean }[] = [];
  const spoken: string[] = [];
  const chat: string[] = [];
  const stopped: string[] = [];
  const errors: string[] = [];
  const closedEars: string[] = [];
  const closedVoices: string[] = [];
  let finishSpeech: (cut: boolean) => void = () => {};
  let workDone: (result: string) => void = () => {};
  const deps: VoiceRoomDeps = {
    openEar: async (person, events) => {
      ears.set(person.identity, events);
      return {
        close: async () => {
          closedEars.push(person.identity);
        },
      };
    },
    openVoice: async (agent, hooks) => ({
      reply: (turn) => {
        spoken.push(`${agent.id}: ${turn}`);
        hooks.said(`answer from ${agent.id}`);
        if (turn.includes("pull")) {
          void hooks.work("pull Q3");
        }
        return new Promise((resolve) => {
          finishSpeech = (cut) =>
            resolve({ said: `answer from ${agent.id}`, cut });
        });
      },
      report: async (result) => {
        if (options.reportFails) {
          throw new Error("tts down");
        }
        spoken.push(`${agent.id} reports: ${result}`);
        return { said: result, cut: false };
      },
      stop: () => {
        stopped.push(agent.id);
        finishSpeech(true);
      },
      close: async () => {
        closedVoices.push(agent.id);
      },
    }),
    agents: async () => [juno, mira],
    route: async (text) => route(text),
    work:
      options.work ??
      (() =>
        new Promise((resolve) => {
          workDone = resolve;
        })),
    postToChat: async (agent, text) => {
      chat.push(`${agent.id}: ${text}`);
    },
    writeLine: async (actor, line) => {
      lines.push({ actor: actor.id, text: line.text, cut: line.cut });
    },
    nowMs: () => Date.now(),
    onError: (_err, where) => {
      errors.push(where);
    },
  };
  const room = createVoiceRoom(deps, createFloor(options.clock));
  return {
    deps,
    room,
    ears,
    closedEars,
    closedVoices,
    lines,
    spoken,
    chat,
    stopped,
    errors,
    finish: (cut = false) => finishSpeech(cut),
    finishWork: (result: string) => workDone(result),
  };
};

describe("voice room", () => {
  it("answers a turn meant for an agent, writes both lines, and stays quiet otherwise", async () => {
    const t = setup((text) => (text.includes("Juno") ? ["juno"] : []));
    await t.room.join(hanaPerson);
    const hana = t.ears.get("user:hana");
    hana?.onSpeechStart();
    hana?.onTurn("Mira and I will sync later");
    hana?.onSpeechStop();
    await settle();
    expect(t.spoken).toEqual([]);
    hana?.onSpeechStart();
    hana?.onTurn("Juno, what did Q3 close at?");
    hana?.onSpeechStop();
    await settle();
    expect(t.spoken).toEqual(["juno: Juno, what did Q3 close at?"]);
    t.finish();
    await settle();
    expect(t.lines.map((l) => l.actor)).toEqual(["hana", "hana", "juno"]);
  });

  it("stops a speaking agent for a real interruption, not a backchannel, and marks the cut", async () => {
    const t = setup(() => ["juno"]);
    await t.room.join(hanaPerson);
    const hana = t.ears.get("user:hana");
    hana?.onTurn("Juno, read me the numbers");
    hana?.onSpeechStop();
    await settle();
    hana?.onSpeechStart();
    hana?.onInterim("mm-hm", 600);
    await settle();
    expect(t.stopped).toEqual([]);
    hana?.onInterim("wait, wrong quarter", 600);
    await settle();
    expect(t.stopped).toEqual(["juno"]);
    await settle();
    expect(t.lines.at(-1)).toMatchObject({ actor: "juno", cut: true });
  });

  it("queues two named agents and drops a line that is the agent's own echo", async () => {
    const t = setup(() => ["juno", "mira"]);
    await t.room.join(hanaPerson);
    const hana = t.ears.get("user:hana");
    hana?.onTurn("Juno and Mira, thoughts?");
    hana?.onSpeechStop();
    await settle();
    expect(t.spoken).toEqual(["juno: Juno and Mira, thoughts?"]);
    t.finish();
    await settle();
    expect(t.spoken.at(-1)?.startsWith("mira:")).toBe(true);
    hana?.onTurn("answer from mira");
    await settle();
    expect(
      t.lines.filter((l) => l.actor === "hana").map((l) => l.text)
    ).toEqual(["Juno and Mira, thoughts?"]);
  });

  it("treats what a voice is saying as echo while it speaks: no line, no route, no barge-in", async () => {
    const t = setup(() => ["juno"]);
    await t.room.join(hanaPerson);
    const hana = t.ears.get("user:hana");
    hana?.onTurn("Juno, how did Q3 go?");
    hana?.onSpeechStop();
    await settle();
    expect(t.spoken).toEqual(["juno: Juno, how did Q3 go?"]);
    hana?.onInterim("answer from juno", 600);
    await settle();
    expect(t.stopped).toEqual([]);
    hana?.onTurn("answer from juno");
    await settle();
    expect(t.lines.map((l) => l.text)).toEqual(["Juno, how did Q3 go?"]);
    expect(t.spoken).toEqual(["juno: Juno, how did Q3 go?"]);
  });

  it("answers both sentences once when a second arrives before the agent speaks", async () => {
    const t = setup(() => ["juno"]);
    await t.room.join(hanaPerson);
    const hana = t.ears.get("user:hana");
    hana?.onSpeechStart();
    hana?.onTurn("Hello, can you hear me?");
    hana?.onTurn("Juno, can you hear me?");
    await settle();
    hana?.onSpeechStop();
    await settle();
    expect(t.spoken).toEqual([
      "juno: Hello, can you hear me? Juno, can you hear me?",
    ]);
  });

  it("answers once, in order, when an unnamed turn routes slower than the named one after it", async () => {
    let routeFirst: (ids: string[]) => void = () => {};
    const t = setup(() => []);
    const room = createVoiceRoom({
      ...t.deps,
      route: (text) =>
        text.includes("Juno")
          ? Promise.resolve(["juno"])
          : new Promise((resolve) => {
              routeFirst = resolve;
            }),
    });
    await room.join(hanaPerson);
    const hana = t.ears.get("user:hana");
    hana?.onSpeechStart();
    hana?.onTurn("Hello, can you hear me?");
    hana?.onTurn("Hi Juno, are you there?");
    hana?.onSpeechStop();
    await settle();
    routeFirst(["juno"]);
    await settle();
    await settle();
    t.finish();
    await settle();
    await settle();
    expect(t.spoken).toEqual([
      "juno: Hello, can you hear me? Hi Juno, are you there?",
    ]);
  });

  it("lets a person go when their tab vanishes, and tells the host the room is empty", async () => {
    let emptied = 0;
    const t = setup(() => []);
    const room = createVoiceRoom({
      ...t.deps,
      onEmpty: () => {
        emptied += 1;
      },
    });
    await room.join(hanaPerson);
    t.ears.get("user:hana")?.onGone();
    await settle();
    expect(t.closedEars).toEqual(["user:hana"]);
    expect(room.isEmpty()).toBe(true);
    expect(emptied).toBe(1);
  });

  it("drops a voice that has been quiet past the idle limit", async () => {
    vi.useFakeTimers();
    try {
      const t = setup(() => ["juno"]);
      await t.room.join(hanaPerson);
      const hana = t.ears.get("user:hana");
      hana?.onTurn("Juno, hello");
      hana?.onSpeechStop();
      await vi.advanceTimersByTimeAsync(0);
      t.finish();
      await vi.advanceTimersByTimeAsync(voiceIdleMs);
      expect(t.closedVoices).toEqual(["juno"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a voice whose turn overruns, so the floor moves on", async () => {
    vi.useFakeTimers();
    try {
      const t = setup(() => ["juno", "mira"]);
      await t.room.join(hanaPerson);
      const hana = t.ears.get("user:hana");
      hana?.onTurn("Juno and Mira, go");
      hana?.onSpeechStop();
      await vi.advanceTimersByTimeAsync(maxTurnMs);
      expect(t.errors).toContain("floor");
      expect(t.closedVoices).toContain("juno");
      expect(t.spoken.at(-1)?.startsWith("mira:")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed ear with backoff and tells the chat once that the person is unheard", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const notices: string[] = [];
      const t = setup(() => []);
      const room = createVoiceRoom({
        ...t.deps,
        openEar: async () => {
          attempts += 1;
          throw new Error("stt down");
        },
        notice: async (text) => {
          notices.push(text);
        },
      });
      await room.join(hanaPerson);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(3);
      expect(notices).toEqual([
        "I can't hear Hana right now; their speech isn't being transcribed.",
      ]);
      await room.leave("user:hana");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a route that never settles, so the next turn and a waiting reply move on", async () => {
    vi.useFakeTimers();
    try {
      const t = setup(() => []);
      const room = createVoiceRoom({
        ...t.deps,
        route: (text) =>
          text.includes("stuck")
            ? new Promise(() => {})
            : Promise.resolve(["juno"]),
      });
      await room.join(hanaPerson);
      const hana = t.ears.get("user:hana");
      hana?.onTurn("Juno, first question");
      hana?.onTurn("this one is stuck");
      hana?.onTurn("Juno, second question");
      hana?.onSpeechStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.spoken).toEqual([]);
      await vi.advanceTimersByTimeAsync(routeTimeoutMs);
      expect(t.errors).toEqual(["route timeout"]);
      expect(t.spoken).toEqual([
        "juno: Juno, first question Juno, second question",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes a person whose ear never opens to be gone after enough failures at the slowest pace", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let emptied = 0;
      const t = setup(() => []);
      const room = createVoiceRoom({
        ...t.deps,
        openEar: async () => {
          attempts += 1;
          throw new Error("stt down");
        },
        onEmpty: () => {
          emptied += 1;
        },
      });
      await room.join(hanaPerson);
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 16_000);
      await vi.advanceTimersByTimeAsync(30_000 * (earMaxFailures - 1));
      expect(attempts).toBe(5 + earMaxFailures);
      expect(t.errors.filter((where) => where === "ear gave up")).toEqual([
        "ear gave up",
      ]);
      expect(room.isEmpty()).toBe(true);
      expect(emptied).toBe(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(attempts).toBe(5 + earMaxFailures);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reopens a lost ear, and lets the harness answer in chat when the voice fails", async () => {
    const chat: string[] = [];
    let opened = 0;
    const opens: EarEvents[] = [];
    const room = createVoiceRoom(
      {
        openEar: async (_person, events) => {
          opened += 1;
          opens.push(events);
          if (opened === 1) {
            setTimeout(() => events.onLost(), 0);
          }
          return { close: async () => {} };
        },
        openVoice: async () => {
          throw new Error("tts down");
        },
        agents: async () => [juno],
        route: async () => ["juno"],
        work: async (_agent, task) => {
          chat.push(`work: ${task}`);
          return "ok";
        },
        postToChat: async () => {},
        writeLine: async () => {},
        nowMs: () => Date.now(),
      },
      createFloor()
    );
    await room.join(hanaPerson);
    await settle();
    await settle();
    expect(opened).toBe(2);
    opens.at(-1)?.onTurn("Juno, two plus two?");
    opens.at(-1)?.onSpeechStop();
    await settle();
    await settle();
    expect(chat).toEqual(["work: Juno, two plus two?"]);
  });

  it("reports a failed work run and tells the chat the agent stopped", async () => {
    const t = setup(() => ["juno"], {
      work: async () => Promise.reject(new Error("harness down")),
    });
    await t.room.join(hanaPerson);
    const hana = t.ears.get("user:hana");
    hana?.onTurn("Juno, pull the Q3 sheet");
    hana?.onSpeechStop();
    await settle();
    await settle();
    expect(t.errors).toEqual(["work"]);
    expect(t.chat).toEqual(["juno: Juno stopped before finishing."]);
  });

  it("leaves finished work to the harness's own chat post when the voice cannot report it", async () => {
    const clock = fakeClock();
    const t = setup(() => ["juno"], { reportFails: true, clock });
    await t.room.join(hanaPerson);
    const hana = t.ears.get("user:hana");
    hana?.onTurn("Juno, pull the Q3 sheet");
    hana?.onSpeechStop();
    await settle();
    t.finish();
    await settle();
    t.finishWork("Q3 is in the sheet.");
    await settle();
    clock.advance(newsSilenceMs);
    await settle();
    expect(t.errors).toEqual(["news"]);
    expect(t.chat).toEqual([]);
  });

  it("speaks no news once the call has ended; the harness posted the result", async () => {
    const t = setup(() => ["juno"]);
    await t.room.join(hanaPerson);
    const hana = t.ears.get("user:hana");
    hana?.onTurn("Juno, pull the Q3 sheet");
    hana?.onSpeechStop();
    await settle();
    t.finish();
    await settle();
    await t.room.leave("user:hana");
    await t.room.close();
    t.finishWork("Q3 is in the sheet.");
    await settle();
    expect(t.chat).toEqual([]);
    expect(t.spoken.some((s) => s.includes("reports"))).toBe(false);
  });

  it("cancels queued requests on close, so a waiting agent never speaks", async () => {
    const t = setup(() => ["juno"]);
    await t.room.join(hanaPerson);
    const hana = t.ears.get("user:hana");
    hana?.onSpeechStart();
    hana?.onTurn("Juno, what did Q3 close at?");
    await settle();
    await t.room.close();
    hana?.onSpeechStop();
    await settle();
    expect(t.spoken).toEqual([]);
  });
});
