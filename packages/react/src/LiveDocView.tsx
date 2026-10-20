import type {
  CommentActor,
  CommentThread,
  Suggestion,
} from "@memo-air/richtext";
import {
  acceptSuggestion,
  addThread,
  commentsMap,
  docFragment,
  exportMarkdown,
  pendingSuggestions,
  readThreads,
  rejectSuggestion,
  replyToThread,
  richTextExtensions,
} from "@memo-air/richtext";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentReadingMarks, agentMarkData } from "./AgentCursors";
import { useLiveHost } from "./host";
import { LiveDocHistory } from "./LiveDocHistory";
import type { FocusedBlock } from "./LiveDocMargin";
import { blockElement, LiveDocMargin, reviewItems } from "./LiveDocMargin";
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
import type { LiveDocSession } from "./useLiveDocSession";
import { colorForId, useLiveDocSession } from "./useLiveDocSession";

const agentAnnouncementIntervalMs = 10_000;

function isSuggestion(value: unknown): value is Suggestion {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "kind" in value &&
    (value.kind === "insert" || value.kind === "delete")
  );
}

function renderCaret(user: Record<string, unknown>): HTMLElement {
  const name = typeof user.name === "string" ? user.name : "";
  const color = typeof user.color === "string" ? user.color : "#2563eb";
  const caret = document.createElement("span");
  caret.className = "relative -mx-px border-l-2 border-r-0";
  caret.style.borderColor = color;
  caret.dataset.liveCaret = name;
  const label = document.createElement("span");
  label.className =
    "pointer-events-none absolute -top-5 left-[-2px] whitespace-nowrap rounded px-1 text-xs font-medium text-white";
  label.style.backgroundColor = color;
  label.textContent = user.kind === "agent" ? `✦ ${name}` : name;
  if (user.kind === "agent") {
    Object.assign(
      label.dataset,
      agentMarkData({ name, color, action: "typing" })
    );
  }
  caret.append(label);
  return caret;
}

const quoteMaxChars = 120;

interface LiveDocEditorProps {
  session: LiveDocSession;
  editable: boolean;
  user: { name: string; color: string };
  onFocusBlock: (focused: FocusedBlock | null) => void;
}

function LiveDocEditor({
  session,
  editable,
  user,
  onFocusBlock,
}: LiveDocEditorProps) {
  const fragment = docFragment(session.ydoc);
  const editor = useEditor(
    {
      extensions: [
        ...richTextExtensions(),
        Collaboration.configure({ document: session.ydoc }),
        CollaborationCaret.configure({
          provider: session.provider,
          user: { ...user, kind: "human" },
          render: renderCaret,
        }),
      ],
      editable,
      onSelectionUpdate: ({ editor: current }) => {
        const { from, to, $from } = current.state.selection;
        const block = $from.depth > 0 ? $from.node(1) : null;
        const blockId: unknown = block?.attrs.id;
        if (!block || typeof blockId !== "string") {
          onFocusBlock(null);
          return;
        }
        const selected = current.state.doc.textBetween(from, to, " ").trim();
        onFocusBlock({
          blockId,
          quote: (selected || block.textContent).slice(0, quoteMaxChars),
        });
      },
      editorProps: {
        attributes: {
          class: cn(
            "px-6 py-4 text-sm leading-6 text-foreground focus:outline-none dark:text-foreground-night",
            "[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold",
            "[&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li_p]:my-0.5",
            "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted-background [&_code]:px-1 [&_pre]:my-2 [&_pre]:rounded-lg [&_pre]:bg-muted-background [&_pre]:p-3"
          ),
          "aria-label": "Live document",
        },
        handleKeyDown: (view, event) => {
          if (
            !event.altKey ||
            (event.key !== "Enter" && event.key !== "Backspace")
          ) {
            return false;
          }
          const suggestion: unknown =
            view.state.selection.$from.node(1)?.attrs.suggestion;
          if (!isSuggestion(suggestion)) {
            return false;
          }
          // Shortcuts from the spec: ⌥↵ accepts, ⌥⌫ rejects the suggestion under the caret.
          if (event.key === "Enter") {
            acceptSuggestion(fragment, suggestion.id);
          } else {
            rejectSuggestion(fragment, suggestion.id);
          }
          return true;
        },
      },
    },
    [session]
  );

  return (
    <EditorContent
      editor={editor}
      className={cn(
        "[&_[data-suggestion-kind=insert]]:underline [&_[data-suggestion-kind=insert]]:decoration-green-600 [&_[data-suggestion-kind=insert]]:decoration-2",
        "[&_[data-suggestion-kind=delete]]:text-muted-foreground [&_[data-suggestion-kind=delete]]:line-through"
      )}
    />
  );
}

