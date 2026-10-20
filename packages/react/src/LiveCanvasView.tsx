import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { PendingCanvasSuggestion } from "@memo-air/canvas";
import {
  acceptCanvasSuggestion,
  canvasElements,
  canvasSuggestions,
  ghostPrefix,
  pendingCanvasSuggestions,
  rejectCanvasSuggestion,
} from "@memo-air/canvas";
import type { ComponentType } from "react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AgentReadingMarks } from "./AgentCursors";
import { useLiveHost } from "./host";
import type { LiveCanvasBoardProps } from "./LiveCanvasBoard";
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
import { colorForId, useLiveDocSession } from "./useLiveDocSession";

const LiveCanvasBoard: ComponentType<LiveCanvasBoardProps> = lazy(
  // Dynamic import is necessary here: Excalidraw is about 1 MB and only canvas docs need it,
  // so it stays out of the main chunk.
  () => import("./LiveCanvasBoard")
);

const agentAnnouncementIntervalMs = 10_000;
const compactWidthPx = 640;

interface CanvasSuggestionCardProps {
  suggestion: PendingCanvasSuggestion;
  isActive: boolean;
  canReview: boolean;
  onSelect: () => void;
  onAccept: () => void;
  onReject: () => void;
}

function CanvasSuggestionCard({
  suggestion,
  isActive,
  canReview,
  onSelect,
  onAccept,
  onReject,
}: CanvasSuggestionCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onSelect();
        }
      }}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-2.5 text-xs",
        isActive
          ? "border-highlight-300 bg-highlight-50 dark:border-highlight-700 dark:bg-highlight-900"
          : "border-border bg-background dark:border-border-night dark:bg-background-night"
      )}
    >
      <div className="font-medium text-foreground dark:text-foreground-night">
        ✦ {suggestion.actorName} suggests
        {suggestion.approver && (
          <span className="font-normal text-muted-foreground dark:text-muted-foreground-night">
            {" "}
            · needs {suggestion.approver}
          </span>
        )}
      </div>
      {suggestion.changes.slice(0, 5).map((change) => (
        <div key={change.id} className="flex items-baseline gap-1.5">
          <span className="text-muted-foreground dark:text-muted-foreground-night">
            {change.kind === "added"
              ? "Add"
              : change.kind === "removed"
                ? "Remove"
                : "Change"}
          </span>
          <span
            className={cn(
              change.kind === "removed"
                ? "text-muted-foreground line-through dark:text-muted-foreground-night"
                : "text-green-700 dark:text-green-400"
            )}
          >
            {change.label}
          </span>
        </div>
      ))}
      {suggestion.changes.length > 5 && (
        <div className="text-muted-foreground dark:text-muted-foreground-night">
          and {suggestion.changes.length - 5} more shapes
        </div>
      )}
      {suggestion.stale && (
        <div className="text-warning-600 dark:text-warning-400">
          These shapes changed since the suggestion was made.
        </div>
      )}
      {canReview && (
        <div className="flex gap-1.5">
          <Button
            size="xs"
            variant="primary"
            label="Accept"
            tooltip="Accept (⌥↵)"
            onClick={(event) => {
              event.stopPropagation();
              onAccept();
            }}
          />
          <Button
            size="xs"
            variant="outline"
            label="Reject"
            tooltip="Reject (⌥⌫)"
            onClick={(event) => {
              event.stopPropagation();
              onReject();
            }}
          />
        </div>
      )}
    </div>
  );
}

