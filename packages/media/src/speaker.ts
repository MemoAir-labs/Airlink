import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";

// Speech engines are providers chosen per server (G5): the room code only asks for PCM.
export type TtsProvider = {
  synthesize(text: string): Promise<{ pcm: Int16Array; sampleRate: number }>;
};

export type MediaSpeaker = {
  speak(options: { url: string; token: string; text: string }): Promise<void>;
};

const openAiSampleRate = 24_000;

export function openAiTts({
  apiKey,
  voice = "alloy",
  model = "gpt-4o-mini-tts",
}: {
  apiKey: string;
  voice?: string;
  model?: string;
}): TtsProvider {
  return {
    async synthesize(text) {
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          voice,
          input: text,
          response_format: "pcm",
        }),
      });
      if (!response.ok) {
        throw new Error(`tts: ${response.status} ${await response.text()}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const samples = bytes.byteLength >> 1;
      const pcm = new Int16Array(samples);
      const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
      for (let i = 0; i < samples; i++) {
        pcm[i] = view.getInt16(i * 2, true);
      }
      return { pcm, sampleRate: openAiSampleRate };
    },
  };
}

const frameMs = 10;

// Joins the room as the agent for the length of one utterance, plays the PCM through a
// microphone track, and leaves. Each utterance is its own short participant session, so a
// crashed synthesis never leaves a silent ghost in the room.
export function liveKitSpeaker({ tts }: { tts: TtsProvider }): MediaSpeaker {
  return {
    async speak({ url, token, text }) {
      const { pcm, sampleRate } = await tts.synthesize(text);
      const room = new Room();
      await room.connect(url, token, { autoSubscribe: false, dynacast: false });
      const source = new AudioSource(sampleRate, 1);
      try {
        const track = LocalAudioTrack.createAudioTrack("speech", source);
        const options = new TrackPublishOptions({
          source: TrackSource.SOURCE_MICROPHONE,
        });
        const participant = room.localParticipant;
        if (!participant) {
          throw new Error("media: no local participant");
        }
        const publication = await participant.publishTrack(track, options);
        const samplesPerFrame = (sampleRate * frameMs) / 1000;
        for (let offset = 0; offset < pcm.length; offset += samplesPerFrame) {
          // A copy, not a subarray: AudioFrame reads from the start of the underlying buffer.
          const chunk = pcm.slice(offset, offset + samplesPerFrame);
          const frame = new AudioFrame(chunk, sampleRate, 1, chunk.length);
          await source.captureFrame(frame);
        }
        await source.waitForPlayout();
        await participant.unpublishTrack(publication.sid ?? "");
      } finally {
        await source.close();
        await room.disconnect();
      }
    },
  };
}
