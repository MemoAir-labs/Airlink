import type { HocuspocusProvider } from "@hocuspocus/provider";
import { readDesktopState } from "@memo-air/desktop";
import type {
  DesktopInput,
  DesktopMessage,
  LiveActor,
} from "@memo-air/protocol";
import { desktopMessageSchema } from "@memo-air/protocol";
import type { KeyboardEvent, PointerEvent, WheelEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import {
  actorLabel,
  buttonOf,
  Filmstrip,
  PointerOverlay,
} from "./LiveBrowserView";
import type { LiveObjectStatus } from "./LiveObjectFrame";
import { LiveObjectFrame } from "./LiveObjectFrame";
import type { LiveDocViewProps } from "./liveViewShared";
import { Button, cn, Spinner } from "./ui";
import type { LiveDocSession, LivePeer } from "./useLiveDocSession";

const pointerThrottleMs = 50;
const deniedNoticeMs = 2500;

type Status = Extract<DesktopMessage, { type: "desktop_status" }>;

// Browser key names to the X key names the desktop expects.
const keyNames: Record<string, string> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Tab: "Tab",
  Escape: "Escape",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "Page_Up",
  PageDown: "Page_Down",
  " ": "space",
};

function keysOf(event: KeyboardEvent<HTMLElement>): string[] | null {
  const modifiers = [
    event.ctrlKey ? "ctrl" : "",
    event.altKey ? "alt" : "",
    event.metaKey ? "super" : "",
    event.shiftKey && event.key.length > 1 ? "shift" : "",
  ].filter(Boolean);
  const named = keyNames[event.key];
  if (named) {
    return [...modifiers, named];
  }
  if (event.key.length === 1 && modifiers.length > 0) {
    return [...modifiers, event.key.toLowerCase()];
  }
  return null;
}

function useDesktopChannel(provider: HocuspocusProvider | null) {
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
      const message = desktopMessageSchema.safeParse(raw);
      if (!message.success) {
        return;
      }
      if (message.data.type === "desktop_status") {
        setStatus(message.data);
      } else {
        setDeniedBy(message.data.heldBy);
        if (deniedTimer) {
          clearTimeout(deniedTimer);
        }
        deniedTimer = setTimeout(() => setDeniedBy(null), deniedNoticeMs);
      }
    };
    provider.on("stateless", onStateless);
    return () => {
      provider.off("stateless", onStateless);
      if (deniedTimer) {
        clearTimeout(deniedTimer);
      }
    };
  }, [provider]);

  return { status, deniedBy };
}

interface DesktopBodyProps {
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  peers: LivePeer[];
  canDrive: boolean;
  userId: string;
  status: Status | null;
  deniedBy: LiveActor | null;
}

