import {
  Button,
  cn,
  Hash02,
  Home02,
  Icon,
  Input,
  Moon01,
  Plus,
  Settings02,
  Spinner,
  Sun,
  useSendNotification,
} from "@memo-air/react/ui";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Avatar } from "./Avatar.tsx";
import type { Person } from "./api.ts";
import {
  agentsSchema,
  api,
  channelSchema,
  peopleSchema,
  personSchema,
  useApi,
} from "./api.ts";
import { Channel } from "./Channel.tsx";
import { Home } from "./Home.tsx";
import { Join } from "./Join.tsx";
import { JoinChannel } from "./JoinChannel.tsx";
import memoairMark from "./memoair.svg";
import { ProfilePage } from "./ProfilePage.tsx";
import { Settings } from "./Settings.tsx";

const meSchema = z.object({ person: personSchema });
const channelsSchema = z.object({ channels: z.array(channelSchema) });
const createdSchema = z.object({ channel: channelSchema });

type Route =
  | { page: "home" }
  | { page: "channel"; id: string }
  | { page: "agent"; id: string }
  | { page: "person"; id: string };

function readRoute(): Route | null {
  const [, page, id] = window.location.hash.split("/");
  if (page === "home") {
    return { page: "home" };
  }
  if (page === "agent" && id) {
    return { page: "agent", id };
  }
  if (page === "person" && id) {
    return { page: "person", id };
  }
  return page === "c" && id ? { page: "channel", id } : null;
}

function useRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function useTheme() {
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );
  const toggle = () => {
    const next = !isDark;
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("airlink-theme", next ? "dark" : "light");
    } catch {
      // A private window keeps the choice for this tab only.
    }
    setIsDark(next);
  };
  return { isDark, toggle };
}

export function App() {
  const me = useApi("/api/me", meSchema);
  const [joined, setJoined] = useState<Person | null>(null);
  const person = joined ?? me.data?.person ?? null;

  if (me.isLoading && !joined) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return person ? <Workspace person={person} /> : <Join onJoined={setJoined} />;
}

