import type {
  DeckEditor,
  LayoutId,
  PendingSlideSuggestion,
} from "@memo-air/slides";
import {
  acceptSlideSuggestion,
  addSlide,
  deckThemes,
  deleteSlide,
  layoutIds,
  moveSlide,
  rejectSlideSuggestion,
  setTheme,
  slideHeight,
  slideWidth,
  themeIds,
  updateSlide,
} from "@memo-air/slides";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { AgentReadingMarks } from "./AgentCursors";
import { useLiveHost } from "./host";
import { LiveDocHistory } from "./LiveDocHistory";
import type { LiveDocViewProps } from "./liveViewShared";
import { LiveBadge, PresenceStack } from "./liveViewShared";
import { SlideStage } from "./SlideStage";
import { StaticSlide } from "./slideRender";
import {
  ArrowDown,
  ArrowUp,
  Button,
  cn,
  DotsHorizontal,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Plus,
  Spinner,
  Trash03,
} from "./ui";
import type { DeckState } from "./useDeck";
import { useDeck } from "./useDeck";
import { colorForId, useLiveDocSession } from "./useLiveDocSession";

const followSlideIdleMs = 5000;
const compactWidthPx = 720;
const thumbnailWidthPx = 152;
const agentAnnouncementIntervalMs = 10_000;

const layoutNames: Record<LayoutId, string> = {
  title: "Title",
  title_bullets: "Title and bullets",
  section: "Section",
  two_column: "Two columns",
  chart_takeaway: "Chart and takeaway",
  image_full: "Full image",
  quote: "Quote",
  closing: "Closing",
};

interface SuggestionCardProps {
  suggestion: PendingSlideSuggestion;
  isActive: boolean;
  canReview: boolean;
  onSelect: () => void;
  onAccept: () => void;
  onReject: () => void;
}

