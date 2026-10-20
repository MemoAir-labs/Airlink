import type { CommentThread, Suggestion } from "@memo-air/richtext";
import { useState } from "react";
import { Button, cn, TextArea } from "./ui";

export type CommentAgent = { configurationId: string; name: string };

export function mentionedAgent(
  body: string,
  agents: CommentAgent[]
): CommentAgent | null {
  const lower = body.toLowerCase();
  return (
    agents.find((agent) => lower.includes(`@${agent.name.toLowerCase()}`)) ??
    null
  );
}

interface CommentComposerProps {
  placeholder: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
}

export function CommentComposer({
  placeholder,
  autoFocus,
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const [body, setBody] = useState("");
  const [isSending, setIsSending] = useState(false);

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed || isSending) {
      return;
    }
    setIsSending(true);
    await onSubmit(trimmed);
    setIsSending(false);
    setBody("");
  };

  return (
    <div className="flex flex-col gap-1.5">
      <TextArea
        value={body}
        placeholder={placeholder}
        rows={2}
        autoFocus={autoFocus}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            void submit();
          }
          if (event.key === "Escape") {
            onCancel?.();
          }
        }}
      />
      <div className="flex justify-end gap-1">
        {onCancel && (
          <Button size="xs" variant="ghost" label="Cancel" onClick={onCancel} />
        )}
        <Button
          size="xs"
          variant="primary"
          label="Comment"
          tooltip="Comment (⌘↵)"
          isLoading={isSending}
          disabled={!body.trim() || isSending}
          onClick={() => void submit()}
        />
      </div>
    </div>
  );
}

const cardClassName =
  "flex flex-col gap-2 rounded-xl border bg-background p-3 text-sm shadow-sm transition-shadow dark:bg-background-night";

interface SuggestionCardProps {
  suggestion: Suggestion;
  isActive: boolean;
  canReview: boolean;
  onActivate: () => void;
  onAccept: () => void;
  onReject: () => void;
}

export function SuggestionCard({
  suggestion,
  isActive,
  canReview,
  onActivate,
  onAccept,
  onReject,
}: SuggestionCardProps) {
  return (
    <section
      aria-label={`Suggestion by ${suggestion.actorName}`}
      className={cn(
        cardClassName,
        isActive
          ? "border-highlight-300 shadow-md dark:border-highlight-700"
          : "border-border dark:border-border-night"
      )}
    >
      <button type="button" className="text-left" onClick={onActivate}>
        <span className="font-semibold">✦ {suggestion.actorName}</span>{" "}
        <span className="text-muted-foreground dark:text-muted-foreground-night">
          suggested a change
        </span>
        {suggestion.approver && (
          <span className="block text-xs text-muted-foreground dark:text-muted-foreground-night">
            Needs {suggestion.approver}
          </span>
        )}
      </button>
      {canReview && (
        <div className="flex gap-1">
          <Button
            size="xs"
            variant="primary"
            label="Accept"
            tooltip="Accept (⌥↵)"
            onClick={onAccept}
          />
          <Button
            size="xs"
            variant="outline"
            label="Reject"
            tooltip="Reject (⌥⌫)"
            onClick={onReject}
          />
        </div>
      )}
    </section>
  );
}

interface ThreadCardProps {
  thread: CommentThread;
  isActive: boolean;
  canComment: boolean;
  agentHint: string;
  onActivate: () => void;
  onReply: (body: string) => Promise<void>;
  onResolve?: () => void;
}

export function ThreadCard({
  thread,
  isActive,
  canComment,
  agentHint,
  onActivate,
  onReply,
  onResolve,
}: ThreadCardProps) {
  const [first, ...replies] = thread.messages;
  const shown = isActive ? thread.messages : first ? [first] : [];

  return (
    <section
      aria-label={`Comment thread${first ? ` by ${first.actor.name}` : ""}`}
      className={cn(
        cardClassName,
        isActive
          ? "border-highlight-300 shadow-md dark:border-highlight-700"
          : "border-border dark:border-border-night"
      )}
    >
      <button
        type="button"
        className="flex flex-col gap-1.5 text-left"
        onClick={onActivate}
      >
        {thread.quote && (
          <span className="truncate border-l-2 border-highlight-300 pl-2 text-xs text-muted-foreground dark:border-highlight-700 dark:text-muted-foreground-night">
            {thread.quote}
          </span>
        )}
        {shown.map((message) => (
          <span key={message.id} className="block">
            <span className="font-semibold">
              {message.actor.kind === "agent" ? "✦ " : ""}
              {message.actor.name}
            </span>{" "}
            {message.body}
          </span>
        ))}
        {!isActive && replies.length > 0 && (
          <span className="text-xs text-muted-foreground dark:text-muted-foreground-night">
            {replies.length} {replies.length === 1 ? "reply" : "replies"}
          </span>
        )}
      </button>
      {isActive && canComment && (
        <>
          <CommentComposer
            placeholder={`Reply.${agentHint}`}
            onSubmit={onReply}
          />
          {onResolve && (
            <Button
              className="self-start"
              size="xs"
              variant="ghost"
              label="Resolve"
              onClick={onResolve}
            />
          )}
        </>
      )}
    </section>
  );
}

interface NewThreadCardProps {
  quote: string;
  agentHint: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}

export function NewThreadCard({
  quote,
  agentHint,
  onSubmit,
  onCancel,
}: NewThreadCardProps) {
  return (
    <section
      aria-label="New comment"
      className={cn(
        cardClassName,
        "border-highlight-300 shadow-md dark:border-highlight-700"
      )}
    >
      {quote && (
        <span className="truncate border-l-2 border-highlight-300 pl-2 text-xs text-muted-foreground dark:border-highlight-700 dark:text-muted-foreground-night">
          {quote}
        </span>
      )}
      <CommentComposer
        placeholder={`Comment.${agentHint}`}
        autoFocus
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    </section>
  );
}