function Workspace({ person }: { person: Person }) {
  const route = useRoute();
  const theme = useTheme();
  const notify = useSendNotification();
  const channels = useApi("/api/channels", channelsSchema);
  const agentsApi = useApi("/api/agents", agentsSchema);
  const agents = agentsApi.data?.agents ?? [];
  const people = useApi("/api/people", peopleSchema).data?.people ?? [];
  // You first, then everyone else in the workspace, most recently here first.
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const humans = [
    person,
    ...people.filter((member) => member.id !== person.id),
  ];
  const [newName, setNewName] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = channels.data?.channels ?? [];
  const current =
    route ?? (list[0] ? { page: "channel", id: list[0].id } : null);
  const channel =
    current?.page === "channel"
      ? list.find((candidate) => candidate.id === current.id)
      : undefined;

  const create = async () => {
    const result = await api("/api/channels", createdSchema, {
      method: "POST",
      body: { name: newName ?? "" },
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNewName(null);
    setError(null);
    channels.reload();
    window.location.hash = `#/c/${result.data.channel.id}`;
  };

  // A new agent is written straight away and opened on its own page, where it is edited.
  const createAgent = async () => {
    const agents = agentsApi.data?.agents;
    if (!agents) {
      return;
    }
    const id = `agent-${Math.random().toString(36).slice(2, 7)}`;
    const result = await api("/api/agents", agentsSchema, {
      method: "PUT",
      body: [...agents, { id, name: "New agent", harness: "pi" }],
    });
    if (!result.ok) {
      notify({ type: "error", title: result.error });
      return;
    }
    agentsApi.reload();
    window.location.hash = `#/agent/${id}`;
  };

  const railItem = (active: boolean) =>
    cn(
      "flex h-8 items-center gap-2 rounded-md px-2 text-[15px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
      active
        ? "bg-linear-to-r from-sidebar-active to-sidebar-active-to font-medium text-white shadow-sm"
        : "text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground"
    );
  const sectionLabel =
    "mt-5 mb-1 flex h-7 items-center justify-between px-2 text-[13px] font-medium text-sidebar-muted";

  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label="AirLink"
        className="flex w-64 shrink-0 flex-col bg-sidebar px-2 pb-3 text-sidebar-foreground"
      >
        <div className="-mx-2 mb-3 flex h-12 items-center gap-2 border-b border-sidebar-border px-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15">
            <img src={memoairMark} alt="" className="h-7 w-7" />
          </span>
          <span className="text-[20px] font-bold tracking-tight">AirLink</span>
        </div>
        <a href="#/home" className={railItem(current?.page === "home")}>
          <Icon visual={Home02} size="sm" />
          Home
        </a>
        <div className={sectionLabel}>
          Channels
          <Button
            size="xs"
            variant="ghost"
            icon={Plus}
            tooltip="New channel"
            aria-label="New channel"
            className="text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground"
            onClick={() => setNewName("")}
          />
        </div>
        {list.map((item) => (
          <a
            key={item.id}
            href={`#/c/${item.id}`}
            className={cn(
              railItem(channel?.id === item.id),
              !item.isMember && channel?.id !== item.id && "opacity-55"
            )}
            aria-current={channel?.id === item.id ? "page" : undefined}
            title={item.isMember ? undefined : "Invite only — ask to join"}
          >
            <Icon visual={Hash02} size="sm" />
            <span className="truncate">{item.name}</span>
          </a>
        ))}
        {newName !== null && (
          <form
            className="px-1 pt-1"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <Input
              autoFocus
              placeholder="channel-name"
              aria-label="New channel name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setNewName(null);
                  setError(null);
                }
              }}
              message={error}
              messageStatus="error"
            />
          </form>
        )}
        <div className={sectionLabel}>Humans</div>
        {humans.map((member) => (
          <a
            key={member.id}
            href={`#/person/${member.id}`}
            className={railItem(
              current?.page === "person" && current.id === member.id
            )}
            title={`${member.name} · ${member.id === person.id || onlineIds.has(member.id) ? "online" : "away"}`}
          >
            <span
              className={cn(
                "relative",
                member.id !== person.id &&
                  !onlineIds.has(member.id) &&
                  "opacity-50"
              )}
            >
              <Avatar
                id={member.id}
                name={member.name}
                kind="human"
                size="sm"
              />
              {(member.id === person.id || onlineIds.has(member.id)) && (
                <span className="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full bg-green-500 ring-2 ring-sidebar" />
              )}
            </span>
            <span className="truncate">
              {member.name}
              {member.id === person.id && (
                <span className="opacity-70"> (you)</span>
              )}
            </span>
          </a>
        ))}
        <div className={sectionLabel}>
          Agents
          <span className="flex items-center gap-0.5">
            <Button
              size="xs"
              variant="ghost"
              icon={Plus}
              tooltip="New agent"
              aria-label="New agent"
              className="text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground"
              onClick={() => void createAgent()}
            />
          </span>
        </div>
        {agents.map((agent) => (
          <a
            key={agent.id}
            href={`#/agent/${agent.id}`}
            className={railItem(
              current?.page === "agent" && current.id === agent.id
            )}
            title={agent.role || agent.name}
          >
            <span className="relative">
              <Avatar id={agent.id} name={agent.name} kind="agent" size="sm" />
              <span className="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full bg-green-500 ring-2 ring-sidebar" />
            </span>
            <span className="truncate">{agent.name}</span>
          </a>
        ))}

        <div className="mt-auto flex flex-col gap-0.5 border-t border-sidebar-border pt-2">
          <button
            type="button"
            className={cn(railItem(settingsOpen), "w-full")}
            onClick={() => setSettingsOpen(true)}
          >
            <Icon visual={Settings02} size="sm" />
            Settings
          </button>
          <div className="flex items-center gap-2 px-2 pt-1">
            <span className="relative">
              <Avatar
                id={person.id}
                name={person.name}
                kind="human"
                size="sm"
              />
              <span className="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full bg-green-500 ring-2 ring-sidebar" />
            </span>
            <span
              className="min-w-0 flex-1 truncate text-sm font-medium"
              title={person.name}
            >
              {person.name}
            </span>
            <Button
              size="xs"
              variant="ghost"
              icon={theme.isDark ? Sun : Moon01}
              tooltip={theme.isDark ? "Light theme" : "Dark theme"}
              aria-label={
                theme.isDark ? "Use the light theme" : "Use the dark theme"
              }
              className="text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground"
              onClick={theme.toggle}
            />
          </div>
        </div>
      </nav>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {current?.page === "home" && (
          <Home
            channels={list}
            agents={agents}
            onOpenSettings={() => setSettingsOpen(true)}
            onNewChannel={() => setNewName("")}
            onNewAgent={createAgent}
          />
        )}
        {current?.page === "agent" &&
          (() => {
            const agent = agents.find((each) => each.id === current.id);
            return agent ? (
              <ProfilePage
                key={agent.id}
                profile={{ kind: "agent", agent }}
                onAgentSaved={agentsApi.reload}
              />
            ) : null;
          })()}
        {current?.page === "person" &&
          (() => {
            const member = humans.find((each) => each.id === current.id);
            return member ? (
              <ProfilePage
                key={member.id}
                onAgentSaved={agentsApi.reload}
                profile={{
                  kind: "human",
                  person: member,
                  isSelf: member.id === person.id,
                  isOnline: member.id === person.id || onlineIds.has(member.id),
                }}
              />
            ) : null;
          })()}
        {current?.page === "channel" &&
          (channel && !channel.isMember ? (
            <JoinChannel
              key={channel.id}
              channel={channel}
              onChanged={channels.reload}
            />
          ) : channel ? (
            <Channel
              key={channel.id}
              channel={channel}
              person={person}
              isDark={theme.isDark}
              onPresent={setOnlineIds}
              onMembershipChanged={channels.reload}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : channels.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              That channel does not exist.
            </p>
          ))}
      </main>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
