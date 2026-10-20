import {
  Button,
  Check,
  cn,
  Icon,
  Search,
  UserPlus,
  useSendNotification,
  XClose,
} from "@memo-air/react/ui";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Avatar } from "./Avatar.tsx";
import type { Membership } from "./api.ts";
import { agentsSchema, api, useApi } from "./api.ts";

const copiedMs = 2000;
const okSchema = z.object({ ok: z.boolean() });

type Person = { id: string; name: string; online: boolean };
export type MembersTab = "members" | "agents" | "requests" | "add";

// Who is in a channel and who may come in. #general is open to everyone; any other channel holds
// only the people and agents its members added, and a person outside asks to join. AirLink keeps
// no accounts, so a newcomer arrives through the channel's link, picks a name and asks.
export function MembersDialog({
  channelId,
  channelName,
  membership,
  people,
  selfId,
  initialTab,
  onChanged,
  onClose,
}: {
  channelId: string;
  channelName: string;
  membership: Membership;
  // Everyone in the workspace, with whether they have this channel open.
  people: Person[];
  selfId: string;
  initialTab: MembersTab;
  onChanged: () => void;
  onClose: () => void;
}) {
  const notify = useSendNotification();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<MembersTab>(initialTab);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const agents = useApi("/api/agents", agentsSchema).data?.agents ?? [];

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const humanIds = new Set(membership.humans);
  const agentIds = new Set(membership.agents);
  const byId = new Map(people.map((each) => [each.id, each]));
  const nameOf = (id: string) => byId.get(id)?.name ?? "Someone";
  const needle = query.trim().toLowerCase();
  const matches = (...texts: string[]) =>
    texts.some((text) => text.toLowerCase().includes(needle));

  const members = membership.humans
    .map((id) => byId.get(id) ?? { id, name: nameOf(id), online: false })
    .filter((member) => matches(member.name))
    .sort((a, b) => Number(b.online) - Number(a.online));
  const channelAgents = agents.filter(
    (agent) => agentIds.has(agent.id) && matches(agent.name, agent.role)
  );
  const addablePeople = people.filter(
    (each) => !humanIds.has(each.id) && matches(each.name)
  );
  const addableAgents = agents.filter(
    (agent) => !agentIds.has(agent.id) && matches(agent.name, agent.role)
  );
  const requests = membership.requests.filter((request) =>
    matches(nameOf(request.personId))
  );

  const change = async (
    path: string,
    init: { method: "POST" | "DELETE"; body: unknown },
    failure: string
  ) => {
    const result = await api(path, okSchema, init);
    if (!result.ok) {
      notify({ type: "error", title: failure, description: result.error });
    }
    onChanged();
  };
  const add = (kind: "human" | "agent", id: string) =>
    change(
      `/api/channels/${channelId}/members`,
      { method: "POST", body: { kind, id } },
      "Could not add them"
    );
  const remove = (kind: "human" | "agent", id: string) =>
    change(
      `/api/channels/${channelId}/members/${kind}/${encodeURIComponent(id)}`,
      { method: "DELETE", body: {} },
      "Could not remove them"
    );
  const decline = (personId: string) =>
    change(
      `/api/channels/${channelId}/join-requests/${encodeURIComponent(personId)}`,
      { method: "DELETE", body: {} },
      "Could not decline"
    );

  const link = window.location.href;
  const isLocalOnly = ["localhost", "127.0.0.1"].includes(
    window.location.hostname
  );
  const copyLink = async () => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), copiedMs);
  };

  const tabs: { name: MembersTab; label: string }[] = [
    { name: "members", label: `Members ${membership.humans.length}` },
    { name: "agents", label: `Agents ${membership.agents.length}` },
    ...(membership.requests.length > 0
      ? [
          {
            name: "requests" as const,
            label: `Requests ${membership.requests.length}`,
          },
        ]
      : []),
    ...(membership.open ? [] : [{ name: "add" as const, label: "Add" }]),
  ];
  const tabClass = (name: MembersTab) =>
    cn(
      "-mb-px border-b-2 px-1 pb-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight",
      tab === name
        ? "border-foreground text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground"
    );
  const row = "flex items-center gap-3 rounded-lg px-3 py-2";
  const empty = (text: string) => (
    <li className="px-3 py-6 text-center text-sm text-muted-foreground">
      {text}
    </li>
  );
  const removeButton = (kind: "human" | "agent", id: string, name: string) =>
    !membership.open && (
      <Button
        size="xs"
        variant="ghost-secondary"
        label={id === selfId ? "Leave" : "Remove"}
        aria-label={id === selfId ? "Leave the channel" : `Remove ${name}`}
        onClick={() => void remove(kind, id)}
      />
    );

  return (
    <dialog
      ref={dialogRef}
      aria-label={`#${channelName} members`}
      className="m-auto w-[min(560px,calc(100vw-32px))] rounded-2xl border border-border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          dialogRef.current?.close();
        }
      }}
    >
      <div className="flex h-[min(560px,calc(100vh-64px))] flex-col">
        <header className="flex items-center justify-between px-6 pt-5 pb-3">
          <div>
            <h2 className="text-xl font-bold">#{channelName}</h2>
            <p className="text-xs text-muted-foreground">
              {membership.open
                ? "Open to everyone in the workspace."
                : "Invite only. Members add people and agents."}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight"
            onClick={() => dialogRef.current?.close()}
          >
            <Icon visual={XClose} size="sm" />
          </button>
        </header>
        <div role="tablist" className="flex gap-5 border-b border-border px-6">
          {tabs.map((each) => (
            <button
              key={each.name}
              type="button"
              role="tab"
              aria-selected={tab === each.name}
              className={tabClass(each.name)}
              onClick={() => setTab(each.name)}
            >
              {each.label}
            </button>
          ))}
        </div>
        <div className="px-6 pt-4">
          <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 focus-within:border-highlight focus-within:ring-2 focus-within:ring-highlight/30">
            <Icon visual={Search} size="sm" className="text-muted-foreground" />
            <input
              type="search"
              autoFocus
              value={query}
              placeholder={tab === "add" ? "Find people and agents" : "Find"}
              aria-label="Find"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {tab === "members" && (
            <>
              <li>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight"
                  onClick={() => void copyLink()}
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-highlight-100 text-highlight-700">
                    <Icon visual={copied ? Check : UserPlus} size="sm" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-semibold">
                      {copied ? "Link copied" : "Copy the channel's link"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {isLocalOnly
                        ? "On localhost it only opens on this computer; run with AIRLINK_HOST=0.0.0.0 to share it on your network."
                        : membership.open
                          ? "Whoever opens it picks a name and is in."
                          : "Whoever opens it picks a name and asks to join."}
                    </span>
                  </span>
                </button>
              </li>
              {members.map((member) => (
                <li key={member.id} className={row}>
                  <span className="relative">
                    <Avatar id={member.id} name={member.name} kind="human" />
                    {member.online && (
                      <span className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-background" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {member.name}
                    {member.id === selfId && (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        (you)
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {member.online ? "Online" : "Away"}
                  </span>
                  {removeButton("human", member.id, member.name)}
                </li>
              ))}
              {members.length === 0 &&
                needle &&
                empty(`No one matches “${query}”.`)}
            </>
          )}
          {tab === "agents" && (
            <>
              {channelAgents.map((agent) => (
                <li key={agent.id} className={row}>
                  <Avatar id={agent.id} name={agent.name} kind="agent" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-semibold">
                      {agent.name}
                    </span>
                    {agent.role && (
                      <span className="truncate text-xs text-muted-foreground">
                        {agent.role}
                      </span>
                    )}
                  </span>
                  {removeButton("agent", agent.id, agent.name)}
                </li>
              ))}
              {channelAgents.length === 0 &&
                empty(
                  needle
                    ? `No agent matches “${query}”.`
                    : "No agent is in this channel, so nobody answers. Add one."
                )}
            </>
          )}
          {tab === "requests" &&
            requests.map((request) => (
              <li key={request.personId} className={row}>
                <Avatar
                  id={request.personId}
                  name={nameOf(request.personId)}
                  kind="human"
                />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                  {nameOf(request.personId)}
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    asked to join
                  </span>
                </span>
                <Button
                  size="xs"
                  variant="ghost-secondary"
                  label="Decline"
                  onClick={() => void decline(request.personId)}
                />
                <Button
                  size="xs"
                  label="Let in"
                  onClick={() => void add("human", request.personId)}
                />
              </li>
            ))}
          {tab === "add" && (
            <>
              {addablePeople.map((each) => (
                <li key={each.id} className={row}>
                  <Avatar id={each.id} name={each.name} kind="human" />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {each.name}
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    label="Add"
                    aria-label={`Add ${each.name}`}
                    onClick={() => void add("human", each.id)}
                  />
                </li>
              ))}
              {addableAgents.map((agent) => (
                <li key={agent.id} className={row}>
                  <Avatar id={agent.id} name={agent.name} kind="agent" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-semibold">
                      {agent.name}
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · agent
                      </span>
                    </span>
                    {agent.role && (
                      <span className="truncate text-xs text-muted-foreground">
                        {agent.role}
                      </span>
                    )}
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    label="Add"
                    aria-label={`Add ${agent.name}`}
                    onClick={() => void add("agent", agent.id)}
                  />
                </li>
              ))}
              {addablePeople.length === 0 &&
                addableAgents.length === 0 &&
                empty(
                  needle
                    ? `No one matches “${query}”.`
                    : "Everyone in the workspace is already here."
                )}
            </>
          )}
        </ul>
      </div>
    </dialog>
  );
}
