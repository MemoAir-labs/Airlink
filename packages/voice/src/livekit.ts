import type { ReadableStream } from "node:stream/web";
import { TransformStream } from "node:stream/web";
import type { ipc } from "@livekit/agents";
import {
  InferenceRunner,
  inference,
  initializeLogger,
  llm,
  voice,
} from "@livekit/agents";
import * as anthropic from "@livekit/agents-plugin-anthropic";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as openai from "@livekit/agents-plugin-openai";
import type {
  RemoteParticipant,
  RemoteTrackPublication,
} from "@livekit/rtc-node";
import { Room, RoomEvent, TrackSource } from "@livekit/rtc-node";
import type { AgentConfig } from "@memo-air/agents";
import { agentIdentity } from "@memo-air/agents";
import { z } from "zod";

import type { Ear, EarEvents, Spoken, Voice, VoicePerson } from "./room.ts";
import type { SpeechProviderId } from "./voices.ts";

initializeLogger({ pretty: false, level: "warn" });

export type VoiceKeys = {
  elevenlabs: string | null;
  openai: string | null;
  anthropic: string | null;
};
export type OnError = (err: unknown, where: string) => void;

const elevenLabsSttModel = "scribe_v2_realtime";
const elevenLabsTtsModel = "eleven_flash_v2_5";
const openAiTtsModel = "gpt-4o-mini-tts";
const openAiSttModel = "gpt-4o-mini-transcribe";
const endpointingDelayMs = 700;
const endpointingMaxDelayMs = 2500;
const openAiVoices = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
] as const;
type OpenAiVoice = (typeof openAiVoices)[number];

const eotInferenceMethod = "lk_eot_audio";
const talkerProviders = ["anthropic", "openai"] as const;
type TalkerProvider = (typeof talkerProviders)[number];

const isTalkerProvider = (value: string): value is TalkerProvider =>
  talkerProviders.some((each) => each === value);
const isOpenAiVoice = (id: string): id is OpenAiVoice =>
  openAiVoices.some((each) => each === id);

export const speechProviderOf = (keys: VoiceKeys): SpeechProviderId | null =>
  keys.elevenlabs ? "elevenlabs" : keys.openai ? "openai" : null;

const spokenStyle = [
  "You are in a live voice call with people and other agents. Everything you write is spoken aloud.",
  "Talk like a warm, concise colleague: one to three short sentences, contractions, no lists, no markdown, no links.",
  "Say numbers the way people say them. If you were cut off, do not repeat yourself; pick up only if asked.",
  "For anything that needs live objects, files, the browser, or more than a quick answer, call `work` with the task, then say in one short sentence what you are doing.",
].join("\n");

const sttFor = (provider: SpeechProviderId, keys: VoiceKeys) =>
  provider === "elevenlabs"
    ? new elevenlabs.STT({
        apiKey: keys.elevenlabs ?? "",
        model: elevenLabsSttModel,
      })
    : new openai.STT({
        apiKey: keys.openai ?? "",
        model: openAiSttModel,
        useRealtime: true,
      });

const ttsFor = (
  provider: SpeechProviderId,
  keys: VoiceKeys,
  voiceId: string,
  speed: number,
  role: string
) =>
  provider === "elevenlabs"
    ? new elevenlabs.TTS({
        apiKey: keys.elevenlabs ?? "",
        voiceId,
        model: elevenLabsTtsModel,
        voiceSettings: {
          stability: 0.45,
          similarity_boost: 0.75,
          style: 0.25,
          speed,
          use_speaker_boost: true,
        },
      })
    : new openai.TTS({
        apiKey: keys.openai ?? "",
        model: openAiTtsModel,
        voice: isOpenAiVoice(voiceId) ? voiceId : "coral",
        speed,
        instructions: `Speak naturally, like a warm, concise colleague${role ? ` who is ${role}` : ""}. Relaxed pace, friendly tone.`,
      });

const talkerOf = (model: string) => {
  const [provider = "", ...rest] = model.split("/");
  return isTalkerProvider(provider) ? { provider, id: rest.join("/") } : null;
};

// The talker runs on the person's own key; only providers with a LiveKit plugin can talk.
export const canTalk = (model: string, keys: VoiceKeys) => {
  const talker = talkerOf(model);
  return (
    talker !== null &&
    keys[talker.provider] !== null &&
    keys[talker.provider] !== ""
  );
};

export const talkerLlmFor = (model: string, keys: VoiceKeys) => {
  const talker = talkerOf(model);
  if (talker?.provider === "anthropic" && keys.anthropic) {
    return new anthropic.LLM({ model: talker.id, apiKey: keys.anthropic });
  }
  if (talker?.provider === "openai" && keys.openai) {
    return new openai.LLM({ model: talker.id, apiKey: keys.openai });
  }
  return null;
};

