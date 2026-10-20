import { liveDocIcon } from "@memo-air/react";
import { Icon, Spinner } from "@memo-air/react/ui";
import { formatDistanceToNow } from "date-fns";
import { z } from "zod";
import type { Channel } from "./api.ts";
import { homeSchema, personSchema, useApi } from "./api.ts";

const meSchema = z.object({ person: personSchema });

interface HomeProps {
  channels: Channel[];
}

// What needs the person (suggestions waiting on them) and what changed since they last opened
// each object, across every channel.
export function Home({ channels }: HomeProps) {
  const home = useApi("/api/home", homeSchema);
  const me = useApi("/api/me", meSchema).data?.person;

  if (home.isLoading || !me) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const items = home.data?.items ?? [];
  const needsYou = items.filter(({ summary }) =>
    summary.pending.some(
      (pending) => pending.approverId === null || pending.approverId === me.id
    )
  );
  const whileAway = items
    .filter(
      ({ summary }) =>
        summary.lastEditedAt &&
        summary.lastEditor?.id !== me.id &&
        (!summary.seenAt || summary.lastEditedAt > summary.seenAt)
    )
    .sort((a, b) =>
      (b.summary.lastEditedAt ?? "").localeCompare(a.summary.lastEditedAt ?? "")
    );
  const channelHref = (channelId: string) =>
    channels.some((channel) => channel.id === channelId)
      ? `#/c/${channelId}`
      : "#/home";

  const row = (item: (typeof items)[number], detail: string) => (
    <li key={item.object.docName}>
      <a
        href={channelHref(item.object.channelId)}
        className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight dark:hover:bg-muted-background-night"
      >
        <Icon visual={liveDocIcon(item.object.kind)} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {item.object.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground dark:text-muted-foreground-night">
            #{item.channelName} · {detail}
          </span>
        </span>
      </a>
    </li>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-8">
        <h1 className="text-2xl font-semibold">Home</h1>
        {home.error && (
          <p role="alert" className="text-sm text-warning-600">
            {home.error}
          </p>
        )}
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Needs you</h2>
          {needsYou.length ? (
            <ul>
              {needsYou.map((item) => {
                const count = item.summary.pending.length;
                const first = item.summary.pending[0];
                return row(
                  item,
                  `${count} suggestion${count === 1 ? "" : "s"} from ${first?.actor.name ?? "an agent"}`
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground dark:text-muted-foreground-night">
              Nothing is waiting on you.
            </p>
          )}
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">While you were away</h2>
          {whileAway.length ? (
            <ul>
              {whileAway.map((item) =>
                row(
                  item,
                  `${item.summary.lastEditor?.kind === "agent" ? "✦ " : ""}${item.summary.lastEditor?.name ?? "Someone"} edited it ${formatDistanceToNow(new Date(item.summary.lastEditedAt ?? 0), { addSuffix: true })}`
                )
              )}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground dark:text-muted-foreground-night">
              You have seen everything.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
