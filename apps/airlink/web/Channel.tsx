import type { LiveDocKind } from "@memo-air/protocol";
import type { LiveDockItem } from "@memo-air/react";
import { LiveHostProvider } from "@memo-air/react";
import { LiveObjectView } from "@memo-air/react/all";
import {
  AtSign,
  Button,
  ChevronDown,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Hash02,
  Headphones01,
  Icon,
  LayoutGrid01,
  Sparkles,
  UserPlus,
  useSendNotification,
  XClose,
} from "@memo-air/react/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { Avatar } from "./Avatar.tsx";
import type { Channel as ChannelType, Person } from "./api.ts";
import {
  agentsSchema,
  api,
  membershipSchema,
  objectSchema,
  peopleSchema,
  uploadFile,
  useApi,
} from "./api.ts";
import { ChatView } from "./ChatView.tsx";
import { AirlinkViewProvider, airlinkHost } from "./host.tsx";
import type { MembersTab } from "./MembersDialog.tsx";
import { MembersDialog } from "./MembersDialog.tsx";

const repliesSchema = z.enum(["auto", "tagged"]);
const channelBodySchema = z.object({
  channel: z.object({ replies: repliesSchema }),
  objects: z.array(objectSchema),
});
const okSchema = z.object({ ok: z.boolean() });
const replyModes = {
  auto: {
    icon: Sparkles,
    chip: "Agents: Auto",
    label: "Automatically",
    description:
      "An agent jumps in when a message is for it, even without an @.",
  },
  tagged: {
    icon: AtSign,
    chip: "Agents: On mention",
    label: "Only when @-mentioned",
    description: "Agents stay quiet until someone @-mentions them.",
  },
} as const;
const deletedSchema = z.object({ ok: z.boolean(), deleted: z.boolean() });
const createdSchema = z.object({ object: objectSchema });
const membershipCheckMs = 10_000;

const addable: { kind: LiveDocKind; label: string; title: string }[] = [
  { kind: "doc", label: "Doc", title: "Untitled doc" },
  { kind: "sheet", label: "Sheet", title: "Untitled sheet" },
  { kind: "canvas", label: "Canvas", title: "Untitled canvas" },
  { kind: "slides", label: "Slides", title: "Untitled slides" },
  { kind: "browser", label: "Browser", title: "Browser" },
];

interface ChannelProps {
  channel: ChannelType;
  person: Person;
  isDark: boolean;
  // Who has this channel open, for the sidebar's online marks.
  onPresent: (ids: Set<string>) => void;
  // Someone joined or left, maybe this person.
  onMembershipChanged: () => void;
}

