import type { CommentThread, Suggestion } from "@memo-air/richtext";
import {
  acceptSuggestion,
  docFragment,
  readOutline,
  rejectSuggestion,
  setThreadResolved,
} from "@memo-air/richtext";
import type { RefObject } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLiveHost } from "./host";
import type { CommentAgent } from "./LiveDocComments";
import {
  mentionedAgent,
  NewThreadCard,
  SuggestionCard,
  ThreadCard,
} from "./LiveDocComments";
import { Button, cn, Icon, MessageSquare01 } from "./ui";
import type { LiveDocSession } from "./useLiveDocSession";

const cardGapPx = 8;
const draftKey = "draft";
const fallbackCardHeightPx = 72;

export type FocusedBlock = { blockId: string; quote: string };

export type ReviewItem =
  | {
      key: string;
      kind: "suggestion";
      anchorBlockId: string;
      suggestion: Suggestion;
    }
  | {
      key: string;
      kind: "thread";
      anchorBlockId: string;
      thread: CommentThread;
    };

// Every open suggestion and thread, in document order, anchored to the block it is about.
export function reviewItems(
  session: LiveDocSession,
  suggestions: Suggestion[],
  threads: CommentThread[]
): ReviewItem[] {
  const outline = readOutline(docFragment(session.ydoc));
  const order = new Map(outline.map((block, index) => [block.blockId, index]));
  const suggestionAnchors = new Map<string, string>();
  for (const block of outline) {
    if (block.suggestion && !suggestionAnchors.has(block.suggestion.id)) {
      suggestionAnchors.set(block.suggestion.id, block.blockId);
    }
  }
  const items: ReviewItem[] = [
    ...suggestions.flatMap((suggestion): ReviewItem[] => {
      const anchorBlockId = suggestionAnchors.get(suggestion.id);
      return anchorBlockId
        ? [
            {
              key: `s:${suggestion.id}`,
              kind: "suggestion",
              anchorBlockId,
              suggestion,
            },
          ]
        : [];
    }),
    ...threads
      .filter((thread) => !thread.resolved && !thread.detached)
      .map(
        (thread): ReviewItem => ({
          key: `t:${thread.id}`,
          kind: "thread",
          anchorBlockId: thread.blockId,
          thread,
        })
      ),
  ];
  return items.sort(
    (a, b) =>
      (order.get(a.anchorBlockId) ?? 0) - (order.get(b.anchorBlockId) ?? 0)
  );
}

export function blockElement(
  root: HTMLElement | null,
  blockId: string
): HTMLElement | null {
  const element = root?.querySelector(`[data-id="${CSS.escape(blockId)}"]`);
  return element instanceof HTMLElement ? element : null;
}

// Cards sit at their anchor block, pushed down so none overlaps the one above; the active card
// keeps its anchor and its neighbours make room above and below it.
function layoutTops(
  anchors: number[],
  heights: number[],
  activeIndex: number
): number[] {
  const tops = [...anchors];
  const start = activeIndex >= 0 ? activeIndex : 0;
  for (let i = start + 1; i < tops.length; i++) {
    tops[i] = Math.max(anchors[i], tops[i - 1] + heights[i - 1] + cardGapPx);
  }
  for (let i = start - 1; i >= 0; i--) {
    tops[i] = Math.min(anchors[i], tops[i + 1] - heights[i] - cardGapPx);
  }
  const overflow = tops.length > 0 ? Math.max(0, -tops[0]) : 0;
  return tops.map((top) => top + overflow);
}

interface LiveDocMarginProps {
  docId: string;
  session: LiveDocSession;
  items: ReviewItem[];
  detachedThreads: CommentThread[];
  wrapperRef: RefObject<HTMLDivElement | null>;
  focusedBlock: FocusedBlock | null;
  activeKey: string | null;
  onActiveChange: (key: string | null) => void;
  agents: CommentAgent[];
  canReview: boolean;
  canComment: boolean;
  compact: boolean;
  addThread: (thread: {
    blockId: string;
    quote: string;
    body: string;
  }) => Promise<string | null>;
  reply: (threadId: string, body: string) => Promise<void>;
}

