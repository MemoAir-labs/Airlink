import { CommitStrategy, RealtimeEvents, Scribe } from "@elevenlabs/client";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { TranscriptLine } from "@memo-air/media";
import {
  mediaState,
  readHuddleTranscript,
  startHuddle,
  transcript,
} from "@memo-air/media";
import type {
  LiveActor,
  MediaMessage,
  MediaSignalInput,
} from "@memo-air/protocol";
import { mediaMessageSchema } from "@memo-air/protocol";
import { format } from "date-fns";
import type { LocalParticipant, RemoteParticipant } from "livekit-client";
import { Room, RoomEvent, Track } from "livekit-client";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { useLiveHost } from "./host";
import { actorLabel } from "./LiveBrowserView";
import type { CommentAgent } from "./LiveDocComments";
import { LiveObjectFrame } from "./LiveObjectFrame";
import type { LiveDocViewProps } from "./liveViewShared";
import type { PerceptionSignal } from "./perception";
import { startPerception } from "./perception";
import {
  Button,
  cn,
  Headphones01,
  type IconComponent,
  MessageSquare01,
  Mic,
  MicOff,
  PhoneOff,
  ScanFace,
  Spinner,
  useSendNotification,
  Video,
  VideoOff,
  XClose,
} from "./ui";
import type { LiveDocSession, LivePeer } from "./useLiveDocSession";
import { colorForId } from "./useLiveDocSession";

// Chrome asks only once per site; after a dismissal or a block it fails silently, so say where to fix it.
function deviceErrorDescription(device: "camera" | "microphone", err: unknown) {
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
      return `The browser blocked the ${device}. Click the site icon left of the address bar, set ${device === "camera" ? "Camera" : "Microphone"} to Allow, and reload. On macOS also allow your browser under System Settings → Privacy & Security → ${device === "camera" ? "Camera" : "Microphone"}.`;
    case "NotFoundError":
      return `No ${device} was found on this computer.`;
    case "NotReadableError":
      return `The ${device} is in use by another app. Close it and try again.`;
    default:
      return err instanceof Error
        ? err.message
        : `Could not start the ${device}.`;
  }
}

const signalLingerMs = 4000;
// Consecutive closes with no line transcribed in between before transcribing gives up.
const scribeMaxReconnects = 5;
const interimPostIntervalMs = 600;
const transcriptGroupMs = 5 * 60_000;

type Signal = Extract<MediaMessage, { type: "media_signal" }>;

type Tile = {
  identity: string;
  name: string;
  kind: "human" | "agent";
  isLocal: boolean;
  speaking: boolean;
  // Null for a channel agent that is in the call without a connection of its own: it hears the
  // transcript and answers through the room's speech.
  participant: LocalParticipant | RemoteParticipant | null;
};

function kindOf(
  participant: LocalParticipant | RemoteParticipant
): "human" | "agent" {
  try {
    const metadata: unknown = JSON.parse(participant.metadata || "{}");
    return typeof metadata === "object" &&
      metadata !== null &&
      "kind" in metadata &&
      metadata.kind === "agent"
      ? "agent"
      : "human";
  } catch {
    return "human";
  }
}

function tilesOf(room: Room): Tile[] {
  const all: (LocalParticipant | RemoteParticipant)[] = [
    room.localParticipant,
    ...room.remoteParticipants.values(),
  ];
  return all.map((participant) => ({
    identity: participant.identity,
    name: participant.name || participant.identity,
    kind: kindOf(participant),
    isLocal: participant === room.localParticipant,
    speaking: participant.isSpeaking,
    participant,
  }));
}

// Keeps the LiveKit room in React state: who is here, who is speaking, and the media tracks
// attached to each tile's elements.
function useLiveKitRoom(
  fetchToken: () => Promise<{ url: string; token: string } | null>
) {
  const [room, setRoom] = useState<Room | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = useCallback(async () => {
    setIsJoining(true);
    setError(null);
    const grant = await fetchToken();
    if (!grant) {
      setError("The room's media server is not available.");
      setIsJoining(false);
      return;
    }
    const next = new Room({ adaptiveStream: true, dynacast: true });
    const refresh = () => setTiles(tilesOf(next));
    next
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.TrackSubscribed, refresh)
      .on(RoomEvent.TrackUnsubscribed, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.Disconnected, () => {
        setRoom(null);
        setTiles([]);
      });
    try {
      await next.connect(grant.url, grant.token);
      setRoom(next);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join the room.");
    } finally {
      setIsJoining(false);
    }
  }, [fetchToken]);

  const leave = useCallback(async () => {
    await room?.disconnect();
    setRoom(null);
    setTiles([]);
  }, [room]);

  useEffect(
    () => () => {
      void room?.disconnect();
    },
    [room]
  );

  return { room, tiles, isJoining, error, join, leave };
}

