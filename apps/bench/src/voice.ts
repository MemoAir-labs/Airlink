import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";

import { percentiles } from "./stats.ts";

// End of a person's spoken line → the agent's first audio, through a real LiveKit room.
//
// Setup: AirLink running with LiveKit and a speech key. The script asks AirLink for a media
// token the way a browser does, so AirLink's voice listens to the identity it gets back
// (`user:<id>:bench`); the call does not need to be open in a tab. --cookie is the value of the
// `airlink_person` cookie: copy it from a signed-in browser, or sign one with the local
// `.airlink/secret` as the dev scripts do. The person must be a member of --room.
//
// --wav is a 16 kHz mono 16-bit PCM WAV of a short line that names an agent, e.g.
//   say -o line.aiff "Juno, what is on my calendar today?" && \
//     ffmpeg -i line.aiff -ar 16000 -ac 1 -c:a pcm_s16le line.wav
// The end of the line is the last voiced frame played out (about a second of silence follows it,
// so endpointing hears real trailing silence). The timer stops at the first non-silent frame
// from any `agent:*` participant.
const { values: args } = parseArgs({
  options: {
    airlink: { type: "string", default: "http://localhost:3030" },
    cookie: { type: "string" },
    room: { type: "string" },
    wav: { type: "string" },
    samples: { type: "string", default: "20" },
    json: { type: "string" },
  },
});
if (!args.room || !args.cookie || !args.wav) {
  process.stderr.write("--room, --cookie and --wav are required\n");
  process.exit(1);
}
const sampleCount = Number(args.samples);
if (!Number.isInteger(sampleCount) || sampleCount < 1) {
  process.stderr.write("--samples must be a positive integer\n");
  process.exit(1);
}
const sampleRate = 16_000;
const frameSamples = sampleRate / 100;
const gapMs = 3000;
const replyTimeoutMs = 20_000;
const connectTimeoutMs = 10_000;
const trailingSilenceMs = 1000;
const agentQuietMs = 1500;
const audibleLevel = 200;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const readPcm = (path: string): Int16Array => {
  const wav = readFileSync(path);
  if (wav.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("--wav is not a RIFF/WAV file");
  }
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") {
      const channels = wav.readUInt16LE(at + 10);
      const rate = wav.readUInt32LE(at + 12);
      const bits = wav.readUInt16LE(at + 22);
      if (channels !== 1 || rate !== sampleRate || bits !== 16) {
        throw new Error("--wav must be 16 kHz mono 16-bit PCM");
      }
    }
    if (id === "data") {
      const bytes = wav.subarray(at + 8, at + 8 + size);
      return new Int16Array(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.length - (bytes.length % 2)
        )
      );
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("--wav has no data chunk");
};
const pcm = readPcm(args.wav);

const grantResponse = await fetch(
  `${args.airlink}/api/live/${encodeURIComponent(args.room)}/media-token`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `airlink_person=${args.cookie}`,
    },
    body: JSON.stringify({ viewer: "bench" }),
  }
);
if (!grantResponse.ok) {
  throw new Error(`media-token failed: ${grantResponse.status}`);
}
const grant: unknown = await grantResponse.json();
if (
  typeof grant !== "object" ||
  grant === null ||
  !("url" in grant) ||
  typeof grant.url !== "string" ||
  !("token" in grant) ||
  typeof grant.token !== "string"
) {
  throw new Error("media-token response has no url and token");
}

const room = new Room();
let heardAtMs = 0;
let armed = false;
let lastAgentAudioAtMs = 0;
const pumpAgent = async (stream: AudioStream) => {
  for await (const frame of stream) {
    let loudest = 0;
    for (const sample of frame.data) {
      loudest = Math.max(loudest, Math.abs(sample));
    }
    if (loudest <= audibleLevel) {
      continue;
    }
    lastAgentAudioAtMs = performance.now();
    if (armed && heardAtMs === 0) {
      heardAtMs = lastAgentAudioAtMs;
    }
  }
};
room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
  if (participant.identity.startsWith("agent:")) {
    void pumpAgent(new AudioStream(track));
  }
});
await Promise.race([
  room.connect(grant.url, grant.token, {
    autoSubscribe: true,
    dynacast: false,
  }),
  sleep(connectTimeoutMs).then(() => {
    throw new Error("timed out connecting to LiveKit");
  }),
]);

const source = new AudioSource(sampleRate, 1);
const local = room.localParticipant;
if (!local) {
  throw new Error("no local participant");
}
const shutdown = async () => {
  await source.close();
  await room.disconnect();
};
process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(130));
});

const pushFrames = async (samples: Int16Array) => {
  for (let offset = 0; offset < samples.length; offset += frameSamples) {
    // A copy, not a subarray: AudioFrame reads from the start of the underlying buffer.
    const chunk = samples.slice(offset, offset + frameSamples);
    await source.captureFrame(
      new AudioFrame(chunk, sampleRate, 1, chunk.length)
    );
  }
};
const silence = new Int16Array((sampleRate * trailingSilenceMs) / 1000);

const replyMs: number[] = [];
let misses = 0;
try {
  await local.publishTrack(
    LocalAudioTrack.createAudioTrack("bench-voice", source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })
  );
  for (let i = 0; i < sampleCount; i++) {
    heardAtMs = 0;
    armed = false;
    await pushFrames(pcm);
    // The last voiced frame has to be played out, not just queued, before the clock starts.
    await source.waitForPlayout();
    const endedAtMs = performance.now();
    armed = true;
    await pushFrames(silence);
    while (heardAtMs === 0 && performance.now() - endedAtMs < replyTimeoutMs) {
      await sleep(5);
    }
    if (heardAtMs === 0) {
      misses += 1;
    } else {
      replyMs.push(heardAtMs - endedAtMs);
    }
    armed = false;
    await sleep(gapMs);
    while (performance.now() - lastAgentAudioAtMs < agentQuietMs) {
      await sleep(100);
    }
  }
} finally {
  await shutdown();
}

const results = {
  room: args.room,
  samples: sampleCount,
  voice: { ...percentiles(replyMs), misses },
};
if (args.json) {
  writeFileSync(args.json, `${JSON.stringify(results, null, 2)}\n`);
}
process.stdout.write(
  [
    `Voice: end of a person's line → agent's first audio, ${sampleCount} samples in ${args.room}`,
    "",
    "| Measure (ms) | p50 | p95 | p99 | n |",
    "|---|---|---|---|---|",
    `| End of a person's line → agent's first audio | ${results.voice.p50} | ${results.voice.p95} | ${results.voice.p99} | ${results.voice.n}${misses ? ` (${misses} missed)` : ""} |`,
    "",
  ].join("\n")
);
process.exit(replyMs.length === 0 ? 1 : 0);
