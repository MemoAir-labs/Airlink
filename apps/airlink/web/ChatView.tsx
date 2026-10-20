import { HocuspocusProvider } from "@hocuspocus/provider";
import type { ChatAttachment, ChatMessage } from "@memo-air/chat";
import { chatMessages, postMessage, readMessages } from "@memo-air/chat";
import {
  ActionFileIcon,
  cn,
  Icon,
  Markdown,
  Spinner,
} from "@memo-air/react/ui";
import { Fragment, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { Avatar } from "./Avatar.tsx";
import type { Channel, Person } from "./api.ts";
import { agentsSchema, useApi } from "./api.ts";
import type { Mentionable } from "./Composer.tsx";
import { Composer } from "./Composer.tsx";
import { fetchToken } from "./host.tsx";

interface ChatViewProps {
  channel: Channel;
  person: Person;
  // A new message may come with a new object (an agent made a sheet), so the channel re-reads them.
  onMessage: () => void;
  // Everyone with the channel open, the person included, for the header, and whether each is in
  // the channel's huddle.
  onPresent: (
    present: { id: string; name: string; inHuddle: boolean }[]
  ) => void;
  // This person is in the huddle, for everyone else's header.
  inHuddle: boolean;
  // Every person who has written in the channel, under their latest name.
  onWriters: (writers: { id: string; name: string }[]) => void;
  // The people and agents in this channel: whom a mention can name.
  humans: { id: string; name: string }[];
  agentIds: string[];
  onUpload: (file: File) => Promise<ChatAttachment | null>;
  onOpenAttachment: (docName: string) => void;
}

const groupWindowMs = 5 * 60_000;
const typingIdleMs = 3000;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

function MessageText({ message }: { message: ChatMessage }) {
  if (!message.mentions.length) {
    return <>{message.text}</>;
  }
  const names = message.mentions.map((mention) => `@${mention.name}`);
  const pattern = new RegExp(
    `(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`
  );
  let offset = 0;
  const parts = message.text.split(pattern).map((text) => {
    const part = { text, start: offset };
    offset += text.length;
    return part;
  });
  return (
    <>
      {parts.map(({ text, start }) =>
        names.includes(text) ? (
          <span
            key={start}
            className="rounded bg-highlight-100 px-1 font-medium text-highlight-800 dark:bg-highlight-900 dark:text-highlight-100"
          >
            {text}
          </span>
        ) : (
          <Fragment key={start}>{text}</Fragment>
        )
      )}
    </>
  );
}

// The channel's messages, straight from its chat doc: a person posts over their own socket, an
// agent's reply arrives (and streams) the same way, and every tab reads the same order.
export function ChatView({
  channel,
  person,
  onMessage,
  onPresent,
  onWriters,
  inHuddle,
  humans,
  agentIds,
  onUpload,
  onOpenAttachment,
}: ChatViewProps) {
  const agents = (
    useApi("/api/agents", agentsSchema).data?.agents ?? []
  ).filter((agent) => agentIds.includes(agent.id));
  const mentionables: Mentionable[] = [
    ...agents.map((agent) => ({
      kind: "agent" as const,
      id: agent.id,
      name: agent.name,
      detail: agent.role,
    })),
    ...humans
      .filter((human) => human.id !== person.id)
      .map((human) => ({ kind: "human" as const, ...human })),
  ];
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [synced, setSynced] = useState(false);
  const [typing, setTyping] = useState<string[]>([]);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onPresentRef = useRef(onPresent);
  onPresentRef.current = onPresent;
  const onWritersRef = useRef(onWriters);
  onWritersRef.current = onWriters;
  const inHuddleRef = useRef(inHuddle);
  inHuddleRef.current = inHuddle;

  useEffect(() => {
    providerRef.current?.setAwarenessField("huddle", inHuddle);
  }, [inHuddle]);

  useEffect(() => {
    const ydoc = new Y.Doc();
    let provider: HocuspocusProvider | null = null;
    let cancelled = false;
    let count = 0;
    const refresh = () => {
      const next = readMessages(ydoc);
      if (next.length !== count) {
        count = next.length;
        onMessageRef.current();
        const writers = new Map<string, string>();
        for (const message of next) {
          if (message.actor.kind === "human") {
            writers.set(message.actor.id, message.actor.name);
          }
        }
        onWritersRef.current([...writers].map(([id, name]) => ({ id, name })));
      }
      setMessages(next);
    };
    chatMessages(ydoc).observeDeep(refresh);
    void fetchToken(channel.chatDoc).then((first) => {
      if (cancelled || !first.ok) {
        return;
      }
      provider = new HocuspocusProvider({
        url: first.data.url,
        name: channel.chatDoc,
        document: ydoc,
        // Called on every reconnect, so an expired token is replaced.
        token: async () => {
          const result = await fetchToken(channel.chatDoc);
          return result.ok ? result.data.token : "";
        },
        onSynced: () => setSynced(true),
      });
      providerRef.current = provider;
      // An agent writing its reply shows up as a synthetic awareness entry with the message it
      // is writing; a person, with the typing flag their composer sets.
      const readTyping = () => {
        const states = [...(provider?.awareness?.getStates().values() ?? [])];
        const present = new Map<string, { name: string; inHuddle: boolean }>();
        for (const state of states) {
          if (
            state.user?.kind === "human" &&
            typeof state.user.id === "string" &&
            typeof state.user.name === "string"
          ) {
            // One person in two tabs is in the huddle if either tab is.
            present.set(state.user.id, {
              name: state.user.name,
              inHuddle:
                state.huddle === true ||
                present.get(state.user.id)?.inHuddle === true,
            });
          }
        }
        onPresentRef.current(
          [...present].map(([id, each]) => ({ id, ...each }))
        );
        const names = states
          .filter(
            (state) =>
              state.user?.id !== person.id &&
              (state.typing === true ||
                (state.user?.kind === "agent" && state.messageId))
          )
          .map((state) =>
            typeof state.user?.name === "string" ? state.user.name : ""
          )
          .filter(Boolean);
        setTyping([...new Set(names)]);
      };
      // Listening before announcing, so the header counts this person from the first render
      // rather than from the next time someone else comes or goes.
      provider.awareness?.on("change", readTyping);
      provider.setAwarenessField("user", {
        id: person.id,
        name: person.name,
        kind: "human",
      });
      provider.setAwarenessField("huddle", inHuddleRef.current);
      readTyping();
      setDoc(ydoc);
    });
    return () => {
      cancelled = true;
      chatMessages(ydoc).unobserveDeep(refresh);
      provider?.destroy();
      providerRef.current = null;
      ydoc.destroy();
    };
  }, [channel.chatDoc, person.id, person.name]);

  const markTyping = () => {
    providerRef.current?.setAwarenessField("typing", true);
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
    }
    typingTimerRef.current = setTimeout(
      () => providerRef.current?.setAwarenessField("typing", false),
      typingIdleMs
    );
  };

  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Messages"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4"
      >
        {!synced && (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        )}
        {synced && !messages.length && (
          <p className="m-auto max-w-64 text-center text-sm text-muted-foreground dark:text-muted-foreground-night">
            Say hello. Mention an agent with @ to ask it something, or just
            write — the default agent answers.
          </p>
        )}
        {messages.map((message, index) => {
          const isAgent = message.actor.kind === "agent";
          const isMine = message.actor.id === person.id;
          const previous = messages[index - 1];
          // Like a team chat: a run of messages from one author within a few minutes shares one
          // header, and each follow-up shows its time on hover.
          const grouped =
            previous !== undefined &&
            previous.actor.id === message.actor.id &&
            message.ts - previous.ts < groupWindowMs;
          const time = (
            <time dateTime={new Date(message.ts).toISOString()}>
              {timeFormat.format(message.ts)}
            </time>
          );
          return (
            <article
              key={message.id}
              className={cn(
                "group -mx-4 flex gap-2 px-4 hover:bg-muted-background",
                grouped ? "py-0.5" : "mt-2 pt-1.5 pb-0.5"
              )}
            >
              <div className="w-9 shrink-0">
                {grouped ? (
                  <span className="invisible block pt-0.5 text-right text-[11px] text-muted-foreground group-hover:visible">
                    {time}
                  </span>
                ) : (
                  <Avatar
                    id={message.actor.id}
                    name={message.actor.name}
                    kind={message.actor.kind}
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                {!grouped && (
                  <div className="flex items-baseline gap-2">
                    <span className="text-[15px] font-bold text-foreground">
                      {message.actor.name}
                      {isMine && (
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          (you)
                        </span>
                      )}
                    </span>
                    {isAgent && (
                      <span className="rounded bg-muted-background px-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase group-hover:bg-background">
                        Agent
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {time}
                    </span>
                  </div>
                )}
                {isAgent ? (
                  // Agents answer in Markdown by habit; people's messages stay as typed.
                  <Markdown content={message.text} textSize="sm" />
                ) : (
                  message.text && (
                    <p className="text-[15px] leading-relaxed break-words whitespace-pre-wrap">
                      <MessageText message={message} />
                    </p>
                  )
                )}
                {message.attachments.length > 0 && (
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {message.attachments.map((attachment) => (
                      <li key={attachment.docName}>
                        <button
                          type="button"
                          className="flex max-w-64 items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm hover:bg-muted-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight"
                          title="Open in the space"
                          onClick={() => onOpenAttachment(attachment.docName)}
                        >
                          <Icon
                            visual={ActionFileIcon}
                            size="sm"
                            className="text-muted-foreground"
                          />
                          <span className="truncate">
                            {attachment.title ?? "File"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <p
        aria-live="polite"
        className="h-5 shrink-0 truncate px-5 text-xs text-muted-foreground"
      >
        {typing.length > 0 &&
          `${typing.join(", ")} ${typing.length === 1 ? "is" : "are"} typing…`}
      </p>
      <Composer
        mentionables={mentionables}
        onUpload={onUpload}
        disabled={!doc || !synced}
        channelName={channel.name}
        onTyping={markTyping}
        onSend={({ text, mentions, attachments }) => {
          providerRef.current?.setAwarenessField("typing", false);
          if (doc) {
            postMessage(
              doc,
              { text, mentions, attachments },
              { kind: "human", id: person.id, name: person.name }
            );
          }
        }}
      />
    </div>
  );
}