const isRunnerClass = (value: unknown): value is new () => InferenceRunner =>
  typeof value === "function" && value.prototype instanceof InferenceRunner;

// Only a LiveKit worker registers the local end-of-turn runner, and this process is not one.
if (!InferenceRunner.registeredRunners[eotInferenceMethod]) {
  InferenceRunner.registerRunner(
    eotInferenceMethod,
    new URL("./inference/eot/runner.js", import.meta.resolve("@livekit/agents"))
      .href
  );
}

const runners = new Map<string, Promise<InferenceRunner>>();

const runnerFor = (method: string) => {
  const existing = runners.get(method);
  if (existing) {
    return existing;
  }
  const loading = (async () => {
    const path = InferenceRunner.registeredRunners[method];
    if (!path) {
      throw new Error(`no inference runner registered for ${method}`);
    }
    // The runner's module path is only known at runtime, from the SDK's registry.
    const module: unknown = await import(path);
    const Runner =
      typeof module === "object" && module !== null && "default" in module
        ? module.default
        : null;
    if (!isRunnerClass(Runner)) {
      throw new Error(`inference runner for ${method} has no runner class`);
    }
    const runner = new Runner();
    await runner.initialize();
    return runner;
  })();
  runners.set(method, loading);
  return loading;
};

let eotFailureReported = false;

const reportEotFailure = (onError: OnError | undefined, err: unknown) => {
  if (!eotFailureReported) {
    eotFailureReported = true;
    onError?.(err, "turn detector");
  }
};

// The SDK's own answer when it has no model: the turn is over, so the 700 ms endpointing decides.
// A thrown error would read as probability 0 instead and hold every turn to the max delay.
const turnOver = { probability: 1, inferenceDurationMs: 0 };

// EotRunner swallows a failed prediction and answers exactly 0, which a working model (a sigmoid)
// never produces, so that shape is treated as a failure too.
const isFailedPrediction = (out: unknown) =>
  typeof out !== "object" ||
  out === null ||
  !("probability" in out) ||
  out.probability === 0;

// The worker's inference executor, in process: each runner loads once and is shared by every ear. A
// runner that fails stays failed, answers "turn over", and is reported once per process.
const executorFor = (onError: OnError | undefined): ipc.InferenceExecutor => ({
  doInference: async (method, data) => {
    try {
      const out = await (await runnerFor(method)).run(data);
      if (method === eotInferenceMethod && isFailedPrediction(out)) {
        reportEotFailure(
          onError,
          new Error("local end-of-turn prediction failed")
        );
        return turnOver;
      }
      return out;
    } catch (err) {
      reportEotFailure(onError, err);
      return turnOver;
    }
  },
});

const turnDetector = (onError: OnError | undefined) => {
  try {
    return new inference.TurnDetector({
      version: "v1-mini",
      executor: executorFor(onError),
    });
  } catch (err) {
    onError?.(err, "turn detector");
    return "vad" as const;
  }
};

const connect = async (url: string, token: string, autoSubscribe: boolean) => {
  const room = new Room();
  await room.connect(url, token, { autoSubscribe, dynacast: false });
  return room;
};

// A session that fails to start would otherwise linger, partly started, and leave its participant
// in the call.
const startOrLeave = async (
  room: Room,
  session: voice.AgentSession,
  start: () => Promise<void>,
  onError: OnError | undefined
) => {
  try {
    await start();
  } catch (err) {
    await session
      .close()
      .catch((closeErr: unknown) => onError?.(closeErr, "session close"));
    await room.disconnect();
    throw err;
  }
};

// Interrupting a session with nothing playing throws (or rejects); there is then nothing to stop.
const interruptQuietly = (session: voice.AgentSession) => {
  try {
    session.interrupt().await.catch(() => undefined);
  } catch {
    return;
  }
};

// Listens to one person: local VAD and end-of-turn detection, streaming STT. It never answers; a
// finished turn goes to the room through `onTurn`.
class EarAgent extends voice.Agent {
  private readonly events: EarEvents;

  constructor(events: EarEvents) {
    super({ instructions: "" });
    this.events = events;
  }
  override async onUserTurnCompleted(
    _chatCtx: llm.ChatContext,
    message: llm.ChatMessage
  ) {
    const text = message.textContent?.trim() ?? "";
    if (text) {
      this.events.onTurn(text);
    }
    throw new voice.StopResponse();
  }
}

// Speaks for one agent and reports each sentence as it reaches TTS, so the room's echo filter
// knows what the speakers are about to play before the ears hear it back.
class VoiceAgent extends voice.Agent {
  private readonly said: (text: string) => void;