function SlideSuggestionCard({
  suggestion,
  isActive,
  canReview,
  onSelect,
  onAccept,
  onReject,
}: SuggestionCardProps) {
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
          ? "border-highlight-500 ring-1 ring-highlight-500"
          : "border-border dark:border-border-night",
        "bg-background dark:bg-background-night"
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
      {suggestion.lines.slice(0, 6).map((line, i) => (
        <div key={`${line.label}-${i}`} className="flex items-baseline gap-1.5">
          <span className="shrink-0 text-muted-foreground dark:text-muted-foreground-night">
            {line.kind}
          </span>
          <span
            className={cn(
              "line-clamp-2",
              line.kind === "removed"
                ? "text-muted-foreground line-through dark:text-muted-foreground-night"
                : "text-green-700 dark:text-green-400"
            )}
          >
            {line.label}
          </span>
        </div>
      ))}
      {suggestion.stale && (
        <div className="text-warning-600 dark:text-warning-400">
          Things changed since the suggestion was made.
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

interface SlideStripProps {
  state: DeckState;
  current: number;
  canEdit: boolean;
  compact: boolean;
  actor: DeckEditor;
  ydoc: Y.Doc;
  onSelect: (index: number) => void;
}

function SlideStrip({
  state,
  current,
  canEdit,
  compact,
  actor,
  ydoc,
  onSelect,
}: SlideStripProps) {
  const { slides } = state.deck;
  const scale = thumbnailWidthPx / slideWidth;
  // Slides an agent proposed but nobody has accepted yet.
  const proposed = state.suggestions.flatMap((suggestion) =>
    suggestion.changes.flatMap((change) =>
      change.type === "add_slide"
        ? [
            {
              key: `${suggestion.id}-${change.slideId}`,
              suggestion,
              elements: change.elements.map((element) => ({
                ...element,
                by: null,
              })),
            },
          ]
        : []
    )
  );
  return (
    <nav
      aria-label="Slides"
      className={cn(
        "flex shrink-0 gap-2 overflow-auto border-border bg-muted-background/40 p-2 dark:border-border-night dark:bg-muted-background-night/40",
        compact ? "flex-row border-b" : "w-48 flex-col border-r"
      )}
    >
      {slides.map((slide, i) => (
        <div key={slide.id} className="group relative shrink-0">
          <button
            type="button"
            aria-current={i === current}
            aria-label={`Slide ${slide.number}: ${slide.title}`}
            onClick={() => onSelect(i)}
            className={cn(
              "flex flex-col items-start gap-1 rounded-lg p-1 text-left",
              i === current
                ? "ring-2 ring-highlight-500"
                : "hover:bg-muted-background dark:hover:bg-muted-background-night",
              slide.hidden && "opacity-50"
            )}
          >
            <StaticSlide
              elements={slide.elements}
              blocks={state.blocks}
              theme={state.theme}
              scale={scale}
              className="rounded-sm ring-1 ring-black/10"
            />
            <span className="flex w-full items-center gap-1 text-xs text-muted-foreground dark:text-muted-foreground-night">
              <span className="font-medium">{slide.number}</span>
              <span className="truncate">{slide.title}</span>
            </span>
          </button>
          {canEdit && (
            <span className="absolute right-2 top-2 hidden gap-0.5 rounded-md bg-background/90 shadow-sm group-focus-within:flex group-hover:flex dark:bg-background-night/90">
              <Button
                size="xmini"
                variant="ghost"
                icon={ArrowUp}
                aria-label="Move slide up"
                disabled={i === 0}
                onClick={() => moveSlide(ydoc, slide.id, i, { actor })}
              />
              <Button
                size="xmini"
                variant="ghost"
                icon={ArrowDown}
                aria-label="Move slide down"
                disabled={i === slides.length - 1}
                onClick={() => moveSlide(ydoc, slide.id, i + 2, { actor })}
              />
              <Button
                size="xmini"
                variant="ghost"
                icon={Trash03}
                aria-label="Delete slide"
                onClick={() => deleteSlide(ydoc, slide.id, { actor })}
              />
            </span>
          )}
        </div>
      ))}
      {proposed.map(({ key, suggestion, elements }) => (
        <div
          key={key}
          className="flex shrink-0 flex-col gap-1 rounded-lg border-2 border-dashed border-green-500 p-1"
          title={`Proposed by ${suggestion.actorName}`}
        >
          <StaticSlide
            elements={elements}
            blocks={new Map()}
            theme={state.theme}
            scale={scale}
            className="rounded-sm opacity-70"
          />
          <span className="text-xs text-green-700 dark:text-green-400">
            ✦ Proposed
          </span>
        </div>
      ))}
      {canEdit && (
        <Button
          size="xs"
          variant="ghost"
          icon={Plus}
          label="Add slide"
          onClick={() => {
            addSlide(
              ydoc,
              { layout: "title_bullets", title: "New slide" },
              { actor }
            );
            onSelect(slides.length);
          }}
        />
      )}
    </nav>
  );
}

interface PresentProps {
  state: DeckState;
  start: number;
  onExit: () => void;
}

// Full-screen presentation: one slide at a time, scaled to fit, arrows to step, Esc to leave.
function Present({ state, start, onExit }: PresentProps) {
  const visible = useMemo(
    () => state.deck.slides.filter((slide) => !slide.hidden),
    [state]
  );
  const [index, setIndex] = useState(
    Math.max(
      0,
      visible.findIndex((slide) => slide.number === start + 1)
    )
  );
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void rootRef.current?.requestFullscreen?.().catch(() => undefined);
    let entered = false;
    const onFullscreen = () => {
      if (document.fullscreenElement) {
        entered = true;
      } else if (entered) {
        onExit();
      }
    };
    const onResize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
        setIndex((i) => Math.min(i + 1, visible.length - 1));
      } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      } else if (event.key === "Escape") {
        onExit();
      }
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreen);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [visible.length, onExit]);

  const slide = visible[index];
  const scale = Math.min(
    viewport.width / slideWidth,
    viewport.height / slideHeight
  );
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black"
      onClick={() => setIndex((i) => Math.min(i + 1, visible.length - 1))}
    >
      {slide && (
        <StaticSlide
          elements={slide.elements}
          blocks={state.blocks}
          theme={state.theme}
          scale={scale}
        />
      )}
      <div className="absolute bottom-4 right-4 flex items-center gap-2 text-xs text-white/70">
        {index + 1} / {visible.length}
        <Button
          size="xs"
          variant="outline"
          label="Exit"
          onClick={(event) => {
            event.stopPropagation();
            onExit();
          }}
        />
      </div>
    </div>
  );
}

