import type { SpeechProviderId, VoiceKeys, VoiceOption } from "@memo-air/voice";
import { defaultVoices, speechProviderOf } from "@memo-air/voice";
import { z } from "zod";

const minSpeed = 0.8;
const maxSpeed = 1.2;
const previewText = "Hi, I'm here in the call. How can I help?";
const pcmBytesPerSample = 2;
const elevenLabsSampleRate = 16_000;
const openAiSampleRate = 24_000;
const openAiVoiceIds = new Set(defaultVoices.openai.map((voice) => voice.id));

const wavOf = (pcm: Buffer, sampleRate: number) => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * pcmBytesPerSample, 28);
  header.writeUInt16LE(pcmBytesPerSample, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

const speak = async (
  provider: SpeechProviderId,
  keys: VoiceKeys,
  voiceId: string,
  speed: number
) => {
  const response =
    provider === "elevenlabs"
      ? await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_16000`,
          {
            method: "POST",
            headers: {
              "xi-api-key": keys.elevenlabs ?? "",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text: previewText,
              model_id: "eleven_flash_v2_5",
              voice_settings: { speed },
            }),
          }
        )
      : await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${keys.openai ?? ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini-tts",
            input: previewText,
            voice: openAiVoiceIds.has(voiceId) ? voiceId : "coral",
            speed,
            response_format: "pcm",
          }),
        });
  if (!response.ok) {
    throw new Error(`${provider} speech preview failed: ${response.status}`);
  }
  return wavOf(
    Buffer.from(await response.arrayBuffer()),
    provider === "elevenlabs" ? elevenLabsSampleRate : openAiSampleRate
  );
};

export const previewVoice = async (
  keys: VoiceKeys,
  voiceId: string,
  speed: number
) => {
  const provider = speechProviderOf(keys);
  return provider
    ? speak(
        provider,
        keys,
        voiceId,
        Math.min(maxSpeed, Math.max(minSpeed, speed))
      )
    : null;
};

const elevenLabsVoices = async (apiKey: string): Promise<VoiceOption[]> => {
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
    });
    const { voices } = z
      .object({
        voices: z.array(z.object({ voice_id: z.string(), name: z.string() })),
      })
      .parse(await response.json());
    return voices.length
      ? voices.map((voice) => ({ id: voice.voice_id, name: voice.name }))
      : defaultVoices.elevenlabs;
  } catch {
    return defaultVoices.elevenlabs;
  }
};

export const voicesFor = async (
  keys: VoiceKeys
): Promise<{ provider: SpeechProviderId | null; voices: VoiceOption[] }> => {
  const provider = speechProviderOf(keys);
  if (!provider) {
    return { provider: null, voices: [] };
  }
  if (provider === "elevenlabs") {
    return { provider, voices: await elevenLabsVoices(keys.elevenlabs ?? "") };
  }
  return { provider, voices: defaultVoices.openai };
};