function downloadMarkdown(session: LiveDocSession, title: string) {
  const blob = new Blob([exportMarkdown(docFragment(session.ydoc))], {
    type: "text/markdown",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${title}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
}

const compactWidthPx = 640;

// The doc's pending suggestions and comment threads, kept current as the Y.Doc changes.
function useReview(session: LiveDocSession | null) {
  const [review, setReview] = useState<{
    suggestions: Suggestion[];
    threads: CommentThread[];
  }>({ suggestions: [], threads: [] });
  useEffect(() => {
    if (!session) {
      return;
    }
    const fragment = docFragment(session.ydoc);
    const comments = commentsMap(session.ydoc);
    const onChange = () =>
      setReview({
        suggestions: pendingSuggestions(fragment),
        threads: readThreads(session.ydoc),
      });
    onChange();
    fragment.observeDeep(onChange);
    comments.observeDeep(onChange);
    return () => {
      fragment.unobserveDeep(onChange);
      comments.unobserveDeep(onChange);
      setReview({ suggestions: [], threads: [] });
    };
  }, [session]);
  return review;
}

// The live doc itself: editor, margin cards, history and sharing.
export function LiveDocView({
  docId,
  agents,
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
  const { suggestions, threads } = useReview(session);
  const commentOverHttp = host.useComment(docId);
  const [showHistory, setShowHistory] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [focusedBlock, setFocusedBlock] = useState<FocusedBlock | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [isCompact, setIsCompact] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncedAtRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const access = connection?.access ?? "read";
  const canEdit = access === "write";
  const canComment = access !== "read";
  const title = connection?.liveDoc.title ?? "Live doc";

  const items = useMemo(
    () => (session ? reviewItems(session, suggestions, threads) : []),
    [session, suggestions, threads]
  );
  const detachedThreads = useMemo(
    () => threads.filter((thread) => thread.detached),
    [threads]
  );

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

  const editingAgents = peers.filter(
    (peer) => peer.kind === "agent" && peer.hasCursor
  );
  const editingAgentNames = editingAgents.map((peer) => peer.name).join(", ");

  useEffect(() => {
    const now = Date.now();
    if (
      !editingAgentNames ||
      now - lastAnnouncedAtRef.current < agentAnnouncementIntervalMs
    ) {
      return;
    }
    lastAnnouncedAtRef.current = now;
    setAnnouncement(`${editingAgentNames} editing the document`);
  }, [editingAgentNames]);

  const scrollToBlock = (blockId: string) => {
    const scroller = scrollRef.current;
    const block = blockElement(wrapperRef.current, blockId);
    if (scroller && block) {
      scroller.scrollTo({
        top:
          block.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop -
          96,
        behavior: "smooth",
      });
    }
  };

  // The Review pill steps through every open suggestion and thread in document order.
  const reviewNext = () => {
    if (items.length === 0) {
      return;
    }
    const at = items.findIndex((item) => item.key === activeKey);
    const next = items[(at + 1) % items.length];
    setActiveKey(next.key);
    scrollToBlock(next.anchorBlockId);
  };

  const actor: CommentActor | null = user
    ? { kind: "human", id: user.id, name: user.name }
    : null;

  const activeAnchor = items.find(
    (item) => item.key === activeKey
  )?.anchorBlockId;
  const anchoredIds = items.map((item) => item.anchorBlockId);

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
      {items.length > 0 && (
        <Button
          size="xs"
          variant="outline"
          label={`Review ${items.length}`}
          tooltip="Go to the next suggestion or comment"
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
              label={showHistory ? "Back to the doc" : "History"}
              onClick={() => setShowHistory((shown) => !shown)}
            />
            {connection?.canShare && host.renderShare && (
              <DropdownMenuItem
                label="Share"
                onClick={() => setShowShare(true)}
              />
            )}
            <DropdownMenuItem
              label="Export as Markdown"
              onClick={() => downloadMarkdown(session, title)}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  return (
    <div ref={rootRef} className={cn("flex min-h-0 flex-col", className)}>
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
          This live doc is not available to you.
        </div>
      )}
      {session && connection && hasSynced && actor && (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {showHistory && (
            <LiveDocHistory
              docId={docId}
              canWrite={canEdit}
              onClose={() => setShowHistory(false)}
            />
          )}
          <div
            ref={scrollRef}
            className={cn(
              "min-h-0 flex-1 overflow-y-auto",
              showHistory && "hidden"
            )}
          >
            <style>
              {[
                ...anchoredIds.map(
                  (id) =>
                    `[data-id="${CSS.escape(id)}"]{box-shadow:inset 3px 0 0 var(--live-anchor,rgba(234,179,8,.45))}`
                ),
                activeAnchor
                  ? `[data-id="${CSS.escape(activeAnchor)}"]{background:rgba(234,179,8,.12)}`
                  : "",
              ].join("")}
            </style>
            <div ref={wrapperRef} className="relative flex pb-64">
              <div className="min-w-0 flex-1">
                <LiveDocEditor
                  session={session}
                  editable={canEdit}
                  onFocusBlock={setFocusedBlock}
                  user={{ name: actor.name, color: colorForId(actor.id) }}
                />
              </div>
              <LiveDocMargin
                session={session}
                items={items}
                detachedThreads={detachedThreads}
                wrapperRef={wrapperRef}
                focusedBlock={focusedBlock}
                activeKey={activeKey}
                onActiveChange={setActiveKey}
                agents={agents}
                docId={docId}
                canReview={canEdit}
                canComment={canComment}
                compact={isCompact}
                addThread={async ({ blockId, quote, body }) =>
                  canEdit
                    ? addThread(session.ydoc, { blockId, quote, actor, body })
                    : commentOverHttp({ blockId, quote, body })
                }
                reply={async (threadId, body) => {
                  if (canEdit) {
                    replyToThread(session.ydoc, threadId, { actor, body });
                  } else {
                    await commentOverHttp({ threadId, body });
                  }
                }}
              />
            </div>
          </div>
          {editingAgents.length > 0 && !showHistory && (
            <Button
              className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-md"
              size="sm"
              variant="outline"
              label={`✦ ${editingAgents[0].name} editing ↓`}
              onClick={() =>
                document
                  .querySelector(
                    `[data-live-caret="${CSS.escape(editingAgents[0].name)}"]`
                  )
                  ?.scrollIntoView({ block: "center", behavior: "smooth" })
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
