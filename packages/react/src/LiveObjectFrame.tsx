import type { LiveAccess } from "@memo-air/protocol";
import type { ReactNode } from "react";
import { useContext, useEffect, useRef, useState } from "react";
import { AgentCursors, AgentReadingMarks, InsideSpace } from "./AgentCursors";
import type { LiveHostDoc, LiveHostUser } from "./host";
import { useLiveHost } from "./host";
import { LiveDocHistory } from "./LiveDocHistory";
import type { LiveDocViewProps } from "./liveViewShared";
import { LiveBadge, PresenceStack } from "./liveViewShared";
import {
  Button,
  cn,
  DotsHorizontal,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
} from "./ui";
import type { LiveDocSession, LivePeer } from "./useLiveDocSession";
import { colorForId, useLiveDocSession } from "./useLiveDocSession";

export type LiveObjectContext = {
  session: LiveDocSession;
  peers: LivePeer[];
  access: LiveAccess;
  canEdit: boolean;
  user: LiveHostUser;
  liveDoc: LiveHostDoc;
  isConnected: boolean;
};

export type LiveObjectStatus = { label: string; live: boolean };

interface LiveObjectFrameProps extends LiveDocViewProps {
  kindLabel: string;
  status?: LiveObjectStatus | null;
  headerExtras?: ReactNode;
  menuItems?: { label: string; onClick: () => void }[];
  showHistory: boolean;
  onToggleHistory: (shown: boolean) => void;
  historyLabel?: string;
  renderHistory?: (context: {
    docId: string;
    canWrite: boolean;
    onClose: () => void;
  }) => ReactNode;
  // Lets a kind subscribe to the session (its stateless channel) above the body's render.
  onSession?: (session: LiveDocSession | null) => void;
  children: (context: LiveObjectContext) => ReactNode;
}

// The shell every live object shares: the connection and its token, the session, the "● Live"
// badge, who is here, the ⋯ menu with History and Share, loading and error states. A kind only
// renders its body, so a new kind is its body and nothing else.
export function LiveObjectFrame({
  docId,
  renderHeader,
  className,
  kindLabel,
  status,
  headerExtras,
  menuItems = [],
  showHistory,
  onToggleHistory,
  historyLabel,
  renderHistory,
  onSession,
  children,
}: LiveObjectFrameProps) {
  const host = useLiveHost();
  const user = host.useUser();
  const insideSpace = useContext(InsideSpace);
  const rootRef = useRef<HTMLDivElement>(null);
  const { connection, isLiveDocLoading, isLiveDocError } = host.useConnection({
    docId,
  });
  const fetchToken = host.useFetchToken(docId);
  const { session, isConnected, hasSynced, peers } = useLiveDocSession({
    url: connection?.url,
    docId,
    fetchToken,
  });
  const [showShare, setShowShare] = useState(false);

  const provider = session?.provider ?? null;
  useEffect(() => {
    onSession?.(session);
    return () => onSession?.(null);
  }, [session, onSession]);
  useEffect(() => {
    if (!provider || !user) {
      return;
    }
    provider.setAwarenessField("user", {
      id: user.id,
      name: user.name,
      color: colorForId(user.id),
      kind: "human",
    });
  }, [provider, user]);

  const access = connection?.access ?? "read";
  const canEdit = access === "write";
  const title = connection?.liveDoc.title ?? kindLabel;
  const badge: LiveObjectStatus = !hasSynced
    ? { label: "Connecting…", live: false }
    : !isConnected
      ? { label: "Reconnecting…", live: false }
      : (status ?? { label: "● Live", live: true });

  const actions = (
    <div className="flex items-center gap-2 pr-1">
      <LiveBadge
        label={badge.label}
        live={badge.live}
        quietWhenLive={!status}
      />
      {/* A space's own bar is not an object to look at; its windows show their reading. */}
      {kindLabel !== "space" && <AgentReadingMarks peers={peers} />}
      <PresenceStack peers={peers} />
      {headerExtras}
      {session && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              size="xs"
              variant="ghost"
              icon={DotsHorizontal}
              aria-label="More"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {menuItems.map((item) => (
              <DropdownMenuItem
                key={item.label}
                label={item.label}
                onClick={item.onClick}
              />
            ))}
            <DropdownMenuItem
              label={
                showHistory
                  ? (historyLabel ?? `Back to the ${kindLabel}`)
                  : "History"
              }
              onClick={() => onToggleHistory(!showHistory)}
            />
            {connection?.canShare && host.renderShare && (
              <DropdownMenuItem
                label="Share"
                onClick={() => setShowShare(true)}
              />
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      data-object-title={title}
      className={cn(
        "relative flex min-h-0 flex-col bg-background dark:bg-background-night",
        className
      )}
    >
      {!insideSpace && <AgentCursors containerRef={rootRef} />}
      {renderHeader({ title, liveDoc: connection?.liveDoc ?? null, actions })}
      {(isLiveDocLoading || (session && !hasSynced)) && (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      )}
      {isLiveDocError && (
        <div className="p-6 text-sm text-muted-foreground">
          This {kindLabel} is not available to you.
        </div>
      )}
      {session &&
        connection &&
        hasSynced &&
        user &&
        (showHistory
          ? (renderHistory?.({
              docId,
              canWrite: canEdit,
              onClose: () => onToggleHistory(false),
            }) ?? (
              <LiveDocHistory
                docId={docId}
                canWrite={canEdit}
                onClose={() => onToggleHistory(false)}
              />
            ))
          : children({
              session,
              peers,
              access,
              canEdit,
              user,
              liveDoc: connection.liveDoc,
              isConnected,
            }))}
      {host.renderShare?.({
        docId,
        title,
        isOpen: showShare,
        onClose: () => setShowShare(false),
      })}
    </div>
  );
}
