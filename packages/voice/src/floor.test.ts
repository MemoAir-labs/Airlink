import { describe, expect, it } from "vitest";

import { createFloor, newsSilenceMs } from "./floor.ts";

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

const speaker = () => {
  let finish = () => {};
  const started: string[] = [];
  return {
    started,
    speak: (id: string) => () => {
      started.push(id);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    finish: async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
};

describe("floor", () => {
  it("gives agents the floor one at a time, in order, and only between people", async () => {
    const floor = createFloor(fakeClock());
    const s = speaker();
    floor.personStarted("hana");
    floor.request({ agentId: "juno", kind: "reply", speak: s.speak("juno") });
    floor.request({ agentId: "mira", kind: "reply", speak: s.speak("mira") });
    expect(s.started).toEqual([]);
    floor.personStopped("hana");
    expect(s.started).toEqual(["juno"]);
    expect(floor.speakingAgent()).toBe("juno");
    await s.finish();
    expect(s.started).toEqual(["juno", "mira"]);
  });

  it("lets a newer request replace an agent's pending one", () => {
    const floor = createFloor(fakeClock());
    const s = speaker();
    floor.personStarted("hana");
    floor.request({ agentId: "juno", kind: "reply", speak: s.speak("first") });
    floor.request({ agentId: "juno", kind: "reply", speak: s.speak("second") });
    floor.personStopped("hana");
    expect(s.started).toEqual(["second"]);
  });

  it("keys requests by agent and kind: news and a reply both run, a newer reply replaces only the reply", async () => {
    const clock = fakeClock();
    const floor = createFloor(clock);
    const s = speaker();
    floor.personStarted("hana");
    floor.request({ agentId: "juno", kind: "news", speak: s.speak("news") });
    floor.request({
      agentId: "juno",
      kind: "reply",
      speak: s.speak("old reply"),
    });
    floor.request({
      agentId: "juno",
      kind: "reply",
      speak: s.speak("new reply"),
    });
    floor.personStopped("hana");
    clock.advance(newsSilenceMs);
    expect(s.started).toEqual(["news"]);
    await s.finish();
    expect(s.started).toEqual(["news", "new reply"]);
    await s.finish();
    expect(s.started).toEqual(["news", "new reply"]);
  });

  it("holds news until the room has been quiet for a moment", () => {
    const clock = fakeClock();
    const floor = createFloor(clock);
    const s = speaker();
    floor.personStarted("hana");
    floor.personStopped("hana");
    floor.request({ agentId: "juno", kind: "news", speak: s.speak("news") });
    expect(s.started).toEqual([]);
    clock.advance(newsSilenceMs);
    expect(s.started).toEqual(["news"]);
  });

  it("drops a cancelled agent's pending requests of both kinds", () => {
    const clock = fakeClock();
    const floor = createFloor(clock);
    const s = speaker();
    floor.personStarted("hana");
    floor.request({ agentId: "juno", kind: "reply", speak: s.speak("juno") });
    floor.request({ agentId: "juno", kind: "news", speak: s.speak("news") });
    floor.cancel("juno");
    floor.personStopped("hana");
    clock.advance(newsSilenceMs);
    expect(s.started).toEqual([]);
  });

  it("frees the floor when a speaker fails", async () => {
    const floor = createFloor(fakeClock());
    const s = speaker();
    floor.request({
      agentId: "juno",
      kind: "reply",
      speak: () => Promise.reject(new Error("tts down")),
    });
    floor.request({ agentId: "mira", kind: "reply", speak: s.speak("mira") });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.started).toEqual(["mira"]);
  });
});
