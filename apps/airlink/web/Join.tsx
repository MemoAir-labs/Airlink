import { Button, Input } from "@memo-air/react/ui";
import { useState } from "react";
import { z } from "zod";
import type { Person } from "./api.ts";
import { api, personSchema } from "./api.ts";

const joinSchema = z.object({ person: personSchema });

interface JoinProps {
  onJoined: (person: Person) => void;
}

export function Join({ onJoined }: JoinProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);

  const join = async () => {
    setIsJoining(true);
    const result = await api("/api/me", joinSchema, {
      method: "POST",
      body: { name },
    });
    setIsJoining(false);
    if (result.ok) {
      onJoined(result.data.person);
    } else {
      setError(result.error);
    }
  };

  return (
    <main className="flex h-full items-center justify-center bg-sidebar p-6">
      <form
        className="flex w-full max-w-sm flex-col gap-5 rounded-2xl bg-background p-8 shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          void join();
        }}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-sidebar text-xl font-bold text-sidebar-foreground">
            A
          </span>
          <h1 className="text-2xl font-bold tracking-tight">Join AirLink</h1>
          <p className="text-sm text-muted-foreground">
            One room for people and agents. Everyone here sees the same chat,
            the same space and the same huddle.
          </p>
        </div>
        <Input
          label="Your name"
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          message={error}
          messageStatus="error"
        />
        <Button
          type="submit"
          label="Join"
          size="sm"
          className="h-10 text-[15px]"
          isLoading={isJoining}
          disabled={!name.trim()}
        />
      </form>
    </main>
  );
}