  constructor(
    options: voice.AgentOptions<unknown>,
    said: (text: string) => void
  ) {
    super(options);
    this.said = said;
  }
  override async transcriptionNode(
    text:
      | ReadableStream<string | voice.TimedString>
      | AsyncIterable<string | voice.TimedString>,
    modelSettings: voice.ModelSettings
  ) {
    const source = await super.transcriptionNode(text, modelSettings);
    if (!source) {
      return null;
    }
    const said = this.said;
    let pending = "";
    const flush = (all: boolean) => {
      for (
        let end = pending.search(/[.!?]\s/);
        end >= 0;
        end = pending.search(/[.!?]\s/)
      ) {
        const sentence = pending.slice(0, end + 1).trim();
        pending = pending.slice(end + 2);
        if (sentence) {
          said(sentence);
        }
      }
      if (all && pending.trim()) {
        said(pending.trim());
        pending = "";
      }
    };
    return source.pipeThrough(
      new TransformStream<
        string | voice.TimedString,
        string | voice.TimedString
      >({
        transform(chunk, controller) {
          pending += typeof chunk === "string" ? chunk : chunk.text;
          flush(false);
          controller.enqueue(chunk);
        },
        flush() {
          flush(true);
        },
      })
    );
  }
}

export const reconnectGraceMs = 15_000;

// A full LiveKit reconnect shows as the person disconnecting and connecting again, sometimes the
// new connect first; only a disconnect of the latest participant that no connect follows within
// the grace means the person has gone.
export function createDepartureWatch<Participant>(
  onGone: () => void,
  graceMs = reconnectGraceMs
) {
  let latest: Participant | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    connected(participant: Participant) {
      latest = participant;
      stop();
    },
    disconnected(participant: Participant) {
      if (latest !== null && participant !== latest) {
        return;
      }
      latest = null;
      stop();
      timer = setTimeout(() => {
        timer = undefined;
        onGone();
      }, graceMs);
    },
    stop,
  };
}

export async function openEar(options: {
  url: string;
  token: string;
  person: VoicePerson;
  provider: SpeechProviderId;
  keys: VoiceKeys;
  events: EarEvents;
  onError?: OnError;
}): Promise<Ear> {
  // The model load blocks the event loop for a while; better as the person joins than on their
  // first turn.
  runnerFor(eotInferenceMethod).catch((err: unknown) =>
    reportEotFailure(options.onError, err)
  );
  const room = await connect(options.url, options.token, false);
  // The ear needs only this person's microphone; auto-subscribe would pull every camera too.
  const subscribeMicrophone = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ) => {
    if (
      participant.identity === options.person.identity &&
      publication.source === TrackSource.SOURCE_MICROPHONE
    ) {
      publication.setSubscribed(true);
    }
  };
  room.on(RoomEvent.TrackPublished, subscribeMicrophone);
  const subscribeAll = (participant: RemoteParticipant) => {
    for (const publication of participant.trackPublications.values()) {
      subscribeMicrophone(publication, participant);
    }
  };
  const departure = createDepartureWatch<RemoteParticipant>(() => {
    if (opened && !closing) {
      options.events.onGone();
    }
  });
  const person = room.remoteParticipants.get(options.person.identity);
  if (person) {
    departure.connected(person);
    subscribeAll(person);
  }
  const session = new voice.AgentSession({
    stt: sttFor(options.provider, options.keys),
    turnHandling: {
      turnDetection: turnDetector(options.onError),
      endpointing: {
        minDelay: endpointingDelayMs,
        maxDelay: endpointingMaxDelayMs,
      },
    },
  });
  let opened = false;
  let closing = false;
  // Until the ear has opened, a failure surfaces as openEar's own error, not as a lost ear.
  const lost = () => {
    if (!opened || closing) {
      return;
    }
    closing = true;
    departure.stop();
    void session
      .close()
      .catch((err: unknown) => options.onError?.(err, "ear close"));
    void room
      .disconnect()
      .catch((err: unknown) => options.onError?.(err, "ear disconnect"));
    options.events.onLost();
  };
  // RoomIO does not close the session when the ear's own connection drops (network, a kick by a
  // duplicate identity), so the room is watched directly.
  room.on(RoomEvent.Disconnected, lost);
  session.on(voice.AgentSessionEventTypes.Close, (event) => {
    if (event.reason !== voice.CloseReason.USER_INITIATED) {
      lost();
    }
  });
  // The person's tab can vanish without a leave call (closed, crashed, offline); LiveKit still
  // notices, and the room lets them go once the reconnect grace has passed.
  room.on(RoomEvent.ParticipantConnected, (participant) => {
    if (participant.identity === options.person.identity) {
      departure.connected(participant);
      subscribeAll(participant);
    }
  });
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if (participant.identity === options.person.identity) {
      departure.disconnected(participant);
    }
  });
  let speechStartedAtMs = 0;
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
    if (event.newState === "speaking") {
      speechStartedAtMs = Date.now();
      options.events.onSpeechStart();
    } else if (event.oldState === "speaking") {
      options.events.onSpeechStop();
    }
  });
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
    if (!event.isFinal) {
      options.events.onInterim(
        event.transcript,
        Date.now() - speechStartedAtMs
      );
    }
  });
  await startOrLeave(
    room,
    session,
    () =>
      session.start({
        agent: new EarAgent(options.events),
        room,
        inputOptions: {
          participantIdentity: options.person.identity,
          closeOnDisconnect: false,
        },
        outputOptions: { audioEnabled: false, transcriptionEnabled: false },
      }),
    options.onError
  );
  // A drop while starting was ignored by `lost()`; returned as an ear it would leave the person
  // unheard for the call, so it fails the open and the room retries.
  if (!room.isConnected) {
    await session
      .close()
      .catch((err: unknown) => options.onError?.(err, "ear close"));
    throw new Error("ear disconnected while opening");
  }
  opened = true;
  return {
    close: async () => {
      closing = true;
      departure.stop();
      await session.close();
      await room.disconnect();
    },
  };
}