// The provider's view-only stream under a transparent surface that turns pointer and keyboard
// events into desktop input for live-server. Peers' pointers draw over it in screen coordinates.
function DesktopBody({
  provider,
  ydoc,
  peers,
  canDrive,
  userId,
  status,
  deniedBy,
}: DesktopBodyProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const lastPointerAtRef = useRef(0);
  const screen = status?.screen ?? readDesktopState(ydoc).screen;

  const send = (input: DesktopInput) => {
    if (canDrive) {
      provider.sendStateless(JSON.stringify(input));
    }
  };

  const screenPoint = (
    event: PointerEvent<HTMLElement> | WheelEvent<HTMLElement>
  ) => {
    const surface = surfaceRef.current;
    if (!surface) {
      return null;
    }
    const rect = surface.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * screen.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * screen.height),
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const now = Date.now();
    if (now - lastPointerAtRef.current < pointerThrottleMs) {
      return;
    }
    lastPointerAtRef.current = now;
    const point = screenPoint(event);
    if (!point) {
      return;
    }
    provider.setAwarenessField("pointer", point);
    send({ type: "mouse", kind: "move", ...point });
  };

  const onPointerButton = (
    event: PointerEvent<HTMLElement>,
    kind: "down" | "up"
  ) => {
    const point = screenPoint(event);
    if (!point) {
      return;
    }
    event.currentTarget.focus();
    const button = buttonOf(event.button);
    send({
      type: "mouse",
      kind,
      ...point,
      button: button === "none" ? "left" : button,
    });
  };

  const onWheel = (event: WheelEvent<HTMLElement>) => {
    send({
      type: "wheel",
      direction: event.deltaY < 0 ? "up" : "down",
      amount: Math.min(
        50,
        Math.max(1, Math.round(Math.abs(event.deltaY) / 50))
      ),
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!canDrive) {
      return;
    }
    const keys = keysOf(event);
    if (keys) {
      event.preventDefault();
      send({ type: "key", keys });
    } else if (event.key.length === 1) {
      event.preventDefault();
      send({ type: "text", text: event.key });
    }
  };

  const controller = status?.controller ?? null;
  const someoneElseDrives = controller !== null && controller.id !== userId;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {(someoneElseDrives || !canDrive || deniedBy || status?.error) && (
        <div
          role="status"
          className="flex items-center justify-between gap-2 border-b border-border bg-muted-background px-3 py-1.5 text-xs dark:border-border-night dark:bg-muted-background-night"
        >
          <span className="truncate">
            {status?.error
              ? status.error
              : deniedBy
                ? `${actorLabel(deniedBy)} is driving; wait a moment to take over.`
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
          className="relative max-h-full max-w-full overflow-hidden rounded border border-border bg-black dark:border-border-night"
          style={{
            aspectRatio: `${screen.width} / ${screen.height}`,
            width: "100%",
          }}
        >
          {status?.streamUrl ? (
            <iframe
              title="Shared desktop"
              src={status.streamUrl}
              className="pointer-events-none absolute inset-0 h-full w-full border-0"
              allow="clipboard-read; clipboard-write"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
              {status?.status === "starting" || !status ? (
                <span className="flex items-center gap-2">
                  <Spinner size="xs" /> Starting the desktop…
                </span>
              ) : status.status === "unavailable" ? (
                (status.error ?? "The desktop is not available.")
              ) : (
                "The desktop is stopped."
              )}
            </div>
          )}
          <div
            ref={surfaceRef}
            role="application"
            aria-label="Shared desktop"
            tabIndex={0}
            className={cn(
              "absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-highlight-400",
              canDrive ? "cursor-default" : "cursor-not-allowed"
            )}
            onPointerMove={onPointerMove}
            onPointerDown={(event) => onPointerButton(event, "down")}
            onPointerUp={(event) => onPointerButton(event, "up")}
            onPointerLeave={() => provider.setAwarenessField("pointer", null)}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
            onContextMenu={(event) => event.preventDefault()}
          >
            <PointerOverlay
              peers={peers}
              width={screen.width}
              height={screen.height}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// A shared desktop: a machine the provider runs for this room, streamed to everyone, driven by
// whoever holds the controls.
export function LiveDesktopView(props: LiveDocViewProps) {
  const [showHistory, setShowHistory] = useState(false);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const onSession = useCallback(
    (session: LiveDocSession | null) => setProvider(session?.provider ?? null),
    []
  );
  const { status, deniedBy } = useDesktopChannel(provider);
  const badge: LiveObjectStatus | null =
    status?.status === "running"
      ? null
      : status?.status === "starting" || !status
        ? { label: "Starting…", live: false }
        : { label: "Stopped", live: false };

  return (
    <LiveObjectFrame
      {...props}
      kindLabel="live desktop"
      status={badge}
      showHistory={showHistory}
      onToggleHistory={setShowHistory}
      historyLabel="Back to the desktop"
      onSession={onSession}
      renderHistory={({ docId, onClose }) => (
        <Filmstrip docId={docId} onClose={onClose} />
      )}
    >
      {({ session, peers, canEdit, user }) => (
        <DesktopBody
          provider={session.provider}
          ydoc={session.ydoc}
          peers={peers}
          canDrive={canEdit}
          userId={user.id}
          status={status}
          deniedBy={deniedBy}
        />
      )}
    </LiveObjectFrame>
  );
}
