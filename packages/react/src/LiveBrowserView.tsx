import type { HocuspocusProvider } from "@hocuspocus/provider";
import { defaultViewport, readBrowserState } from "@memo-air/browser";
import type { BrowserVideoConnection } from "@memo-air/browser/video";
import { connectBrowserVideo } from "@memo-air/browser/video";
import type {
  BrowserInput,
  BrowserMessage,
  LiveActor,
} from "@memo-air/protocol";
import { browserMessageSchema } from "@memo-air/protocol";
import { format } from "date-fns";
import type { KeyboardEvent, PointerEvent, WheelEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { useLiveHost } from "./host";
import type { LiveObjectStatus } from "./LiveObjectFrame";
import { LiveObjectFrame } from "./LiveObjectFrame";
import type { LiveDocViewProps } from "./liveViewShared";
import {
  ArrowLeft,
  ArrowRight,
  Button,
  cn,
  RefreshCw02,
  Spinner,
  VolumeMax,
  VolumeX,
} from "./ui";
import type { LiveDocSession, LivePeer } from "./useLiveDocSession";

const pointerThrottleMs = 33;
const deniedNoticeMs = 2500;
const noPictureMs = 10_000;
const minPictureWidth = 16;
const modifierBits = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
// Keys the page should get rather than the browser tab around it.
const capturedKeys = new Set([
  "Tab",
  "Backspace",
  " ",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

type Frame = { src: string; width: number; height: number };
type Status = Extract<BrowserMessage, { type: "browser_status" }>;

export function modifiersOf(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? modifierBits.alt : 0) |
    (event.ctrlKey ? modifierBits.ctrl : 0) |
    (event.metaKey ? modifierBits.meta : 0) |
    (event.shiftKey ? modifierBits.shift : 0)
  );
}

export function buttonOf(button: number): "left" | "right" | "middle" | "none" {
  return button === 0
    ? "left"
    : button === 2
      ? "right"
      : button === 1
        ? "middle"
        : "none";
}

export function actorLabel(actor: LiveActor) {
  return actor.kind === "agent" ? `✦ ${actor.name}` : actor.name;
}

interface PointerOverlayProps {
  peers: LivePeer[];
  width: number;
  height: number;
}

// Everyone else's pointer over the page, in the page's own coordinates.
export function PointerOverlay({ peers, width, height }: PointerOverlayProps) {
  return (
    <>
      {peers
        .filter((peer) => peer.pointer)
        .map((peer) => (
          <div
            key={peer.clientId}
            className="pointer-events-none absolute flex -translate-x-1 -translate-y-1 items-start gap-1"
            style={{
              left: `${((peer.pointer?.x ?? 0) / width) * 100}%`,
              top: `${((peer.pointer?.y ?? 0) / height) * 100}%`,
            }}
          >
            <span
              className="block h-3 w-3 rounded-full border-2 border-white shadow"
              style={{ backgroundColor: peer.color }}
            />
            <span
              className="whitespace-nowrap rounded px-1 text-xs font-medium text-white shadow"
              style={{ backgroundColor: peer.color }}
            >
              {peer.kind === "agent" ? `✦ ${peer.name}` : peer.name}
            </span>
          </div>
        ))}
    </>
  );
}

interface FilmstripProps {
  docId: string;
  onClose: () => void;
}

// What the room has seen: keyframes with the URL and who was driving.
export function Filmstrip({ docId, onClose }: FilmstripProps) {
  const { frames, frameUrl, isFramesLoading } = useLiveHost().useBrowserFrames({
    docId,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const current = frames.find((frame) => frame.id === selected) ?? frames[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 dark:border-border-night">
        <span className="text-sm font-medium">History</span>
        <Button size="xs" variant="ghost" label="Back" onClick={onClose} />
      </div>
      {isFramesLoading && (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      )}
      {!isFramesLoading && frames.length === 0 && (
        <div className="p-6 text-sm text-muted-foreground dark:text-muted-foreground-night">
          Nothing has been recorded yet.
        </div>
      )}
      {current && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 items-center justify-center bg-muted-background p-2 dark:bg-muted-background-night">
            <img
              src={frameUrl(current.id)}
              alt={`${current.url} at ${format(new Date(current.createdAt), "HH:mm:ss")}`}
              className="max-h-full max-w-full rounded border border-border object-contain dark:border-border-night"
            />
          </div>
          <div className="truncate px-3 py-1 text-xs text-muted-foreground dark:text-muted-foreground-night">
            {format(new Date(current.createdAt), "d MMM HH:mm:ss")} ·{" "}
            {actorLabel(current.actor)} · {current.url}
          </div>
          <div className="flex gap-2 overflow-x-auto border-t border-border p-2 dark:border-border-night">
            {frames.map((frame) => (
              <button
                key={frame.id}
                type="button"
                title={`${frame.url} · ${format(new Date(frame.createdAt), "HH:mm:ss")}`}
                onClick={() => setSelected(frame.id)}
                className={cn(
                  "h-14 w-24 shrink-0 overflow-hidden rounded border",
                  frame.id === current.id
                    ? "border-highlight-500"
                    : "border-border dark:border-border-night"
                )}
              >
                <img
                  src={frameUrl(frame.id)}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Receives the server's stateless messages for one doc socket and keeps the latest frame,
// status and "held by" notice.
export function useBrowserChannel(provider: HocuspocusProvider | null) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [deniedBy, setDeniedBy] = useState<LiveActor | null>(null);

  useEffect(() => {
    if (!provider) {
      return;
    }
    let deniedTimer: ReturnType<typeof setTimeout> | null = null;
    const onStateless = ({ payload }: { payload: string }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return;
      }
      const message = browserMessageSchema.safeParse(raw);
      if (!message.success) {
        return;
      }
      switch (message.data.type) {
        case "browser_frame":
          setFrame({
            src: `data:image/jpeg;base64,${message.data.data}`,
            width: message.data.width,
            height: message.data.height,
          });
          return;
        case "browser_status":
          setStatus(message.data);
          return;
        case "browser_denied":
          setDeniedBy(message.data.heldBy);
          if (deniedTimer) {
            clearTimeout(deniedTimer);
          }
          deniedTimer = setTimeout(() => setDeniedBy(null), deniedNoticeMs);
          return;
      }
    };
    provider.on("stateless", onStateless);
    // The join status and last frame may have arrived before this listener existed.
    provider.sendStateless(JSON.stringify({ type: "status" }));
    return () => {
      provider.off("stateless", onStateless);
      if (deniedTimer) {
        clearTimeout(deniedTimer);
      }
    };
  }, [provider]);

  return { frame, status, deniedBy };
}

// The page as video: the browser container encodes its screen to WebRTC, and the viewer joins it
// with a session live-server minted in the viewer's name. The container div is filled by the
// transport's own <video>; `playing` says when it has a picture, `unavailable` when WebRTC never
// came up (the JPEG fallback stays on top either way), `muted` follows the page audio toggle.
function useBrowserVideo(
  fetchGrant: () => Promise<{ url: string; token: string } | null>,
  enabled: boolean
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [client, setClient] = useState<BrowserVideoConnection["client"] | null>(
    null
  );
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) {
      return;
    }
    let cancelled = false;
    let connection: BrowserVideoConnection | null = null;
    const unsubscribers: (() => void)[] = [];
    void (async () => {
      const grant = await fetchGrant();
      if (cancelled) {
        return;
      }
      if (!grant) {
        setUnavailable(true);
        return;
      }
      try {
        connection = await connectBrowserVideo({ ...grant, container });
      } catch {
        setUnavailable(true);
        return;
      }
      if (cancelled) {
        void connection.detach();
        return;
      }
      setClient(connection.client);
      // The element reports "playing" on every ICE retry before any frame arrives, and a failed
      // peer can present one 2 px placeholder, so a picture is only counted once a full-size
      // frame is presented; the element outlives the retries.
      const video = container.querySelector("video");
      const onFrame = () => {
        if (video && video.videoWidth > minPictureWidth) {
          setPlaying(true);
        } else {
          video?.requestVideoFrameCallback(onFrame);
        }
      };
      video?.requestVideoFrameCallback(onFrame);
      unsubscribers.push(
        connection.client.store.subscribe(
          (state) => state.video.muted,
          setMuted,
          { fireImmediately: true }
        ),
        connection.client.transport.on("state", (state) => {
          if (state.status === "unavailable") {
            setUnavailable(true);
          }
        })
      );
    })();
    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      setClient(null);
      setPlaying(false);
      setMuted(true);
      setUnavailable(false);
      void connection?.detach();
    };
  }, [enabled, fetchGrant]);

  // Signalling can succeed while the media never arrives (ICE blocked): the transport then
  // retries quietly, so a picture that has not come after a while counts as unavailable too.
  useEffect(() => {
    if (playing) {
      setUnavailable(false);
    }
    if (!client || playing) {
      return;
    }
    const timer = setTimeout(() => setUnavailable(true), noPictureMs);
    return () => clearTimeout(timer);
  }, [client, playing]);

  return { containerRef, client, playing, muted, unavailable };
}

interface BrowserBodyProps {
  docId: string;
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  peers: LivePeer[];
  canDrive: boolean;
  userId: string;
  frame: Frame | null;
  status: Status | null;
  deniedBy: LiveActor | null;
}

function BrowserBody({
  docId,
  provider,
  ydoc,
  peers,
  canDrive,
  userId,
  frame,
  status,
  deniedBy,
}: BrowserBodyProps) {
  const [urlInput, setUrlInput] = useState("");
  const [isUrlFocused, setIsUrlFocused] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastPointerAtRef = useRef(0);
  const fetchBrowserVideo = useLiveHost().useFetchBrowserVideo(docId);
  const video = useBrowserVideo(fetchBrowserVideo, status?.video === true);
  const videoReady = video.playing;
  const viewport = readBrowserState(ydoc).viewport ?? defaultViewport;
  // Input is mapped in page pixels: the last frame's size when one has arrived, else the
  // viewport the room was opened with.
  const dims = frame
    ? { width: frame.width, height: frame.height }
    : { width: viewport.width, height: viewport.height };

  // The address bar follows the page unless the person is typing in it.
  useEffect(() => {
    if (!isUrlFocused && status) {
      setUrlInput(status.url === "about:blank" ? "" : status.url);
    }
  }, [status, isUrlFocused]);

  const send = (input: BrowserInput) => {
    if (canDrive) {
      provider.sendStateless(JSON.stringify(input));
    }
  };

  const pagePoint = (event: PointerEvent<HTMLElement>) => {
    const stage = stageRef.current;
    if (!stage || (!frame && !videoReady)) {
      return null;
    }
    const rect = stage.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    return {
      x: ((event.clientX - rect.left) / rect.width) * dims.width,
      y: ((event.clientY - rect.top) / rect.height) * dims.height,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const now = Date.now();
    if (now - lastPointerAtRef.current < pointerThrottleMs) {
      return;
    }
    lastPointerAtRef.current = now;
    const point = pagePoint(event);
    if (!point) {
      return;
    }
    provider.setAwarenessField("pointer", point);
    send({
      type: "mouse",
      kind: "move",
      ...point,
      modifiers: modifiersOf(event),
    });
  };

  const onPointerButton = (
    event: PointerEvent<HTMLElement>,
    kind: "down" | "up"
  ) => {
    const point = pagePoint(event);
    if (!point) {
      return;
    }
    event.currentTarget.focus();
    send({
      type: "mouse",
      kind,
      ...point,
      button: buttonOf(event.button),
      clickCount: 1,
      modifiers: modifiersOf(event),
    });
  };

  const onWheel = (event: WheelEvent<HTMLElement>) => {
    const stage = stageRef.current;
    if (!stage || (!frame && !videoReady)) {
      return;
    }
    const rect = stage.getBoundingClientRect();
    send({
      type: "wheel",
      x: ((event.clientX - rect.left) / rect.width) * dims.width,
      y: ((event.clientY - rect.top) / rect.height) * dims.height,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: modifiersOf(event),
    });
  };

  const onKey = (event: KeyboardEvent<HTMLElement>, kind: "down" | "up") => {
    if (!canDrive) {
      return;
    }
    if (capturedKeys.has(event.key) || event.key.length === 1) {
      event.preventDefault();
    }
    send({
      type: "key",
      kind,
      key: event.key,
      code: event.code,
      ...(kind === "down" && event.key.length === 1 ? { text: event.key } : {}),
      modifiers: modifiersOf(event),
    });
  };

  const navigate = () => {
    const url = urlInput.trim();
    if (url) {
      send({ type: "navigate", url });
    }
  };

  const controller = status?.controller ?? null;
  const someoneElseDrives = controller !== null && controller.id !== userId;
  const aspect = `${dims.width} / ${dims.height}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex items-center gap-1 border-b border-border px-2 py-1.5 dark:border-border-night"
        onSubmit={(event) => {
          event.preventDefault();
          navigate();
        }}
      >
        <Button
          size="xs"
          variant="ghost"
          icon={ArrowLeft}
          aria-label="Back"
          tooltip="Back"
          disabled={!canDrive}
          onClick={() => send({ type: "back" })}
        />
        <Button
          size="xs"
          variant="ghost"
          icon={ArrowRight}
          aria-label="Forward"
          tooltip="Forward"
          disabled={!canDrive}
          onClick={() => send({ type: "forward" })}
        />
        <Button
          size="xs"
          variant="ghost"
          icon={RefreshCw02}
          aria-label="Reload"
          tooltip="Reload"
          disabled={!canDrive}
          onClick={() => send({ type: "reload" })}
        />
        <input
          aria-label="Address"
          value={urlInput}
          readOnly={!canDrive}
          placeholder="Enter a web address"
          onChange={(event) => setUrlInput(event.target.value)}
          onFocus={(event) => {
            setIsUrlFocused(true);
            event.target.select();
          }}
          onBlur={() => setIsUrlFocused(false)}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-highlight-400 dark:border-border-night dark:bg-background-night dark:text-foreground-night"
        />
        {video.client && (
          <Button
            size="xs"
            variant="ghost"
            icon={video.muted ? VolumeX : VolumeMax}
            aria-label={video.muted ? "Play page audio" : "Mute page audio"}
            aria-pressed={!video.muted}
            tooltip={video.muted ? "Play page audio" : "Mute page audio"}
            onClick={() =>
              video.muted ? video.client?.unmute() : video.client?.mute()
            }
          />
        )}
      </form>
      {(someoneElseDrives ||
        !canDrive ||
        deniedBy ||
        status?.error ||
        video.unavailable) && (
        <div
          role="status"
          className="flex items-center justify-between gap-2 border-b border-border bg-muted-background px-3 py-1.5 text-xs dark:border-border-night dark:bg-muted-background-night"
        >
          <span className="truncate">
            {status?.error
              ? status.error
              : deniedBy
                ? `${actorLabel(deniedBy)} is driving; wait a moment to take over.`
                : video.unavailable
                  ? "Live video is unavailable; showing a snapshot a second."
                  : !canDrive
                    ? "View only"
                    : controller
                      ? `${actorLabel(controller)} is driving`
                      : ""}
          </span>
          {someoneElseDrives && canDrive && !deniedBy && (
            <Button
              size="xs"
              variant="outline"
              label="Take control"
              onClick={() => send({ type: "claim" })}
            />
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted-background p-2 dark:bg-muted-background-night">
        <div
          role="application"
          aria-label={`Shared browser: ${status?.title || status?.url || "no page"}`}
          tabIndex={0}
          className={cn(
            "relative max-h-full max-w-full overflow-hidden rounded border border-border bg-white outline-none focus-visible:ring-2 focus-visible:ring-highlight-400 dark:border-border-night",
            canDrive ? "cursor-default" : "cursor-not-allowed"
          )}
          style={{ aspectRatio: aspect, width: "100%" }}
          ref={stageRef}
          onPointerMove={onPointerMove}
          onPointerDown={(event) => onPointerButton(event, "down")}
          onPointerUp={(event) => onPointerButton(event, "up")}
          onPointerLeave={() => provider.setAwarenessField("pointer", null)}
          onWheel={onWheel}
          onKeyDown={(event) => onKey(event, "down")}
          onKeyUp={(event) => onKey(event, "up")}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            ref={video.containerRef}
            className="absolute inset-0 select-none"
          />
          {videoReady ? null : frame ? (
            <img
              src={frame.src}
              alt=""
              draggable={false}
              className="relative block h-full w-full select-none"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
              {status?.status === "starting" || !status ? (
                <span className="flex items-center gap-2">
                  <Spinner size="xs" /> Starting the browser…
                </span>
              ) : status.status === "unavailable" ? (
                (status.error ?? "The browser is not available.")
              ) : (
                "The browser is stopped. Enter an address to start it."
              )}
            </div>
          )}
          {(videoReady || frame) && (
            <PointerOverlay
              peers={peers}
              width={dims.width}
              height={dims.height}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// A shared browser: the page as Chromium streams it, driven by whoever holds the controls, with
// everyone's pointer over it. Input goes to live-server as stateless messages on the doc socket.
export function LiveBrowserView(props: LiveDocViewProps) {
  const [showHistory, setShowHistory] = useState(false);
  return (
    <LiveBrowserShell
      {...props}
      showHistory={showHistory}
      onToggleHistory={setShowHistory}
    />
  );
}

interface LiveBrowserShellProps extends LiveDocViewProps {
  showHistory: boolean;
  onToggleHistory: (shown: boolean) => void;
}

function LiveBrowserShell({
  showHistory,
  onToggleHistory,
  ...props
}: LiveBrowserShellProps) {
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const onSession = useCallback(
    (session: LiveDocSession | null) => setProvider(session?.provider ?? null),
    []
  );
  const { frame, status, deniedBy } = useBrowserChannel(provider);
  const badge: LiveObjectStatus | null =
    status?.status === "running"
      ? null
      : status?.status === "starting" || !status
        ? { label: "Starting…", live: false }
        : { label: "Stopped", live: false };

  return (
    <LiveObjectFrame
      {...props}
      kindLabel="live browser"
      status={badge}
      showHistory={showHistory}
      onToggleHistory={onToggleHistory}
      historyLabel="Back to the browser"
      onSession={onSession}
      renderHistory={({ docId, onClose }) => (
        <Filmstrip docId={docId} onClose={onClose} />
      )}
    >
      {({ session, peers, canEdit, user }) => (
        <BrowserBody
          docId={props.docId}
          provider={session.provider}
          ydoc={session.ydoc}
          peers={peers}
          canDrive={canEdit}
          userId={user.id}
          frame={frame}
          status={status}
          deniedBy={deniedBy}
        />
      )}
    </LiveObjectFrame>
  );
}