interface TileViewProps {
  tile: Tile;
  signal: Signal | null;
  compact?: boolean;
  // An agent hearing someone speak; it answers when named or clearly meant.
  listening?: boolean;
}

// A level meter's bars, moving while the tile's person or agent talks.
function VoiceBars() {
  return (
    <span aria-hidden className="flex h-3 shrink-0 items-center gap-0.5">
      {[0, 180, 90].map((delayMs) => (
        <span
          key={delayMs}
          className="h-full w-0.5 rounded-full bg-green-400 motion-safe:animate-voice"
          style={{ animationDelay: `${delayMs}ms` }}
        />
      ))}
    </span>
  );
}

function TileView({
  tile,
  signal,
  compact = false,
  listening = false,
}: TileViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const camera = tile.participant?.getTrackPublication(
    Track.Source.Camera
  )?.track;
  const microphone = tile.isLocal
    ? undefined
    : tile.participant?.getTrackPublication(Track.Source.Microphone)?.track;

  useEffect(() => {
    const video = videoRef.current;
    if (!camera || !video) {
      return;
    }
    camera.attach(video);
    return () => {
      camera.detach(video);
    };
  }, [camera]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!microphone || !audio) {
      return;
    }
    microphone.attach(audio);
    return () => {
      microphone.detach(audio);
    };
  }, [microphone]);

  const color = colorForId(tile.identity);
  const muted = tile.participant
    ? !tile.participant.isMicrophoneEnabled
    : false;
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl bg-background shadow-sm ring-1 ring-border transition-shadow dark:bg-background-night dark:ring-border-night",
        compact ? "aspect-[4/3]" : "aspect-video",
        tile.speaking && "ring-3 ring-green-500 dark:ring-green-500",
        listening && "ring-2 ring-highlight-500/50 dark:ring-highlight-500/50"
      )}
      aria-label={`${tile.name}${tile.speaking ? ", speaking" : listening ? ", listening" : ""}${muted ? ", muted" : ""}`}
      title={
        tile.participant
          ? undefined
          : `Say “${tile.name}, …” in the call to ask ${tile.name}`
      }
    >
      {camera ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={tile.isLocal}
          className="h-full w-full object-cover"
          data-perception-video={tile.isLocal ? "local" : undefined}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span
            className={cn(
              "relative",
              compact ? "h-10 w-10 rounded-xl" : "h-16 w-16 rounded-2xl"
            )}
          >
            {tile.speaking && (
              <span
                aria-hidden
                className="absolute inset-0 rounded-[inherit] bg-green-500/50 motion-safe:animate-ping"
              />
            )}
            <span
              className={cn(
                "relative flex h-full w-full items-center justify-center rounded-[inherit] font-semibold text-white",
                compact ? "text-lg" : "text-2xl"
              )}
              style={{ backgroundColor: color }}
            >
              {tile.kind === "agent" ? "✦" : tile.name.charAt(0).toUpperCase()}
            </span>
          </span>
        </div>
      )}
      {microphone && <audio ref={audioRef} autoPlay />}
      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-white">
        {tile.speaking ? (
          <VoiceBars />
        ) : (
          muted && <MicOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <span className="truncate">
          {tile.kind === "agent" ? `✦ ${tile.name}` : tile.name}
          {tile.isLocal && " (you)"}
        </span>
      </div>
      {listening && !signal && (
        <div className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-xs text-white">
          <span className="h-1.5 w-1.5 rounded-full bg-highlight-400 motion-safe:animate-pulse" />
          Listening
        </div>
      )}
      {signal && (
        <div className="absolute right-2 top-2 rounded-md bg-black/60 px-2 py-1 text-xs text-white">
          {signal.signal === "gesture"
            ? signal.value.replace(/_/g, " ").toLowerCase()
            : signal.value}
        </div>
      )}
    </div>
  );
}

interface ControlButtonProps {
  icon: IconComponent;
  label: string;
  tooltip?: string;
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
}