// Live slides: a designed deck (themes, layouts, positioned HTML elements) people and agents edit.
export function LiveSlidesView({
  docId,
  renderHeader,
  className,
}: LiveDocViewProps) {
  const host = useLiveHost();
  const user = host.useUser();
  const { connection, isLiveDocLoading, isLiveDocError } = host.useConnection({
    docId,
  });
  const fetchToken = host.useFetchToken(docId);
  const { session, isConnected, hasSynced, peers } = useLiveDocSession({
    url: connection?.url,
    docId,
    fetchToken,
  });
  const state = useDeck(hasSynced ? session : null);
  const downloadPptx = host.useDownloadFile({ docId, format: "pptx" });
  const [current, setCurrent] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isCompact, setIsCompact] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncedAtRef = useRef(0);
  const lastTouchedAtRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const canEdit = connection?.access === "write";
  const title = connection?.liveDoc.title ?? "Live slides";
  const actor = useMemo<DeckEditor | null>(
    () => (user ? { kind: "human", id: user.id, name: user.name } : null),
    [user]
  );

  useEffect(() => {
    if (session && user) {
      session.provider.setAwarenessField("user", {
        id: user.id,
        name: user.name,
        color: colorForId(user.id),
        kind: "human",
      });
    }
  }, [session, user]);

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

  const slides = state?.deck.slides ?? [];
  const slide = slides[Math.min(current, Math.max(slides.length - 1, 0))];
  const suggestions = state?.suggestions ?? [];
  const writingAgent = peers.find(
    (peer) => peer.kind === "agent" && peer.slide
  );
  const writingAgentName = writingAgent?.name ?? "";
  const agentSlideId = writingAgent?.slide?.slideId ?? null;

  // A deck draws an agent's cursor only on the slide on screen, so a viewer who is not working
  // in the deck is taken to the slide the agent is on.
  useEffect(() => {
    if (
      !agentSlideId ||
      Date.now() - lastTouchedAtRef.current < followSlideIdleMs
    ) {
      return;
    }
    const at = slides.findIndex((each) => each.id === agentSlideId);
    if (at >= 0) {
      setCurrent(at);
    }
  }, [agentSlideId, slides]);

  useEffect(() => {
    const now = Date.now();
    if (
      !writingAgentName ||
      now - lastAnnouncedAtRef.current < agentAnnouncementIntervalMs
    ) {
      return;
    }
    lastAnnouncedAtRef.current = now;
    setAnnouncement(`${writingAgentName} editing the slides`);
  }, [writingAgentName]);

  const accept = (id: string) =>
    session && actor && acceptSlideSuggestion(session.ydoc, id, actor);
  const reject = (id: string) =>
    session && rejectSlideSuggestion(session.ydoc, id);

  const selectSuggestion = (suggestion: PendingSlideSuggestion) => {
    setActiveId(suggestion.id);
    const slideId = suggestion.lines.find((line) => line.slideId)?.slideId;
    const at = slides.findIndex((s) => s.id === slideId);
    if (at >= 0) {
      setCurrent(at);
    }
  };

  const reviewNext = () => {
    if (suggestions.length === 0) {
      return;
    }
    const at = suggestions.findIndex((s) => s.id === activeId);
    selectSuggestion(suggestions[(at + 1) % suggestions.length]);
  };

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
      {slides.length > 0 && (
        <Button
          size="xs"
          variant="outline"
          label="Present"
          onClick={() => setPresenting(true)}
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
            {canEdit && actor && (
              <>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger label="Theme" />
                  <DropdownMenuSubContent>
                    {themeIds.map((id) => (
                      <DropdownMenuItem
                        key={id}
                        label={`${deckThemes[id].name}${state?.deck.theme.themeId === id ? " ✓" : ""}`}
                        onClick={() =>
                          setTheme(session.ydoc, { themeId: id }, { actor })
                        }
                      />
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {slide && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger label="Layout" />
                    <DropdownMenuSubContent>
                      {layoutIds.map((id) => (
                        <DropdownMenuItem
                          key={id}
                          label={`${layoutNames[id]}${slide.layout === id ? " ✓" : ""}`}
                          onClick={() =>
                            updateSlide(
                              session.ydoc,
                              { slide: slide.id, layout: id },
                              { actor }
                            )
                          }
                        />
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {slide && (
                  <DropdownMenuItem
                    label={
                      slide.hidden
                        ? "Show slide when presenting"
                        : "Skip slide when presenting"
                    }
                    onClick={() =>
                      updateSlide(
                        session.ydoc,
                        { slide: slide.id, hidden: !slide.hidden },
                        { actor }
                      )
                    }
                  />
                )}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              label={showHistory ? "Back to the slides" : "History"}
              onClick={() => setShowHistory((shown) => !shown)}
            />
            {connection?.canShare && host.renderShare && (
              <DropdownMenuItem
                label="Share"
                onClick={() => setShowShare(true)}
              />
            )}
            <DropdownMenuItem
              label="Export as PowerPoint"
              onClick={() => void downloadPptx(title)}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  const cards = suggestions.map((suggestion) => (
    <SlideSuggestionCard
      key={suggestion.id}
      suggestion={suggestion}
      isActive={suggestion.id === activeId}
      canReview={canEdit}
      onSelect={() => selectSuggestion(suggestion)}
      onAccept={() => accept(suggestion.id)}
      onReject={() => reject(suggestion.id)}
    />
  ));

  return (
    <div
      ref={rootRef}
      className={cn("flex min-h-0 flex-col", className)}
      onPointerDownCapture={() => {
        lastTouchedAtRef.current = Date.now();
      }}
      onKeyDownCapture={() => {
        lastTouchedAtRef.current = Date.now();
      }}
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
      {(isLiveDocLoading || (session && !state)) && (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      )}
      {isLiveDocError && (
        <div className="p-6 text-sm text-muted-foreground">
          These live slides are not available to you.
        </div>
      )}
      {session && state && actor && (
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
            <SlideStrip
              state={state}
              current={current}
              canEdit={canEdit}
              compact={isCompact}
              actor={actor}
              ydoc={session.ydoc}
              onSelect={setCurrent}
            />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted-background/30 dark:bg-muted-background-night/30">
              {isCompact && cards.length > 0 && (
                <div className="flex max-h-40 flex-col gap-2 overflow-y-auto border-b border-border p-2 dark:border-border-night">
                  {cards}
                </div>
              )}
              <div className="min-h-[240px] flex-1 p-4">
                {slide ? (
                  <SlideStage
                    key={slide.id}
                    session={session}
                    state={state}
                    slideId={slide.id}
                    canEdit={canEdit}
                    actor={actor}
                    peers={peers}
                    activeSuggestionId={activeId}
                    onSelectSuggestion={(id) => setActiveId(id)}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    No slides yet.
                  </div>
                )}
              </div>
              {slide && (
                <label className="flex shrink-0 flex-col gap-1 border-t border-border px-3 py-2 focus-within:bg-muted-background dark:border-border-night dark:focus-within:bg-muted-background-night">
                  <span className="text-xs font-medium text-muted-foreground dark:text-muted-foreground-night">
                    Speaker notes · slide {slide.number}
                  </span>
                  <textarea
                    key={slide.id}
                    placeholder="What to say on this slide"
                    readOnly={!canEdit}
                    defaultValue={slide.notes}
                    onBlur={(event) => {
                      if (event.target.value !== slide.notes) {
                        updateSlide(
                          session.ydoc,
                          { slide: slide.id, notes: event.target.value },
                          { actor }
                        );
                      }
                    }}
                    className="h-14 resize-none border-0 bg-transparent p-0 text-sm text-foreground shadow-none outline-none focus:ring-0 dark:text-foreground-night"
                  />
                </label>
              )}
            </div>
            {!isCompact && cards.length > 0 && (
              <div className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto border-l border-border p-2 dark:border-border-night">
                {cards}
              </div>
            )}
          </div>
          {presenting && (
            <Present
              state={state}
              start={current}
              onExit={() => setPresenting(false)}
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
