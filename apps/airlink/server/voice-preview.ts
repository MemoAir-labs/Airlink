import type { SpeechProviderId, VoiceKeys, VoiceOption } from "@memo-air/voice";
import { defaultVoices, speechProviderOf } from "@memo-air/voice";
import { z } from "zod";

const minSpeed = 0.8;
const maxSpeed = 1.2;
const previewText = "Hi, I'm here in the call. How can I help?";
const pcmBytesPerSample = 2;
const elevenLabsSampleRate = 16_000;
// OpenAI always sends 24 kHz; Cartesia and Deepgram are asked for the same.
const pcmSampleRate = 24_000;
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

const cartesiaVersion = "2025-04-16";

const requestSpeech = (
  provider: SpeechProviderId,
  keys: VoiceKeys,
  voiceId: string,
  speed: number
) => {
  switch (provider) {
    case "elevenlabs":
      return fetch(
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
      );
    case "cartesia":
      return fetch("https://api.cartesia.ai/tts/bytes", {
        method: "POST",
        headers: {
          "X-API-Key": keys.cartesia ?? "",
          "Cartesia-Version": cartesiaVersion,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_id: "sonic-3",
          transcript: previewText,
          voice: { mode: "id", id: voiceId },
          output_format: {
            container: "raw",
            encoding: "pcm_s16le",
            sample_rate: pcmSampleRate,
          },
          generation_config: { speed },
        }),
      });
    case "deepgram":
      return fetch(
        `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voiceId)}&encoding=linear16&container=none&sample_rate=${pcmSampleRate}&speed=${speed}`,
        {
          method: "POST",
          headers: {
            Authorization: `Token ${keys.deepgram ?? ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text: previewText }),
        }
      );
    case "openai":
      return fetch("https://api.openai.com/v1/audio/speech", {
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
  }
};

const speak = async (
  provider: SpeechProviderId,
  keys: VoiceKeys,
  voiceId: string,
  speed: number
) => {
  const response = await requestSpeech(provider, keys, voiceId, speed);
  if (!response.ok) {
    throw new Error(`${provider} speech preview failed: ${response.status}`);
  }
  return wavOf(
    Buffer.from(await response.arrayBuffer()),
    provider === "elevenlabs" ? elevenLabsSampleRate : pcmSampleRate
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

// Cartesia pages its voice list; the first page is plenty to pick from.
const cartesiaVoices = async (apiKey: string): Promise<VoiceOption[]> => {
  try {
    const response = await fetch("https://api.cartesia.ai/voices?limit=100", {
      headers: { "X-API-Key": apiKey, "Cartesia-Version": cartesiaVersion },
    });
    const voice = z.object({ id: z.string(), name: z.string() });
    const parsed = z
      .union([z.object({ data: z.array(voice) }), z.array(voice)])
      .parse(await response.json());
    const voices = Array.isArray(parsed) ? parsed : parsed.data;
    return voices.length
      ? voices.map(({ id, name }) => ({ id, name }))
      : defaultVoices.cartesia;
  } catch {
    return defaultVoices.cartesia;
  }
};

export const voicesFor = async (
  keys: VoiceKeys
): Promise<{ provider: SpeechProviderId | null; voices: VoiceOption[] }> => {
  const provider = speechProviderOf(keys);
  switch (provider) {
    case null:
      return { provider: null, voices: [] };
    case "elevenlabs":
      return {
        provider,
        voices: await elevenLabsVoices(keys.elevenlabs ?? ""),
      };
    case "cartesia":
      return { provider, voices: await cartesiaVoices(keys.cartesia ?? "") };
    case "deepgram":
    case "openai":
      return { provider, voices: defaultVoices[provider] };
  }
};
