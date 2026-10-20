import { AudioStream, Room, RoomEvent } from "@livekit/rtc-node";
import { afterAll, describe, expect, it } from "vitest";

import { createMediaTokens } from "./server.ts";
import type { TtsProvider } from "./speaker.ts";
import { liveKitSpeaker, openAiTts } from "./speaker.ts";

const url = process.env.LIVEKIT_URL;
const apiKey = process.env.LIVEKIT_API_KEY ?? "devkey";
const apiSecret = process.env.LIVEKIT_API_SECRET ?? "secret";
const openAiApiKey = process.env.OPENAI_API_KEY;

const sampleRate = 24_000;
const toneSeconds = 1;

const leadInSamples = sampleRate / 10;

// A stand-in voice: one second of a 440 Hz tone after 100 ms of silence, so the server-side
// speech path is exercised against a real LiveKit server without a vendor key. The silent lead-in
// makes a speaker that replays its first frame stay silent instead of passing.
const toneTts: TtsProvider = {
  async synthesize() {
    const pcm = new Int16Array(sampleRate * toneSeconds);
    for (let i = leadInSamples; i < pcm.length; i++) {
      pcm[i] = Math.round(
        Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12_000
      );
    }
    return { pcm, sampleRate };
  },
};

describe.skipIf(!url)("livekit media plane", () => {
  const listeners: Room[] = [];

  afterAll(async () => {
    await Promise.all(listeners.map((listener) => listener.disconnect()));
  });

  const hearSpeech = async (tts: TtsProvider) => {
    const listener = new Room();
    listeners.push(listener);
    const tokens = createMediaTokens({ apiKey, apiSecret });
    const room = `test:${crypto.randomUUID()}`;
    const hana = { kind: "human" as const, id: "user:hana", name: "Hana" };
    const juno = { kind: "agent" as const, id: "agent:juno", name: "Juno" };

    let samples = 0;
    let loudest = 0;
    let speakerIdentity = "";
    let heardSampleRate = 0;
    const heard = new Promise<void>((resolve) => {
      listener.on(
        RoomEvent.TrackSubscribed,
        (track, _publication, participant) => {
          speakerIdentity = participant.identity;
          const reader = new AudioStream(track).getReader();
          const pump = async () => {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) {
                return;
              }
              heardSampleRate = value.sampleRate;
              samples += value.samplesPerChannel;
              for (const sample of value.data) {
                loudest = Math.max(loudest, Math.abs(sample));
              }
              // Real voices open with a quiet lead-in, so listen until speech is audible.
              if (samples >= heardSampleRate / 2 && loudest > 1000) {
                resolve();
                return;
              }
            }
          };
          void pump();
        }
      );
    });

    await listener.connect(
      url ?? "",
      await tokens.mint({
        room,
        actor: hana,
        canPublish: false,
        canSubscribe: true,
      })
    );
    const speaker = liveKitSpeaker({ tts });
    await speaker.speak({
      url: url ?? "",
      token: await tokens.mint({
        room,
        actor: juno,
        canPublish: true,
        canSubscribe: false,
      }),
      text: "Hello Hana, I have finished the draft.",
    });
    await Promise.race([
      heard,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("no audio heard")), 15_000)
      ),
    ]);
    return { speakerIdentity, samples, loudest, heardSampleRate };
  };

  it("publishes an agent's speech into the room and a listener hears it", async () => {
    const result = await hearSpeech(toneTts);
    expect(result.speakerIdentity).toBe("agent:juno");
    expect(result.samples).toBeGreaterThanOrEqual(result.heardSampleRate / 2);
    expect(result.loudest).toBeGreaterThan(1000);
  }, 30_000);

  it.skipIf(!openAiApiKey)(
    "speaks with a real OpenAI voice",
    async () => {
      const result = await hearSpeech(
        openAiTts({ apiKey: openAiApiKey ?? "" })
      );
      expect(result.speakerIdentity).toBe("agent:juno");
      expect(result.samples).toBeGreaterThanOrEqual(result.heardSampleRate / 2);
      expect(result.loudest).toBeGreaterThan(1000);
    },
    30_000
  );
});