export function LiveDocMargin({
  docId,
  session,
  items,
  detachedThreads,
  wrapperRef,
  focusedBlock,
  activeKey,
  onActiveChange,
  agents,
  canReview,
  canComment,
  compact,
  addThread,
  reply,
}: LiveDocMarginProps) {
  const fragment = docFragment(session.ydoc);
  const postMention = useLiveHost().usePostMention(docId);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [draft, setDraft] = useState<FocusedBlock | null>(null);
  const [anchors, setAnchors] = useState<Record<string, number>>({});
  const [tops, setTops] = useState<Record<string, number>>({});
  const [showDetached, setShowDetached] = useState(false);

  const [endTop, setEndTop] = useState(0);
  const placed = useMemo(
    () => [
      ...items.map(({ key, anchorBlockId }) => ({ key, anchorBlockId })),
      ...(draft ? [{ key: draftKey, anchorBlockId: draft.blockId }] : []),
    ],
    [items, draft]
  );

  const measure = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }
    const baseTop = wrapper.getBoundingClientRect().top;
    const anchorOf = (blockId: string) =>
      (blockElement(wrapper, blockId)?.getBoundingClientRect().top ?? baseTop) -
      baseTop;
    const ordered = [...placed].sort(
      (a, b) => anchorOf(a.anchorBlockId) - anchorOf(b.anchorBlockId)
    );
    const anchorTops = ordered.map((item) => anchorOf(item.anchorBlockId));
    const heights = ordered.map(
      (item) =>
        cardRefs.current.get(item.key)?.offsetHeight ?? fallbackCardHeightPx
    );
    const focusKey = draft ? draftKey : activeKey;
    const laidOut = layoutTops(
      anchorTops,
      heights,
      ordered.findIndex((item) => item.key === focusKey)
    );
    const nextAnchors = Object.fromEntries(
      ordered.map((item, i) => [item.key, anchorTops[i]])
    );
    const nextTops = Object.fromEntries(
      ordered.map((item, i) => [item.key, laidOut[i]])
    );
    if (focusedBlock) {
      nextAnchors.focus = anchorOf(focusedBlock.blockId);
    }
    setAnchors((previous) =>
      JSON.stringify(previous) === JSON.stringify(nextAnchors)
        ? previous
        : nextAnchors
    );
    setTops((previous) =>
      JSON.stringify(previous) === JSON.stringify(nextTops)
        ? previous
        : nextTops
    );
    setEndTop(
      laidOut.reduce(
        (end, top, i) => Math.max(end, top + heights[i] + cardGapPx),
        0
      )
    );
  }, [placed, activeKey, draft, focusedBlock, wrapperRef]);

  useLayoutEffect(measure);

  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const wrapper = wrapperRef.current;
    const resize = new ResizeObserver(schedule);
    if (wrapper) {
      resize.observe(wrapper);
    }
    fragment.observeDeep(schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      fragment.unobserveDeep(schedule);
    };
  }, [fragment, measure, wrapperRef]);

  const agentHint = agents.length
    ? ` Mention @${agents[0].name} to ask the agent.`
    : "";

  const askAgent = async (
    body: string,
    thread: { id: string; blockId: string; quote: string }
  ) => {
    const agent = mentionedAgent(body, agents);
    if (agent && postMention) {
      await postMention({
        agentConfigurationId: agent.configurationId,
        threadId: thread.id,
        blockId: thread.blockId,
        quote: thread.quote,
        body,
      });
    }
  };

  const cardFor = (item: ReviewItem) =>
    item.kind === "suggestion" ? (
      <SuggestionCard
        suggestion={item.suggestion}
        isActive={activeKey === item.key}
        canReview={canReview}
        onActivate={() => onActiveChange(item.key)}
        onAccept={() => acceptSuggestion(fragment, item.suggestion.id)}
        onReject={() => rejectSuggestion(fragment, item.suggestion.id)}
      />
    ) : (
      <ThreadCard
        thread={item.thread}
        isActive={activeKey === item.key}
        canComment={canComment}
        agentHint={agentHint}
        onActivate={() => onActiveChange(item.key)}
        onReply={async (body) => {
          await reply(item.thread.id, body);
          await askAgent(body, item.thread);
        }}
        onResolve={
          canReview
            ? () => {
                setThreadResolved(session.ydoc, item.thread.id, true);
                onActiveChange(null);
              }
            : undefined
        }
      />
    );

  const draftCard = draft && (
    <NewThreadCard
      quote={draft.quote}
      agentHint={agentHint}
      onCancel={() => setDraft(null)}
      onSubmit={async (body) => {
        const threadId = await addThread({
          blockId: draft.blockId,
          quote: draft.quote,
          body,
        });
        if (!threadId) {
          return;
        }
        setDraft(null);
        onActiveChange(`t:${threadId}`);
        await askAgent(body, {
          id: threadId,
          blockId: draft.blockId,
          quote: draft.quote,
        });
      }}
    />
  );

  const register = (key: string) => (element: HTMLElement | null) => {
    if (element) {
      cardRefs.current.set(key, element);
    } else {
      cardRefs.current.delete(key);
    }
  };

  const canStartComment =
    canComment &&
    focusedBlock &&
    !draft &&
    !items.some(
      (item) =>
        item.kind === "thread" && item.anchorBlockId === focusedBlock.blockId
    );

  const addCommentButton = canStartComment && anchors.focus !== undefined && (
    <div
      className={cn("absolute", compact ? "right-1" : "left-3")}
      style={{ top: anchors.focus }}
    >
      <Button
        size="xs"
        variant="ghost"
        icon={MessageSquare01}
        label={compact ? undefined : "Comment"}
        tooltip="Comment on this paragraph"
        aria-label="Comment on this paragraph"
        onClick={() => {
          setDraft(focusedBlock);
          onActiveChange(null);
        }}
      />
    </div>
  );

  const detached = detachedThreads.filter((thread) => !thread.resolved);
  const detachedList = detached.length > 0 && (
    <div
      className={cn(
        "absolute flex flex-col gap-2",
        compact ? "right-1 z-10 items-end" : "left-3 right-2"
      )}
      style={{ top: endTop }}
    >
      <Button
        size="xs"
        variant="ghost"
        label={`${detached.length} on deleted text`}
        aria-expanded={showDetached}
        onClick={() => setShowDetached((shown) => !shown)}
      />
      {showDetached && (
        <div className={cn("flex flex-col gap-2", compact && "w-72")}>
          {detached.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              isActive
              canComment={canComment}
              agentHint=""
              onActivate={() => undefined}
              onReply={(body) => reply(thread.id, body)}
              onResolve={
                canReview
                  ? () => setThreadResolved(session.ydoc, thread.id, true)
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );

  if (compact) {
    const open =
      (draft ? draftKey : null) ??
      (activeKey && items.some((item) => item.key === activeKey)
        ? activeKey
        : null);
    const openItem = items.find((item) => item.key === open);
    return (
      <>
        <div
          className="relative w-9 shrink-0"
          style={{ minHeight: endTop + 48 }}
          aria-label="Comments and suggestions"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-label={
                item.kind === "suggestion"
                  ? `Suggestion by ${item.suggestion.actorName}`
                  : `Comment thread, ${item.thread.messages.length} messages`
              }
              aria-expanded={open === item.key}
              onClick={() =>
                onActiveChange(open === item.key ? null : item.key)
              }
              className={cn(
                "absolute right-1 flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-semibold",
                item.kind === "suggestion"
                  ? "bg-highlight-100 text-highlight-700 dark:bg-highlight-900 dark:text-highlight-200"
                  : "bg-muted-background text-foreground dark:bg-muted-background-night dark:text-foreground-night"
              )}
              style={{ top: anchors[item.key] ?? tops[item.key] ?? 0 }}
            >
              {item.kind === "suggestion" ? (
                "✦"
              ) : (
                <>
                  <Icon visual={MessageSquare01} size="xs" />
                  {item.thread.messages.length > 1 &&
                    item.thread.messages.length}
                </>
              )}
            </button>
          ))}
          {addCommentButton}
          {detachedList}
        </div>
        {(openItem || draft) && (
          <div
            ref={register(open ?? draftKey)}
            className="absolute right-10 z-10 w-72"
            style={{ top: tops[open ?? draftKey] ?? 0 }}
          >
            {draft ? draftCard : openItem && cardFor(openItem)}
          </div>
        )}
      </>
    );
  }

  return (
    <div
      className="relative w-64 shrink-0 border-l border-border pl-3 pr-2 dark:border-border-night"
      style={{ minHeight: endTop + 48 }}
      aria-label="Comments and suggestions"
    >
      {items.map((item) => (
        <div
          key={item.key}
          ref={register(item.key)}
          className="absolute left-3 right-2 transition-[top] duration-150"
          style={{ top: tops[item.key] ?? 0 }}
        >
          {cardFor(item)}
        </div>
      ))}
      {draft && (
        <div
          ref={register(draftKey)}
          className="absolute left-3 right-2 transition-[top] duration-150"
          style={{ top: tops[draftKey] ?? 0 }}
        >
          {draftCard}
        </div>
      )}
      {addCommentButton}
      {detachedList}
    </div>
  );
}
