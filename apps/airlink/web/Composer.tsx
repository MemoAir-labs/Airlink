import type { ChatAttachment, ChatMention } from "@memo-air/chat";
import {
  ActionFileIcon,
  AtSign,
  Button,
  cn,
  Icon,
  Plus,
  Send01,
  Spinner,
  XClose,
} from "@memo-air/react/ui";
import { useRef, useState } from "react";
import { Avatar } from "./Avatar.tsx";

// Someone a message can name: a person in the channel or one of its agents.
export type Mentionable = ChatMention & { detail?: string };

type Pending = { key: string; name: string; attachment: ChatAttachment | null };

interface ComposerProps {
  mentionables: Mentionable[];
  disabled: boolean;
  channelName: string;
  // Called as the person types, so the channel can show them typing.
  onTyping: () => void;
  // Puts a file in the channel (it lands in the space too); null when it could not.
  onUpload: (file: File) => Promise<ChatAttachment | null>;
  onSend: (message: {
    text: string;
    mentions: ChatMention[];
    attachments: ChatAttachment[];
  }) => void;
}

// Write, name someone in the channel with @, and attach files with +; each agent answers on the
// harness set for it in Settings.
export function Composer({
  mentionables,
  disabled,
  channelName,
  onTyping,
  onUpload,
  onSend,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Mentionable[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [pending, setPending] = useState<Pending[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const matches =
    query === null
      ? []
      : mentionables.filter((each) =>
          each.name.toLowerCase().startsWith(query.toLowerCase())
        );
  const isUploading = pending.some((each) => each.attachment === null);
  const attachments = pending.flatMap((each) =>
    each.attachment ? [each.attachment] : []
  );
  const canSend =
    !disabled && !isUploading && (text.trim() !== "" || attachments.length > 0);

  const onChange = (value: string, caret: number) => {
    setText(value);
    if (value.trim()) {
      onTyping();
    }
    const before = value.slice(0, caret).match(/(?:^|\s)@([\w-]*)$/);
    setQuery(before ? before[1] : null);
    setHighlighted(0);
  };

  const mention = (each: Mentionable) => {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? text.length;
    const start = text.slice(0, caret).lastIndexOf("@");
    const next = `${text.slice(0, start)}@${each.name} ${text.slice(caret)}`;
    setText(next);
    setPicked((current) =>
      current.some((candidate) => candidate.id === each.id)
        ? current
        : [...current, each]
    );
    setQuery(null);
    requestAnimationFrame(() => {
      const at = start + each.name.length + 2;
      input?.setSelectionRange(at, at);
      input?.focus();
    });
  };

  // The @ button types the @ a person would, so the list opens the same way.
  const startMention = () => {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const lead = before === "" || /\s$/.test(before) ? "@" : " @";
    setText(`${before}${lead}${text.slice(caret)}`);
    setQuery("");
    setHighlighted(0);
    requestAnimationFrame(() => {
      const at = caret + lead.length;
      input?.setSelectionRange(at, at);
      input?.focus();
    });
  };

  const attach = (files: File[]) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      setPending((current) => [
        ...current,
        { key, name: file.name, attachment: null },
      ]);
      void onUpload(file).then((attachment) =>
        setPending((current) =>
          attachment
            ? current.map((each) =>
                each.key === key ? { ...each, attachment } : each
              )
            : current.filter((each) => each.key !== key)
        )
      );
    }
  };

  const send = () => {
    if (!canSend) {
      return;
    }
    const trimmed = text.trim();
    onSend({
      text: trimmed,
      // A chip whose @Name was deleted from the text is no longer a mention.
      mentions: picked
        .filter((each) => trimmed.includes(`@${each.name}`))
        .map(({ kind, id, name }) => ({ kind, id, name })),
      attachments,
    });
    setText("");
    setPicked([]);
    setPending([]);
  };

  return (
    <div className="relative border-t border-border p-3 dark:border-border-night">
      {matches.length > 0 && (
        <ul
          role="listbox"
          aria-label="People and agents"
          className="absolute bottom-full left-3 right-3 mb-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-background shadow-md dark:border-border-night dark:bg-background-night"
        >
          {matches.map((each, i) => (
            <li
              key={`${each.kind}:${each.id}`}
              role="option"
              aria-selected={i === highlighted}
              onMouseDown={(event) => {
                event.preventDefault();
                mention(each);
              }}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm",
                i === highlighted &&
                  "bg-muted-background dark:bg-muted-background-night"
              )}
            >
              <Avatar
                id={each.id}
                name={each.name}
                kind={each.kind}
                size="sm"
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">
                  {each.name}
                  {each.kind === "agent" && (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · agent
                    </span>
                  )}
                </span>
                {each.detail && (
                  <span className="truncate text-xs text-muted-foreground dark:text-muted-foreground-night">
                    {each.detail}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-2 rounded-lg border border-muted-foreground/40 bg-background px-3 py-2 shadow-sm focus-within:border-muted-foreground">
        {pending.length > 0 && (
          <ul aria-label="Attached files" className="flex flex-wrap gap-1.5">
            {pending.map((each) => (
              <li
                key={each.key}
                className="flex max-w-56 items-center gap-1.5 rounded-md border border-border bg-muted-background py-1 pr-1 pl-2 text-xs"
              >
                {each.attachment ? (
                  <Icon visual={ActionFileIcon} size="xs" />
                ) : (
                  <Spinner size="xs" />
                )}
                <span className="truncate">{each.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${each.name}`}
                  className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  onClick={() =>
                    setPending((current) =>
                      current.filter((other) => other.key !== each.key)
                    )
                  }
                >
                  <Icon visual={XClose} size="xs" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={inputRef}
          rows={2}
          value={text}
          disabled={disabled}
          aria-label="Message"
          placeholder={`Message #${channelName} — @ to mention someone`}
          className="w-full resize-none border-0 bg-transparent p-0 text-[15px] shadow-none outline-none placeholder:text-muted-foreground focus:ring-0"
          onChange={(event) =>
            onChange(event.target.value, event.target.selectionStart)
          }
          onPaste={(event) => {
            if (event.clipboardData.files.length > 0) {
              event.preventDefault();
              attach([...event.clipboardData.files]);
            }
          }}
          onKeyDown={(event) => {
            if (matches.length) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setHighlighted(
                  (current) =>
                    (current +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      matches.length) %
                    matches.length
                );
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                mention(matches[highlighted]);
                return;
              }
              if (event.key === "Escape") {
                setQuery(null);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              attach([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <Button
            size="xs"
            variant="ghost-secondary"
            icon={Plus}
            aria-label="Attach files"
            tooltip="Attach files"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
          />
          <Button
            size="xs"
            variant="ghost-secondary"
            icon={AtSign}
            aria-label="Mention someone"
            tooltip="Mention a person or an agent"
            disabled={disabled}
            onClick={startMention}
          />
          <Button
            size="xs"
            variant="highlight"
            icon={Send01}
            aria-label="Send"
            tooltip={isUploading ? "Waiting for the upload" : "Send (Enter)"}
            className="ml-auto"
            disabled={!canSend}
            onClick={send}
          />
        </div>
      </div>
    </div>
  );
}
