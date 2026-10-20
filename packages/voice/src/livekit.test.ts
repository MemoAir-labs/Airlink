import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as openai from "@livekit/agents-plugin-openai";
import type { AudioFrame } from "@livekit/rtc-node";
import {
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import { agentConfigSchema } from "@memo-air/agents";
import { createMediaTokens } from "@memo-air/media/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { VoiceActor } from "./index.ts";
import { createVoice } from "./index.ts";
import {
  canTalk,
  createDepartureWatch,
  reconnectGraceMs,
  speechProviderOf,
} from "./livekit.ts";

describe("speech provider and talker", () => {
  const keys = (
    elevenlabsKey: string | null,
    openaiKey: string | null,
    anthropicKey: string | null
  ) => ({
    elevenlabs: elevenlabsKey,
    openai: openaiKey,
    anthropic: anthropicKey,
  });

  it("prefers ElevenLabs for speech, falls back to OpenAI, and has none without either", () => {
    expect(speechProviderOf(keys("el", "oa", null))).toBe("elevenlabs");
    expect(speechProviderOf(keys("el", null, null))).toBe("elevenlabs");
    expect(speechProviderOf(keys(null, "oa", "an"))).toBe("openai");
    expect(speechProviderOf(keys(null, null, "an"))).toBe(null);
  });

  it("talks only with a supported provider whose key is set", () => {
    expect(canTalk("anthropic/claude-haiku-4-5", keys(null, null, "an"))).toBe(
      true
    );
    expect(canTalk("anthropic/claude-haiku-4-5", keys(null, "oa", null))).toBe(
      false
    );
    expect(canTalk("anthropic/claude-haiku-4-5", keys(null, null, ""))).toBe(
      false
    );
    expect(canTalk("openai/gpt-4.1-mini", keys(null, "oa", null))).toBe(true);
    expect(canTalk("openai/gpt-4.1-mini", keys("el", null, "an"))).toBe(false);
    expect(canTalk("google/gemini-2.5-flash", keys("el", "oa", "an"))).toBe(
      false
    );
    expect(canTalk("gpt-4.1-mini", keys("el", "oa", "an"))).toBe(false);
  });
});

describe("departure watch", () => {
  const watch = () => {
    let gone = 0;
    const departure = createDepartureWatch<{ sid: string }>(() => {
      gone += 1;
    });
    return { departure, gone: () => gone };
  };

  it("lets a person go only when no reconnect follows within the grace", () => {
    vi.useFakeTimers();
    try {
      const old = { sid: "old" };
      const t = watch();
      t.departure.connected(old);
      t.departure.disconnected(old);
      vi.advanceTimersByTime(reconnectGraceMs - 1);
      t.departure.connected({ sid: "new" });
      vi.advanceTimersByTime(reconnectGraceMs);
      expect(t.gone()).toBe(0);
      const other = watch();
      other.departure.connected(old);
      other.departure.disconnected(old);
      vi.advanceTimersByTime(reconnectGraceMs);
      expect(other.gone()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores the old participant's disconnect arriving after the new one connected, and stops on close", () => {
    vi.useFakeTimers();
    try {
      const t = watch();
      const old = { sid: "old" };
      const fresh = { sid: "new" };
      t.departure.connected(old);
      t.departure.connected(fresh);
      t.departure.disconnected(old);
      vi.advanceTimersByTime(reconnectGraceMs);
      expect(t.gone()).toBe(0);
      t.departure.disconnected(fresh);
      t.departure.stop();
      vi.advanceTimersByTime(reconnectGraceMs);
      expect(t.gone()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

const liveKitUrl = process.env.LIVEKIT_URL;
const liveKitApiKey = process.env.LIVEKIT_API_KEY;
const liveKitApiSecret = process.env.LIVEKIT_API_SECRET;
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY ?? null;
const openAiApiKey = process.env.OPENAI_API_KEY ?? null;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? null;
const canRun = Boolean(
  liveKitUrl &&
    liveKitApiKey &&
    liveKitApiSecret &&
    (elevenLabsApiKey || openAiApiKey)
);
const turnWaitMs = 8000;
const echoWaitMs = 4000;

const waitFor = async (check: () => boolean, timeoutMs: number) => {
  const deadlineMs = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadlineMs) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe.skipIf(!canRun)("ears and voices on a live LiveKit server", () => {
  const keys = {
    elevenlabs: elevenLabsApiKey,
    openai: openAiApiKey,
    anthropic: anthropicApiKey,
  };
  const tokens = createMediaTokens({
    apiKey: liveKitApiKey ?? "",
    apiSecret: liveKitApiSecret ?? "",
  });
  const juno = agentConfigSchema.parse({ id: "juno", name: "Juno" });
  const rooms: Room[] = [];
  const services: ReturnType<typeof createVoice>[] = [];
  let question: AudioFrame[] = [];

  beforeAll(async () => {
    const tts = elevenLabsApiKey
      ? new elevenlabs.TTS({ apiKey: elevenLabsApiKey })
      : new openai.TTS({ apiKey: openAiApiKey ?? "" });
    for await (const audio of tts.synthesize("Juno, what is two plus two?")) {
      question = [...question, audio.frame];
    }
  }, 30_000);

  afterAll(async () => {
    await Promise.all(services.map((service) => service.close()));
    await Promise.all(rooms.map((room) => room.disconnect()));
  });

  const call = async () => {
    const callDoc = `test:${crypto.randomUUID()}`;
    const lines: { actor: string; text: string }[] = [];
    const service = createVoice(
      {
        liveKitUrl: liveKitUrl ?? "",
        mintToken: (grant, room) =>
          tokens.mint({
            room,
            actor: {
              kind: grant.identity.startsWith("agent:") ? "agent" : "human",
              id: grant.identity,
              name: grant.name,
            },
            canPublish: !grant.hidden,
            canSubscribe: grant.hidden,
            hidden: grant.hidden,
          }),
        keys: () => keys,
        talkerModel: () =>
          anthropicApiKey
            ? "anthropic/claude-haiku-4-5"
            : "openai/gpt-4.1-mini",
      },
      {
        agentsIn: async () => [juno],
        route: async () => ["juno"],
        work: async () => "Done.",
        postToChat: async () => {},
        writeLine: async (
          _callDoc: string,
          actor: VoiceActor,
          line: { text: string }
        ) => {
          lines.push({ actor: actor.id, text: line.text });
        },
        logger: { info() {}, error() {} },
      }
    );
    services.push(service);

    const human = new Room();
    rooms.push(human);
    const subscribed: string[] = [];
    const agentFrames: AudioFrame[] = [];
    human.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      subscribed.push(participant.identity);
      void (async () => {
        for await (const frame of new AudioStream(track)) {
          agentFrames.push(frame);
        }
      })();
    });
    await human.connect(
      liveKitUrl ?? "",
      await tokens.mint({
        room: callDoc,
        actor: { kind: "human", id: "user:hana", name: "Hana" },
        canPublish: true,
        canSubscribe: true,
      }),
      { autoSubscribe: true, dynacast: false }
    );
    const firstFrame = question[0];
    const source = new AudioSource(
      firstFrame?.sampleRate ?? 24_000,
      firstFrame?.channels ?? 1
    );
    await human.localParticipant?.publishTrack(
      LocalAudioTrack.createAudioTrack("mic", source),
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })
    );
    await service.join(callDoc, {
      id: "hana",
      name: "Hana",
      identity: "user:hana",
    });
    const play = async (frames: AudioFrame[]) => {
      for (const frame of frames) {
        await source.captureFrame(frame);
      }
    };
    return { lines, subscribed, agentFrames, play };
  };

  it("hears a person's turn, answers it in the agent's own voice and writes both lines", async () => {
    const t = await call();
    await t.play(question);
    await waitFor(() => t.lines.some((l) => l.actor === "juno"), turnWaitMs);
    expect(
      t.lines.find((l) => l.actor === "hana")?.text.toLowerCase()
    ).toContain("two plus two");
    expect(t.subscribed).toContain("agent:juno");
  }, 30_000);

  it("does not take the agent's own voice leaking into the person's microphone for a new line", async () => {
    const t = await call();
    await t.play(question);
    await waitFor(() => t.agentFrames.length > 0, turnWaitMs);
    const hanaLines = t.lines.filter((l) => l.actor === "hana").length;
    await waitFor(() => t.lines.some((l) => l.actor === "juno"), turnWaitMs);
    await t.play([...t.agentFrames]);
    await new Promise((resolve) => setTimeout(resolve, echoWaitMs));
    expect(t.lines.filter((l) => l.actor === "hana").length).toBe(hanaLines);
  }, 40_000);
});
