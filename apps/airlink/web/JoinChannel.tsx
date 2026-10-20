import { Button, Hash02, Icon } from "@memo-air/react/ui";
import { useEffect, useState } from "react";
import { z } from "zod";
import type { Channel } from "./api.ts";
import { api } from "./api.ts";

const okSchema = z.object({ ok: z.boolean() });
const checkEveryMs = 5000;

// A channel this person is not in: they can see it exists and ask; a member lets them in, and the
// channel opens here on its own once they do.
export function JoinChannel({
  channel,
  onChanged,
}: {
  channel: Channel;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!channel.requested) {
      return;
    }
    const timer = setInterval(onChanged, checkEveryMs);
    return () => clearInterval(timer);
  }, [channel.requested, onChanged]);

  const send = async (method: "POST" | "DELETE") => {
    const result = await api(
      method === "POST"
        ? `/api/channels/${channel.id}/join-requests`
        : `/api/channels/${channel.id}/join-requests/me`,
      okSchema,
      { method, body: {} }
    );
    setError(result.ok ? null : result.error);
    onChanged();
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted-background">
        <Icon visual={Hash02} size="md" className="text-muted-foreground" />
      </span>
      <div>
        <h1 className="text-xl font-bold">#{channel.name}</h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {channel.requested
            ? "You asked to join. A member will let you in, and the channel opens here when they do."
            : "This channel is invite only. Ask to join and a member can let you in."}
        </p>
      </div>
      {channel.requested ? (
        <Button
          variant="outline"
          label="Withdraw request"
          onClick={() => void send("DELETE")}
        />
      ) : (
        <Button label="Ask to join" onClick={() => void send("POST")} />
      )}
      {error && (
        <p role="alert" className="text-sm text-warning-600">
          {error}
        </p>
      )}
    </div>
  );
}