// A round call control, as in a huddle: pressed means the thing it names is on.
function ControlButton({
  icon: Visual,
  label,
  tooltip,
  pressed,
  disabled,
  onClick,
}: ControlButtonProps) {
  return (
    <button
      type="button"
      title={tooltip ?? label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight-500 disabled:pointer-events-none disabled:opacity-40",
        pressed
          ? "bg-highlight-500 text-white hover:bg-highlight-600"
          : "bg-muted-background text-foreground hover:bg-border dark:bg-muted-background-night dark:text-foreground-night dark:hover:bg-border-night"
      )}
    >
      <Visual className="h-5 w-5" />
    </button>
  );
}

interface TranscriptListProps {
  lines: TranscriptLine[];
  interim: { id: string; text: string } | null;
  listening: boolean;
}

function TranscriptList({ lines, interim, listening }: TranscriptListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (lines.length === 0 && !interim) {
      return;
    }
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines, interim]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3 text-sm">
      {lines.length === 0 && !interim && (
        <div className="m-auto max-w-56 text-center text-muted-foreground dark:text-muted-foreground-night">
          {listening
            ? "Listening… what you say appears here for everyone."
            : "Nothing has been said yet. Unmute to add what you say."}
        </div>
      )}
      {lines.map((line, index) => {
        const previous = lines[index - 1];
        // Like a chat: one speaker talking on in the same breath reads as one message.
        const continues =
          previous?.actor.id === line.actor.id &&
          Date.parse(line.at) - Date.parse(previous.at) < transcriptGroupMs;
        return (
          <div
            key={line.id}
            className={cn(
              "flex gap-2.5",
              continues ? "mt-0.5" : "mt-3 first:mt-0",
              !line.final && "opacity-60"
            )}
          >
            {continues ? (
              <span className="w-8 shrink-0" />
            ) : (
              <span
                aria-hidden
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white"
                style={{
                  backgroundColor: colorForId(line.actor.id),
                }}
              >
                {line.actor.kind === "agent"
                  ? "✦"
                  : line.actor.name.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="min-w-0 flex-1">
              {!continues && (
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-semibold">
                    {actorLabel(line.actor)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground dark:text-muted-foreground-night">
                    {format(new Date(line.at), "HH:mm")}
                  </span>
                </div>
              )}
              <p className="leading-relaxed break-words">
                {line.text}
                {line.cut && (
                  <span className="text-muted-foreground dark:text-muted-foreground-night">
                    {" "}
                    — cut off
                  </span>
                )}
              </p>
            </div>
          </div>
        );
      })}
      {interim && (
        <div className="mt-3 flex gap-2.5 opacity-60">
          <span className="w-8 shrink-0" />
          <div className="min-w-0 flex-1">
            <span className="font-semibold">You</span>
            <p className="leading-relaxed break-words italic">{interim.text}</p>
          </div>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

// Silence and our own stop end a session quietly and it restarts; anything else would fail the
// same way on every restart, so transcribing stops and says why.
function speechErrorDescription(error: string): string | null {
  switch (error) {
    case "no-speech":
    case "aborted":
      return null;
    case "network":
      return "This browser has no working speech service (Brave and some other Chromium builds ship the API without one). Use Chrome, Edge or Safari, or set an ElevenLabs key on the server; the call itself keeps working.";
    case "not-allowed":
    case "service-not-allowed":
      return deviceErrorDescription(
        "microphone",
        new DOMException("", "NotAllowedError")
      );
    case "audio-capture":
      return "No microphone could be captured for transcribing.";
    case "language-not-supported":
      return `This browser cannot transcribe ${navigator.language}.`;
    default:
      return `Transcribing stopped (${error}).`;
  }
}

function speechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w: unknown = window;
  if (typeof w !== "object" || w === null) {
    return null;
  }
  const candidate =
    "SpeechRecognition" in w
      ? w.SpeechRecognition
      : "webkitSpeechRecognition" in w
        ? w.webkitSpeechRecognition
        : null;
  return typeof candidate === "function"
    ? (candidate as new () => SpeechRecognitionLike)
    : null;
}

interface MediaBodyProps {
  docId: string;
  stage?: ReactNode;
  agents: CommentAgent[];
  onInCall?: (inCall: boolean) => void;
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  peers: LivePeer[];
  canSpeak: boolean;
  userId: string;
  signals: Map<string, Signal>;
}

function MediaBody({
  docId,
  stage,
  agents,
  onInCall,
  provider,
  ydoc,
  canSpeak,
  signals,
}: MediaBodyProps) {
  const host = useLiveHost();
  // Undefined when the host has no server voice at all, null while it is still loading.
  const serverVoiceState = host.useServerVoice?.();
  const serverVoice = serverVoiceState === true;
  const leaveCall = host.useLeaveCall?.(docId);
  const fetchMediaToken = host.useFetchMediaToken({ docId });
  const sendNotification = useSendNotification();
  const postLine = host.usePostTranscriptLine(docId);
  const fetchTranscribeToken = host.useFetchTranscribeToken();
  const { room, tiles, isJoining, error, join, leave } =
    useLiveKitRoom(fetchMediaToken);
  const [lines, setLines] = useState<TranscriptLine[]>(() =>
    readHuddleTranscript(ydoc)
  );
  const [interim, setInterim] = useState<{ id: string; text: string } | null>(
    null
  );
  const [micOn, setMicOn] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [listening, setListening] = useState(false);
  const [perceptionOn, setPerceptionOn] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const recognitionRef = useRef<{ stop(): void } | null>(null);
  const lastInterimPostRef = useRef(0);

  useEffect(() => {
    const lines = transcript(ydoc);
    const state = mediaState(ydoc);
    const onChange = () => setLines(readHuddleTranscript(ydoc));
    lines.observe(onChange);
    state.observe(onChange);
    return () => {
      lines.unobserve(onChange);
      state.unobserve(onChange);
    };
  }, [ydoc]);

  useEffect(() => {
    onInCall?.(room !== null);
  }, [room, onInCall]);
  useEffect(() => () => onInCall?.(false), [onInCall]);

  // Leaving, or being dropped, turns off everything the call had on.
  useEffect(() => {
    if (room) {
      return;
    }
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
    setInterim(null);
    setMicOn(false);
    setCameraOn(false);
    setPerceptionOn(false);
  }, [room]);

  // Whoever finds the call with no other person in it starts a new huddle; agents keep no huddle
  // going on their own.
  useEffect(() => {
    if (!room || !canSpeak) {
      return;
    }
    const someoneHere = [...room.remoteParticipants.values()].some(
      (participant) => kindOf(participant) === "human"
    );
    if (!someoneHere) {
      startHuddle(ydoc);
    }
  }, [room, canSpeak, ydoc]);

  const toggleMic = async () => {
    if (!room) {
      return;
    }
    const next = !micOn;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
    } catch (err) {
      sendNotification({
        type: "error",
        title: "Microphone unavailable",
        description: deviceErrorDescription("microphone", err),
      });
      return;
    }
    setMicOn(next);
    // What an unmuted person says is transcribed, and nothing while muted.
    if (!serverVoice && next !== listening) {
      void toggleListening();
    }
  };

  const toggleCamera = async () => {
    if (!room) {
      return;
    }
    const next = !cameraOn;
    try {
      await room.localParticipant.setCameraEnabled(next);
    } catch (err) {
      sendNotification({
        type: "error",
        title: "Camera unavailable",
        description: deviceErrorDescription("camera", err),
      });
      return;
    }
    setCameraOn(next);
  };

  const stopListening = (description: string | null) => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
    setInterim(null);
    if (description) {
      sendNotification({
        type: "error",
        title: "Transcribing stopped",
        description,
      });
    }
  };

  const postInterim = (id: string, text: string) => {
    setInterim({ id, text });
    const now = Date.now();
    if (now - lastInterimPostRef.current > interimPostIntervalMs) {
      lastInterimPostRef.current = now;
      void postLine({ id, text, final: false });
    }
  };

  // ElevenLabs Scribe streams the microphone from the page itself, so it works in browsers that
  // ship no speech service (Brave, Firefox); one line per segment Scribe commits at a pause. The
  // service ends a session after a while without speech, or when the machine sleeps, so a closed
  // session is reopened with a fresh token until the person stops or it keeps failing.
  const startScribe = (first: { token: string; baseUri: string }) => {
    const session = crypto.randomUUID().slice(0, 8);
    let segment = 0;
    let failures = 0;
    let stopped = false;
    let connection: ReturnType<typeof Scribe.connect> | null = null;
    const handle = {
      stop: () => {
        stopped = true;
        connection?.close();
      },
    };
    const fail = (description: string) => {
      if (recognitionRef.current === handle) {
        stopListening(description);
      }
    };
    const open = ({ token, baseUri }: { token: string; baseUri: string }) => {
      const current = Scribe.connect({
        token,
        baseUri,
        modelId: "scribe_v2_realtime",
        commitStrategy: CommitStrategy.VAD,
        microphone: { echoCancellation: true, noiseSuppression: true },
      });
      connection = current;
      current.on(RealtimeEvents.PARTIAL_TRANSCRIPT, ({ text }) => {
        if (text.trim()) {
          postInterim(`${session}-${segment}`, text.trim());
        }
      });
      current.on(RealtimeEvents.COMMITTED_TRANSCRIPT, ({ text }) => {
        const id = `${session}-${segment}`;
        segment += 1;
        failures = 0;
        setInterim(null);
        if (text.trim()) {
          void postLine({ id, text: text.trim(), final: true });
        }
      });
      current.on(RealtimeEvents.AUTH_ERROR, () => {
        stopped = true;
        fail("The transcription service refused this session. Try again.");
      });
      current.on(RealtimeEvents.QUOTA_EXCEEDED, () => {
        stopped = true;
        fail("The transcription service's quota is used up.");
      });
      current.on(RealtimeEvents.CLOSE, () => {
        if (
          stopped ||
          connection !== current ||
          recognitionRef.current !== handle
        ) {
          return;
        }
        failures += 1;
        if (failures > scribeMaxReconnects) {
          fail("The transcription service keeps closing the connection.");
          return;
        }
        void fetchTranscribeToken().then((next) => {
          if (stopped || recognitionRef.current !== handle) {
            return;
          }
          if (next) {
            open(next);
          } else {
            fail("This server could not open a new transcription session.");
          }
        });
      });
    };
    open(first);
    recognitionRef.current = handle;
    setListening(true);
  };

  // Each person transcribes their own microphone; lines go to the shared transcript attributed to
  // them, interim first and final once they pause.
  const toggleListening = async () => {
    if (listening) {
      stopListening(null);
      return;
    }
    const scribe = await fetchTranscribeToken();
    if (scribe) {
      startScribe(scribe);
      return;
    }
    const Recognition = speechRecognition();
    if (!Recognition) {
      sendNotification({
        type: "error",
        title: "Cannot transcribe",
        description:
          "This browser has no speech service and this server has no ElevenLabs key. Use Chrome, Edge or Safari, or set an ElevenLabs key.",
      });
      return;
    }
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    const session = crypto.randomUUID().slice(0, 8);
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const id = `${session}-${i}`;
        const text = result[0].transcript.trim();
        if (!text) {
          continue;
        }
        if (result.isFinal) {
          setInterim(null);
          void postLine({ id, text, final: true });
        } else {
          postInterim(id, text);
        }
      }
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognition.start();
      }
    };
    recognition.onerror = ({ error }) => {
      const description = speechErrorDescription(error);
      if (description && recognitionRef.current === recognition) {
        stopListening(description);
      }
    };
    recognition.start();
    recognitionRef.current = recognition;
    setListening(true);
  };

  useEffect(
    () => () => {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (!perceptionOn || !cameraOn) {
      return;
    }
    const video = document.querySelector<HTMLVideoElement>(
      '[data-perception-video="local"]'
    );
    if (!video) {
      return;
    }
    let stop: (() => void) | null = null;
    let cancelled = false;
    const send = (signal: PerceptionSignal) => {
      const input: MediaSignalInput = { type: "signal", ...signal };
      provider.sendStateless(JSON.stringify(input));
    };
    void startPerception(video, send).then((stopper) => {
      if (cancelled) {
        stopper();
      } else {
        stop = stopper;
      }
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [perceptionOn, cameraOn, provider]);

  // The room is the stage, or once joined the host's stage (a channel's space) with the people in
  // a strip above it; the transcript is a side pane opened on demand, over the stage on a narrow
  // screen. Once nobody is in the call and something was said, the transcript is the
  // record of it, so it takes the stage instead.
  const transcriptOnStage = !room && !isJoining && lines.length > 0;
  // The channel's agents sit in every call; one already connected (speaking through the server)
  // is not drawn twice.
  const connectedNames = new Set(tiles.map((tile) => tile.name));
  const personSpeaking = tiles.some(
    (tile) => tile.kind === "human" && tile.speaking
  );
  const shownTiles: Tile[] = room
    ? [
        ...tiles,
        ...agents
          .filter((agent) => !connectedNames.has(agent.name))
          .map((agent) => ({
            identity: `agent:${agent.configurationId}`,
            name: agent.name,
            kind: "agent" as const,
            isLocal: false,
            speaking: false,
            participant: null,
          })),
      ]
    : tiles;
  const paneOpen = showTranscript && !transcriptOnStage;
  return (
    <div className="@container flex min-h-0 flex-1">
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col bg-muted-background/60 dark:bg-muted-background-night/60",
          paneOpen ? "hidden @2xl:flex" : "flex"
        )}
      >
        {room && serverVoiceState === false && (
          <p className="mx-2 mt-2 rounded-lg bg-muted-background px-3 py-2 text-xs text-muted-foreground dark:bg-muted-background-night dark:text-muted-foreground-night">
            Agents answer this call in chat. Add an ElevenLabs or OpenAI key in
            Settings to hear them.
          </p>
        )}
        {room && stage ? (
          <div className="flex min-h-0 flex-1 flex-col-reverse gap-2 p-2 @3xl:flex-row">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background dark:border-border-night dark:bg-background-night">
              {stage}
            </div>
            <div
              aria-label="People in the huddle"
              className="flex shrink-0 gap-2 overflow-x-auto p-1 @3xl:w-48 @3xl:flex-col @3xl:overflow-x-visible @3xl:overflow-y-auto"
            >
              {shownTiles.map((tile) => (
                <div key={tile.identity} className="w-40 shrink-0 @3xl:w-full">
                  <TileView
                    tile={tile}
                    compact
                    listening={
                      tile.kind === "agent" && !tile.speaking && personSpeaking
                    }
                    signal={
                      signals.get(
                        tile.identity.replace(/^(user|agent):/, "")
                      ) ?? null
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 overflow-y-auto p-4">
            {transcriptOnStage ? (
              <section
                aria-label="Transcript"
                className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background dark:border-border-night dark:bg-background-night"
              >
                <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 dark:border-border-night">
                  <h2 className="flex-1 text-sm font-semibold">Transcript</h2>
                  {error && (
                    <span
                      role="alert"
                      className="truncate text-xs text-warning-600 dark:text-warning-400"
                    >
                      {error}
                    </span>
                  )}
                </div>
                <TranscriptList
                  lines={lines}
                  interim={interim}
                  listening={listening}
                />
              </section>
            ) : shownTiles.length > 0 ? (
              <div className="m-auto grid w-full max-w-5xl grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] content-center gap-3">
                {shownTiles.map((tile) => (
                  <TileView
                    key={tile.identity}
                    tile={tile}
                    listening={
                      tile.kind === "agent" && !tile.speaking && personSpeaking
                    }
                    signal={
                      signals.get(
                        tile.identity.replace(/^(user|agent):/, "")
                      ) ?? null
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="m-auto flex max-w-sm flex-col items-center gap-3 text-center">
                <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-highlight-500/10 text-highlight-600 dark:text-highlight-400">
                  {isJoining ? (
                    <Spinner />
                  ) : (
                    <Headphones01 className="h-8 w-8" />
                  )}
                </span>
                <h2 className="text-base font-semibold">
                  {isJoining ? "Joining the huddle…" : "Huddle"}
                </h2>
                <p className="text-sm text-muted-foreground dark:text-muted-foreground-night">
                  Join to talk, share your camera, and hear the agents. The
                  transcript is shared with everyone either way.
                </p>
                {error && (
                  <p
                    role="alert"
                    className="text-sm text-warning-600 dark:text-warning-400"
                  >
                    {error}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
        <div
          className={cn(
            "flex shrink-0 justify-center px-4",
            room && stage ? "pb-2" : "pb-4"
          )}
        >
          <div
            role="toolbar"
            aria-label="Huddle controls"
            className="flex max-w-full items-center gap-2 overflow-x-auto rounded-full border border-border bg-background p-1.5 shadow-lg dark:border-border-night dark:bg-background-night"
          >
            {room ? (
              <>
                <ControlButton
                  icon={micOn ? Mic : MicOff}
                  label="Microphone"
                  tooltip={
                    micOn
                      ? "Mute"
                      : "Unmute — what you say goes into the shared transcript"
                  }
                  pressed={micOn}
                  disabled={!canSpeak}
                  onClick={() => void toggleMic()}
                />
                <ControlButton
                  icon={cameraOn ? Video : VideoOff}
                  label="Camera"
                  tooltip={cameraOn ? "Turn camera off" : "Turn camera on"}
                  pressed={cameraOn}
                  disabled={!canSpeak}
                  onClick={() => void toggleCamera()}
                />
                <ControlButton
                  icon={ScanFace}
                  label="Share signals"
                  tooltip="Runs face and hand recognition in your browser and shares only present/away and gestures. Needs your camera."
                  pressed={perceptionOn}
                  disabled={!cameraOn}
                  onClick={() => setPerceptionOn((on) => !on)}
                />
              </>
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon={Headphones01}
                label={isJoining ? "Joining…" : "Join huddle"}
                disabled={isJoining}
                className="h-11 rounded-full px-5"
                onClick={() => void join()}
              />
            )}
            {!transcriptOnStage && (
              <>
                <span className="mx-1 h-6 w-px shrink-0 bg-border dark:bg-border-night" />
                <ControlButton
                  icon={MessageSquare01}
                  label="Transcript"
                  tooltip={
                    showTranscript
                      ? "Hide the transcript"
                      : "Show the transcript"
                  }
                  pressed={showTranscript}
                  onClick={() => setShowTranscript((on) => !on)}
                />
              </>
            )}
            {room && (
              <Button
                size="sm"
                variant="warning"
                icon={PhoneOff}
                label="Leave"
                className="h-11 rounded-full bg-red-600 px-5 hover:bg-red-700"
                onClick={() => {
                  leaveCall?.(room.localParticipant.identity);
                  void leave();
                }}
              />
            )}
          </div>
        </div>
      </div>
      {paneOpen && (
        <aside
          aria-label="Transcript"
          className="flex min-h-0 w-full flex-col border-border bg-background @2xl:w-80 @2xl:border-l dark:border-border-night dark:bg-background-night"
        >
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 dark:border-border-night">
            <h2 className="flex-1 text-sm font-semibold">Transcript</h2>
            <Button
              size="xs"
              variant="ghost"
              icon={XClose}
              tooltip="Close the transcript"
              onClick={() => setShowTranscript(false)}
            />
          </div>
          <TranscriptList
            lines={lines}
            interim={interim}
            listening={listening}
          />
        </aside>
      )}
    </div>
  );
}

// A live room: voice and video over LiveKit, one participant per person and agent, with a
// shared transcript in the doc and client-side signals.
export function LiveMediaView(props: LiveDocViewProps) {
  const [showHistory, setShowHistory] = useState(false);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [signals, setSignals] = useState<Map<string, Signal>>(new Map());
  const onSession = useCallback(
    (session: LiveDocSession | null) => setProvider(session?.provider ?? null),
    []
  );

  useEffect(() => {
    if (!provider) {
      return;
    }
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const onStateless = ({ payload }: { payload: string }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return;
      }
      const message = mediaMessageSchema.safeParse(raw);
      if (!message.success) {
        return;
      }
      if (message.data.type === "media_speak") {
        return;
      }
      const signal = message.data;
      setSignals((current) => new Map(current).set(signal.actor.id, signal));
      const existing = timers.get(signal.actor.id);
      if (existing) {
        clearTimeout(existing);
      }
      timers.set(
        signal.actor.id,
        setTimeout(() => {
          setSignals((current) => {
            const next = new Map(current);
            next.delete(signal.actor.id);
            return next;
          });
        }, signalLingerMs)
      );
    };
    provider.on("stateless", onStateless);
    return () => {
      provider.off("stateless", onStateless);
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
    };
  }, [provider]);

  return (
    <LiveObjectFrame
      {...props}
      kindLabel="live room"
      showHistory={showHistory}
      onToggleHistory={setShowHistory}
      historyLabel="Back to the room"
      onSession={onSession}
    >
      {({ session, peers, access, user }) => (
        <MediaBody
          docId={props.docId}
          stage={props.stage}
          agents={props.agents}
          onInCall={props.onInCall}
          provider={session.provider}
          ydoc={session.ydoc}
          peers={peers}
          canSpeak={access !== "read"}
          userId={user.id}
          signals={signals}
        />
      )}
    </LiveObjectFrame>
  );
}

export function signalLabel(actor: LiveActor, signal: Signal) {
  return `${actorLabel(actor)}: ${signal.value}`;
}