// Speaks for one agent: the talker streams into TTS on the agent's own voice track; `work` hands a
// task to the agent's harness and returns at once, so the floor stays free while it runs.
export async function openVoice(options: {
  url: string;
  token: string;
  agent: AgentConfig;
  voice: { id: string; speed: number };
  provider: SpeechProviderId;
  keys: VoiceKeys;
  talker: llm.LLM;
  work(task: string): Promise<string>;
  said(text: string): void;
  onError?: OnError;
}): Promise<Voice> {
  const room = await connect(options.url, options.token, false);
  const work = llm.tool({
    name: "work",
    description:
      "Hand a task to your own tools (live docs, sheets, slides, files, browser, memory). Returns immediately; the result comes back to you to report.",
    parameters: z.object({
      task: z.string().describe("What to do, in one or two sentences."),
    }),
    execute: async ({ task }) => {
      options
        .work(task)
        .catch((err: unknown) => options.onError?.(err, "work"));
      return "Started. Tell the call in one short sentence what you are doing.";
    },
  });
  const agent = new VoiceAgent(
    {
      instructions: `${agentIdentity(options.agent)}\n\n${spokenStyle}`,
      tools: [work],
    },
    options.said
  );
  const session = new voice.AgentSession({
    llm: options.talker,
    tts: ttsFor(
      options.provider,
      options.keys,
      options.voice.id,
      options.voice.speed,
      options.agent.role
    ),
    vad: null,
    turnHandling: {
      turnDetection: "manual",
      preemptiveGeneration: { enabled: false },
    },
  });
  session.on(voice.AgentSessionEventTypes.Close, (event) => {
    if (event.reason !== voice.CloseReason.USER_INITIATED) {
      void room
        .disconnect()
        .catch((err: unknown) => options.onError?.(err, "voice disconnect"));
    }
  });
  await startOrLeave(
    room,
    session,
    () =>
      session.start({
        agent,
        room,
        inputOptions: {
          audioEnabled: false,
          textEnabled: false,
          closeOnDisconnect: false,
        },
        outputOptions: { audioEnabled: true, transcriptionEnabled: false },
      }),
    options.onError
  );
  // The session shrugs off a talker or TTS failure and resolves the speech anyway; a speech that
  // fails before any audio played rejects instead, so the room's harness fallback answers.
  let played = false;
  let failSpeech: ((err: unknown) => void) | null = null;
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
    if (event.newState === "speaking") {
      played = true;
    }
  });
  session.on(voice.AgentSessionEventTypes.Error, (event) => {
    if (!played && !event.error.recoverable) {
      failSpeech?.(event.error);
    }
  });
  // A tool call's follow-up reply runs on the same handle, so its chat items hold every line the
  // agent actually got out, the cut one trimmed to what was played.
  const speakAndWait = async (
    start: () => voice.SpeechHandle
  ): Promise<Spoken> => {
    played = false;
    const failed = new Promise<never>((_resolve, reject) => {
      failSpeech = reject;
    });
    let handle: voice.SpeechHandle;
    try {
      handle = start();
      await Promise.race([handle.waitForPlayout(), failed]);
    } finally {
      failSpeech = null;
    }
    const said = handle.chatItems
      .flatMap((item) =>
        item.type === "message" && item.role === "assistant"
          ? [item.textContent ?? ""]
          : []
      )
      .join(" ")
      .trim();
    return { said, cut: handle.interrupted };
  };
  return {
    reply: (turn) =>
      speakAndWait(() => session.generateReply({ userInput: turn })),
    report: (result) =>
      speakAndWait(() =>
        session.generateReply({
          instructions: `Your work just finished. Result:\n${result}\nTell the call in one or two spoken sentences.`,
        })
      ),
    stop: () => interruptQuietly(session),
    close: async () => {
      await session.close();
      await room.disconnect();
    },
  };
}
