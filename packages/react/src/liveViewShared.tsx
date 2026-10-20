import type { LiveDocKind } from "@memo-air/protocol";
import type { ReactNode } from "react";
import { useContext } from "react";
import { InsideSpace } from "./AgentCursors";
import type { LiveHostDoc } from "./host";
import { useLiveHost } from "./host";
import type { CommentAgent } from "./LiveDocComments";
import {
  ActionDocumentTextIcon,
  ActionFileIcon,
  ActionGlobeIcon,
  ActionMarkPenIcon,
  ActionSlideshowIcon,
  ActionTableIcon,
  ActionTerminalIcon,
  cn,
  Headphones01,
  Laptop01,
  LayoutGrid01,
} from "./ui";
import type { LivePeer } from "./useLiveDocSession";

// Exhaustive at compile time, silent at run time: the kinds come from the server, which may
// learn a new one before this package does.
export function assertNeverAndIgnore(_value: never): void {}

export type LiveDocHeaderProps = {
  title: string;
  liveDoc: LiveHostDoc | null;
  actions: ReactNode;
};

export interface LiveDocViewProps {
  docId: string;
  agents: CommentAgent[];
  renderHeader: (header: LiveDocHeaderProps) => ReactNode;
  className?: string;
  // What a live room shows as its main area while you are in the call; other kinds ignore it.
  stage?: ReactNode;
  // Told when this person joins or leaves a live room's call; other kinds ignore it.
  onInCall?: (inCall: boolean) => void;
}

interface PresenceStackProps {
  peers: LivePeer[];
}

export function PresenceStack({ peers }: PresenceStackProps) {
  return (
    <div className="flex -space-x-1.5" aria-label="People in this doc">
      {peers.slice(0, 5).map((peer) => (
        <span
          key={peer.clientId}
          title={peer.kind === "agent" ? `✦ ${peer.name} (agent)` : peer.name}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full border-2 border-background text-xs font-semibold text-white",
            peer.kind === "agent" && "ring-2 ring-violet-400"
          )}
          style={{ backgroundColor: peer.color }}
        >
          {peer.kind === "agent" ? "✦" : peer.name.charAt(0).toUpperCase()}
        </span>
      ))}
    </div>
  );
}

export function liveDocKindLabel(kind: LiveDocKind) {
  switch (kind) {
    case "sheet":
      return "Live sheet";
    case "canvas":
      return "Live canvas";
    case "slides":
      return "Live slides";
    case "browser":
      return "Live browser";
    case "desktop":
      return "Live desktop";
    case "media":
      return "Live room";
    case "space":
      return "Live space";
    case "file":
      return "File";
    case "runner":
      return "Code runner";
    case "doc":
      return "Live doc";
    default:
      assertNeverAndIgnore(kind);
      return "Live doc";
  }
}

export function liveDocIcon(kind: LiveDocKind | undefined) {
  switch (kind) {
    case "sheet":
      return ActionTableIcon;
    case "canvas":
      return ActionMarkPenIcon;
    case "slides":
      return ActionSlideshowIcon;
    case "browser":
      return ActionGlobeIcon;
    case "desktop":
      return Laptop01;
    case "media":
      return Headphones01;
    case "space":
      return LayoutGrid01;
    case "file":
      return ActionFileIcon;
    case "runner":
      return ActionTerminalIcon;
    case "doc":
    case undefined:
      return ActionDocumentTextIcon;
    default:
      assertNeverAndIgnore(kind);
      return ActionDocumentTextIcon;
  }
}

// An object's connection state. On a desktop the space's own bar already says the room is live,
// so a window only speaks up when its connection is not.
export function LiveBadge({
  label,
  live,
  quietWhenLive = true,
}: {
  label: string;
  live: boolean;
  quietWhenLive?: boolean;
}) {
  const host = useLiveHost();
  const insideSpace = useContext(InsideSpace);
  const onDesktop = insideSpace && (host.useDock?.() ?? null) !== null;
  if (onDesktop && live && quietWhenLive) {
    return null;
  }
  return (
    <span
      className={cn(
        "whitespace-nowrap text-xs font-medium",
        live ? "text-green-600" : "text-muted-foreground"
      )}
    >
      {label}
    </span>
  );
}