// A channel is its chat beside its space: every object the room made, as windows arranged the
// same way for everyone. On a narrow screen the two are tabs.
export function Channel({
  channel,
  person,
  isDark,
  onPresent,
  onMembershipChanged,
}: ChannelProps) {
  const notify = useSendNotification();
  const { data, reload } = useApi(
    `/api/channels/${channel.id}`,
    channelBodySchema
  );
  const objects = data?.objects ?? [];
  const [focused, setFocused] = useState<string | null>(null);
  // The channel's call, open as the huddle around the space. Kept apart from `focused` so opening
  // a doc from inside the huddle covers it without hanging up.
  const [huddle, setHuddle] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "space">("chat");
  const [showSpace, setShowSpace] = useState(true);
  const [present, setPresent] = useState<
    { id: string; name: string; inHuddle: boolean }[]
  >([]);
  const [inHuddle, setInHuddle] = useState(false);
  const huddlers = present.filter(
    (each) => each.inHuddle && each.id !== person.id
  );
  const [writers, setWriters] = useState<{ id: string; name: string }[]>([]);
  const [showMembers, setShowMembers] = useState<MembersTab | null>(null);
  const membership = useApi(
    `/api/channels/${channel.id}/members`,
    membershipSchema
  );
  const agentIds = membership.data?.agents ?? [];
  const channelAgents = (useApi("/api/agents", agentsSchema).data?.agents ?? [])
    .filter((agent) => agentIds.includes(agent.id))
    .map((agent) => ({ configurationId: agent.id, name: agent.name }));
  const workspacePeople =
    useApi("/api/people", peopleSchema).data?.people ?? [];
  const onlineIds = new Set(present.map((member) => member.id));
  // The latest name wins: who is here now, then the chat, then the workspace's record.
  const names = new Map(
    [...workspacePeople, ...writers, ...present].map((each) => [
      each.id,
      each.name,
    ])
  );
  const people = [...names].map(([id, name]) => ({
    id,
    name,
    online: onlineIds.has(id),
  }));
  const members = (membership.data?.humans ?? [])
    .map((id) => ({ id, name: names.get(id) ?? "Someone" }))
    .sort((a, b) => Number(onlineIds.has(b.id)) - Number(onlineIds.has(a.id)));
  const requestCount = membership.data?.requests.length ?? 0;
  const reloadMembership = membership.reload;
  // ponytail: polled so a join request shows up without a reload; push it through the chat doc's
  // awareness if the delay matters.
  useEffect(() => {
    const timer = setInterval(reloadMembership, membershipCheckMs);
    return () => clearInterval(timer);
  }, [reloadMembership]);
  // The dock is built once; its launchers reach this render's add and call through the ref.
  const launchRef = useRef<{
    add: (kind: LiveDocKind, title: string) => Promise<string | null>;
    call: () => Promise<void>;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dock = useMemo<LiveDockItem[]>(
    () => [
      ...addable.map((item) => ({
        kind: item.kind,
        label: item.label,
        onOpen: () => void launchRef.current?.add(item.kind, item.title),
      })),
      {
        kind: "media",
        label: "Call",
        onOpen: () => void launchRef.current?.call(),
      },
      {
        kind: "file",
        label: "Upload",
        onOpen: () => fileInputRef.current?.click(),
      },
    ],
    []
  );

  const deleteObject = useCallback(
    async (docName: string, options?: { ifUntouched: boolean }) => {
      const result = await api(
        `/api/channels/${channel.id}/objects/${encodeURIComponent(docName)}`,
        deletedSchema,
        { method: "DELETE", body: options ?? {} }
      );
      if (options?.ifUntouched) {
        if (result.ok && result.data.deleted) {
          reload();
          return true;
        }
        return false;
      }
      if (!result.ok) {
        notify({
          type: "error",
          title: "Could not delete it",
          description: result.error,
        });
        return false;
      }
      reload();
      return true;
    },
    [channel.id, notify, reload]
  );

  // Each file becomes its own window; the space places them like any new object.
  const uploadFiles = useCallback(
    (files: File[]) =>
      void Promise.all(
        files.map(async (file) => {
          const result = await uploadFile(channel.id, file);
          if (!result.ok) {
            notify({
              type: "error",
              title: `Could not upload ${file.name}`,
              description: result.error,
            });
          }
        })
      ).then(() => {
        reload();
        setTab("space");
      }),
    [channel.id, notify, reload]
  );

  const view = useMemo(
    () => ({
      person,
      channelId: channel.id,
      objects,
      isDark,
      openDoc: (docId: string) =>
        objects.find((object) => object.docName === docId)?.kind === "media"
          ? setHuddle(docId)
          : setFocused(docId),
      dock,
      deleteObject,
      uploadFiles,
    }),
    [person, channel.id, objects, isDark, dock, deleteObject, uploadFiles]
  );

  // The new object reaches the space through the person's own connection: the space places
  // every object of its channel that is not on the board yet.
  const add = async (kind: LiveDocKind, title: string) => {
    const result = await api(
      `/api/channels/${channel.id}/objects`,
      createdSchema,
      {
        method: "POST",
        body: { kind, title },
      }
    );
    if (!result.ok) {
      notify({
        type: "error",
        title: "Could not add it",
        description: result.error,
      });
      return null;
    }
    reload();
    setTab("space");
    return result.data.object.docName;
  };

  const call = async () => {
    const existing = objects.find((object) => object.kind === "media");
    const docName = existing?.docName ?? (await add("media", "Call"));
    if (docName) {
      setHuddle(docName);
    }
  };

  launchRef.current = { add, call };

  // The channel's name is already the page's title, so the space's bar names what it is.
  const renderSpaceHeader = ({ actions }: { actions: React.ReactNode }) => (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 dark:border-border-night">
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-muted-foreground">
        <Icon visual={LayoutGrid01} size="xs" />
        Desktop
      </span>
      {actions}
    </div>
  );

  return (
    <AirlinkViewProvider view={view}>
      <LiveHostProvider host={airlinkHost}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            uploadFiles([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <h1 className="flex min-w-0 flex-1 items-center gap-1 truncate text-lg font-bold">
            <Icon visual={Hash02} size="sm" className="text-muted-foreground" />
            <span className="truncate">{channel.name}</span>
            {!channel.open && (
              <Button
                size="xs"
                variant="ghost-secondary"
                icon={UserPlus}
                tooltip="Add people and agents"
                aria-label="Add people and agents"
                aria-haspopup="dialog"
                className="ml-1"
                onClick={() => setShowMembers("add")}
              />
            )}
            {data && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={cn(
                    "ml-2 flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight",
                    data.channel.replies === "auto"
                      ? "bg-highlight-100 text-highlight-800 hover:bg-highlight-200 dark:bg-highlight-900 dark:text-highlight-100"
                      : "bg-muted-background text-muted-foreground hover:text-foreground"
                  )}
                  aria-label={`When agents reply: ${replyModes[data.channel.replies].label}`}
                >
                  <Icon
                    visual={replyModes[data.channel.replies].icon}
                    size="xs"
                  />
                  {replyModes[data.channel.replies].chip}
                  <Icon visual={ChevronDown} size="xs" className="opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel label="When should agents reply?" />
                  <DropdownMenuRadioGroup
                    value={data.channel.replies}
                    onValueChange={async (value) => {
                      const mode = repliesSchema.safeParse(value);
                      if (!mode.success || mode.data === data.channel.replies) {
                        return;
                      }
                      const result = await api(
                        `/api/channels/${channel.id}/replies`,
                        okSchema,
                        { method: "POST", body: { replies: mode.data } }
                      );
                      if (!result.ok) {
                        notify({
                          type: "error",
                          title: "Could not change when agents reply",
                          description: result.error,
                        });
                      }
                      reload();
                    }}
                  >
                    {repliesSchema.options.map((mode) => (
                      <DropdownMenuRadioItem
                        key={mode}
                        value={mode}
                        label={replyModes[mode].label}
                        description={replyModes[mode].description}
                      />
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </h1>
          {members.length > 0 && (
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() =>
                setShowMembers(requestCount > 0 ? "requests" : "members")
              }
              className="relative flex items-center rounded-md border border-border py-0.5 pr-2 pl-1 hover:bg-muted-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight"
              title={`${members.length} ${members.length === 1 ? "member" : "members"}, ${present.length} online: ${members
                .map(
                  (member) =>
                    `${member.name}${onlineIds.has(member.id) ? " (online)" : ""}`
                )
                .join(", ")}`}
            >
              <div className="flex -space-x-1.5">
                {members.slice(0, 4).map((member) => (
                  <span
                    key={member.id}
                    className={cn(
                      "relative rounded ring-2 ring-background",
                      !onlineIds.has(member.id) && "opacity-45"
                    )}
                  >
                    <Avatar
                      id={member.id}
                      name={member.name}
                      kind="human"
                      size="sm"
                    />
                    {onlineIds.has(member.id) && (
                      <span className="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full bg-green-500 ring-2 ring-background" />
                    )}
                  </span>
                ))}
              </div>
              <span className="ml-1.5 text-xs font-medium text-muted-foreground">
                {members.length}
              </span>
              {requestCount > 0 && (
                <span
                  className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-highlight-500 px-1 text-[10px] font-semibold text-white"
                  title={`${requestCount} asked to join`}
                >
                  {requestCount}
                </span>
              )}
            </button>
          )}
          {showMembers && membership.data && (
            <MembersDialog
              channelId={channel.id}
              channelName={channel.name}
              membership={membership.data}
              people={people}
              selfId={person.id}
              initialTab={showMembers}
              onChanged={() => {
                membership.reload();
                onMembershipChanged();
              }}
              onClose={() => setShowMembers(null)}
            />
          )}
          <div
            className="flex rounded-lg border border-border p-0.5 lg:hidden"
            role="tablist"
          >
            {(["chat", "space"] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
                className={cn(
                  "rounded-md px-3 py-1 text-sm capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight",
                  tab === name && "bg-muted-background"
                )}
              >
                {name}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant={showSpace ? "outline" : "ghost"}
            icon={LayoutGrid01}
            label="Space"
            aria-pressed={showSpace}
            tooltip={showSpace ? "Hide the space" : "Show the space"}
            className="hidden lg:inline-flex"
            onClick={() => setShowSpace(!showSpace)}
          />
          <Button
            size="sm"
            variant={!inHuddle && huddlers.length > 0 ? "primary" : "outline"}
            icon={Headphones01}
            label={
              inHuddle
                ? "In huddle"
                : huddlers.length > 0
                  ? `Join huddle · ${huddlers.length}`
                  : "Huddle"
            }
            tooltip={
              huddlers.length > 0
                ? `In the huddle: ${huddlers.map((each) => each.name).join(", ")}`
                : "Start a huddle in this channel"
            }
            className={cn(
              !inHuddle &&
                huddlers.length > 0 &&
                "bg-green-600 hover:bg-green-700"
            )}
            onClick={() => void call()}
          />
        </header>
        <div className="relative flex min-h-0 flex-1">
          <section
            aria-label={`#${channel.name} chat`}
            className={cn(
              "min-h-0 w-full flex-col lg:flex",
              showSpace &&
                "lg:w-[420px] lg:shrink-0 lg:border-r lg:border-border",
              tab === "chat" ? "flex" : "hidden"
            )}
          >
            <ChatView
              channel={channel}
              person={person}
              onMessage={reload}
              onPresent={(next) => {
                setPresent(next);
                onPresent(new Set(next.map((member) => member.id)));
              }}
              onWriters={setWriters}
              inHuddle={inHuddle}
              humans={members}
              agentIds={membership.data?.agents ?? []}
              onUpload={async (file) => {
                const result = await uploadFile(channel.id, file);
                if (!result.ok) {
                  notify({
                    type: "error",
                    title: `Could not upload ${file.name}`,
                    description: result.error,
                  });
                  return null;
                }
                reload();
                return {
                  docName: result.data.docName,
                  title: result.data.title,
                };
              }}
              onOpenAttachment={setFocused}
            />
          </section>
          <section
            aria-label={`#${channel.name} space`}
            className={cn(
              "isolate min-h-0 min-w-0 flex-1 flex-col",
              showSpace ? "lg:flex" : "lg:hidden",
              tab === "space" ? "flex" : "hidden"
            )}
          >
            {!huddle && (
              <LiveObjectView
                className="min-h-0 flex-1"
                docId={channel.spaceDoc}
                agents={[]}
                renderHeader={renderSpaceHeader}
              />
            )}
          </section>
          {huddle && (
            <div className="absolute inset-0 z-40 flex flex-col bg-background p-3 dark:bg-background-night">
              <LiveObjectView
                key={huddle}
                className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border dark:border-border-night"
                docId={huddle}
                agents={channelAgents}
                onInCall={setInHuddle}
                stage={
                  <LiveObjectView
                    className="isolate min-h-0 flex-1"
                    docId={channel.spaceDoc}
                    agents={[]}
                    renderHeader={renderSpaceHeader}
                  />
                }
                renderHeader={({ title, actions }) => (
                  <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 dark:border-border-night">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {title}
                    </span>
                    {actions}
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={XClose}
                      tooltip="Back to the channel"
                      aria-label="Back to the channel"
                      onClick={() => setHuddle(null)}
                    />
                  </div>
                )}
              />
            </div>
          )}
          {focused && (
            <div className="absolute inset-0 z-50 flex flex-col bg-background p-3 dark:bg-background-night">
              <LiveObjectView
                key={focused}
                className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border dark:border-border-night"
                docId={focused}
                agents={[]}
                renderHeader={({ title, actions }) => (
                  <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 dark:border-border-night">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {title}
                    </span>
                    {actions}
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={XClose}
                      tooltip="Back to the channel"
                      aria-label="Back to the channel"
                      onClick={() => setFocused(null)}
                    />
                  </div>
                )}
              />
            </div>
          )}
        </div>
      </LiveHostProvider>
    </AirlinkViewProvider>
  );
}