// A live canvas or deck: Excalidraw bound to the doc, suggestion cards, history and sharing.
export function LiveCanvasView({
  docId,
  renderHeader,
  className,
}: LiveDocViewProps) {
  const host = useLiveHost();
  const user = host.useUser();
  const isDark = host.useIsDark();
  const { connection, isLiveDocLoading, isLiveDocError } = host.useConnection({
    docId,
  });
  const fetchToken = host.useFetchToken(docId);
  const { session, isConnected, hasSynced, peers } = useLiveDocSession({
    url: connection?.url,
    docId,
    fetchToken,
  });
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [suggestions, setSuggestions] = useState<PendingCanvasSuggestion[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isCompact, setIsCompact] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncedAtRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const canEdit = connection?.access === "write";
  const title = connection?.liveDoc.title ?? "Live canvas";
  const localUser = useMemo(
    () =>
      user
        ? { id: user.id, name: user.name, color: colorForId(user.id) }
        : null,
    [user]
  );
  const actor = useMemo(
    () =>
      localUser
        ? { kind: "human" as const, id: localUser.id, name: localUser.name }
        : undefined,
    [localUser]
  );

  useEffect(() => {
    if (!session) {
      return;
    }
    const elements = canvasElements(session.ydoc);
    const pending = canvasSuggestions(session.ydoc);
    const refresh = () => {
      setSuggestions(pendingCanvasSuggestions(session.ydoc));
    };
    refresh();
    elements.observe(refresh);
    pending.observe(refresh);
    return () => {
      elements.unobserve(refresh);
      pending.unobserve(refresh);
    };
  }, [session]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const observer = new ResizeObserver(([entry]) =>
      setIsCompact(entry.contentRect.width < compactWidthPx)
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const drawingAgent = peers.find(
    (peer) => peer.kind === "agent" && peer.pointer
  );
  const drawingAgentName = drawingAgent?.name ?? "";

  useEffect(() => {
    const now = Date.now();
    if (
      !drawingAgentName ||
      now - lastAnnouncedAtRef.current < agentAnnouncementIntervalMs
    ) {
      return;
    }
    lastAnnouncedAtRef.current = now;
    setAnnouncement(`${drawingAgentName} drawing on the canvas`);
  }, [drawingAgentName]);

  const showSuggestion = (suggestion: PendingCanvasSuggestion) => {
    setActiveId(suggestion.id);
    const ids = new Set(
      Object.keys(suggestion.after).map((id) => `${ghostPrefix}${id}`)
    );
    const ghosts = api
      ?.getSceneElements()
      .filter((element) => ids.has(element.id));
    if (api && ghosts?.length) {
      api.scrollToContent(ghosts, { fitToContent: true, animate: true });
    }
  };

  const reviewNext = () => {
    if (suggestions.length === 0) {
      return;
    }
    const at = suggestions.findIndex((s) => s.id === activeId);
    showSuggestion(suggestions[(at + 1) % suggestions.length]);
  };

  const accept = (id: string) =>
    session && acceptCanvasSuggestion(session.ydoc, id, actor);
  const reject = (id: string) =>
    session && rejectCanvasSuggestion(session.ydoc, id);

  const actions = (
    <div className="flex items-center gap-2 pr-1">
      <LiveBadge
        label={
          !hasSynced ? "Connecting…" : isConnected ? "● Live" : "Reconnecting…"
        }
        live={isConnected && hasSynced}
      />
      <AgentReadingMarks peers={peers} />
      <PresenceStack peers={peers} />
      {suggestions.length > 0 && (
        <Button
          size="xs"
          variant="outline"
          label={`Review ${suggestions.length}`}
          tooltip="Go to the next suggestion"
          onClick={() => {
            setShowHistory(false);
            reviewNext();
          }}
        />
      )}
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
            <DropdownMenuItem
              label={showHistory ? "Back to the canvas" : "History"}
              onClick={() => setShowHistory((shown) => !shown)}
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

  const cards = suggestions.map((suggestion) => (
    <CanvasSuggestionCard
      key={suggestion.id}
      suggestion={suggestion}
      isActive={suggestion.id === activeId}
      canReview={canEdit}
      onSelect={() => showSuggestion(suggestion)}
      onAccept={() => accept(suggestion.id)}
      onReject={() => reject(suggestion.id)}
    />
  ));

  return (
    <div
      ref={rootRef}
      className={cn(
        "flex min-h-0 flex-col bg-background dark:bg-background-night",
        className
      )}
      onKeyDown={(event) => {
        if (!activeId || !event.altKey) {
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          accept(activeId);
        } else if (event.key === "Backspace") {
          event.preventDefault();
          reject(activeId);
        }
      }}
    >
      {renderHeader({ title, liveDoc: connection?.liveDoc ?? null, actions })}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {(isLiveDocLoading || (session && !hasSynced)) && (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      )}
      {isLiveDocError && (
        <div className="p-6 text-sm text-muted-foreground">
          This live canvas is not available to you.
        </div>
      )}
      {session && connection && hasSynced && localUser && (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {showHistory && (
            <LiveDocHistory
              docId={docId}
              canWrite={canEdit}
              onClose={() => setShowHistory(false)}
            />
          )}
          <div
            className={cn(
              "flex min-h-0 flex-1",
              isCompact ? "flex-col" : "flex-row",
              showHistory && "hidden"
            )}
          >
            {isCompact && cards.length > 0 && (
              <div className="flex max-h-48 flex-col gap-2 overflow-y-auto border-b border-border p-2 dark:border-border-night">
                {cards}
              </div>
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="relative min-h-[320px] flex-1">
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center">
                      <Spinner />
                    </div>
                  }
                >
                  <LiveCanvasBoard
                    ydoc={session.ydoc}
                    provider={session.provider}
                    peers={peers}
                    canEdit={canEdit}
                    isDark={isDark}
                    user={localUser}
                    onApi={setApi}
                  />
                </Suspense>
              </div>
            </div>
            {!isCompact && cards.length > 0 && (
              <div className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto border-l border-border p-2 dark:border-border-night">
                {cards}
              </div>
            )}
          </div>
          {drawingAgent?.pointer && !showHistory && (
            <Button
              className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-md"
              size="sm"
              variant="outline"
              label={`✦ ${drawingAgent.name} drawing ↓`}
              onClick={() =>
                drawingAgent.pointer &&
                api?.scrollToContent(
                  api
                    .getSceneElements()
                    .filter(
                      (element) =>
                        drawingAgent.pointer &&
                        element.x <= drawingAgent.pointer.x &&
                        element.x + element.width >= drawingAgent.pointer.x &&
                        element.y <= drawingAgent.pointer.y &&
                        element.y + element.height >= drawingAgent.pointer.y
                    ),
                  { fitToContent: true, animate: true }
                )
              }
            />
          )}
        </div>
      )}
      {host.renderShare?.({
        docId,
        title,
        isOpen: showShare,
        onClose: () => setShowShare(false),
      })}
    </div>
  );
}
