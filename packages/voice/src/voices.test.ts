import { agentConfigSchema } from "@memo-air/agents";
import { describe, expect, it } from "vitest";

import { defaultVoices, voiceFor } from "./voices.ts";

const agent = (id: string, voice?: { id?: string; speed?: number }) =>
  agentConfigSchema.parse({ id, name: id, ...(voice ? { voice } : {}) });

describe("voiceFor", () => {
  it("gives every agent a different, stable voice, and keeps a chosen one", () => {
    const agents = [
      agent("assistant"),
      agent("market-researcher"),
      agent("analyst"),
    ];
    const catalog = defaultVoices.openai;
    const ids = agents.map((each) => voiceFor(each, agents, catalog).id);
    expect(new Set(ids).size).toBe(3);
    expect(voiceFor(agents[1], [...agents].reverse(), catalog).id).toBe(ids[1]);
    const chosen = agent("analyst", { id: "onyx", speed: 1.1 });
    expect(voiceFor(chosen, [agents[0], agents[1], chosen], catalog)).toEqual({
      id: "onyx",
      speed: 1.1,
    });
  });

  it("ignores a saved voice the provider does not offer and picks one it does", () => {
    const stale = agent("analyst", { id: "onyx" });
    const catalog = defaultVoices.elevenlabs;
    const picked = voiceFor(stale, [stale], catalog).id;
    expect(picked).not.toBe("onyx");
    expect(catalog.map((voice) => voice.id)).toContain(picked);
  });

  it("clamps speed into the natural range", () => {
    expect(
      voiceFor(agent("a", { speed: 3 }), [], defaultVoices.openai).speed
    ).toBe(1.2);
  });
});
