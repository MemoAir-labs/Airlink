import { agentConfigSchema } from "@memo-air/agents";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

export const personSchema = z.object({ id: z.string(), name: z.string() });
export type Person = z.infer<typeof personSchema>;
export const peopleSchema = z.object({ people: z.array(personSchema) });

export const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  chatDoc: z.string(),
  spaceDoc: z.string(),
  open: z.boolean(),
  // A channel the person just made comes back without these; they are in it.
  isMember: z.boolean().default(true),
  requested: z.boolean().default(false),
});
export type Channel = z.infer<typeof channelSchema>;

export const membershipSchema = z.object({
  open: z.boolean(),
  humans: z.array(z.string()),
  agents: z.array(z.string()),
  requests: z.array(
    z.object({ personId: z.string(), requestedAtMs: z.number() })
  ),
});
export type Membership = z.infer<typeof membershipSchema>;

const objectKindSchema = z.enum([
  "doc",
  "sheet",
  "canvas",
  "slides",
  "browser",
  "desktop",
  "media",
  "space",
  "file",
  "runner",
]);

export const objectSchema = z.object({
  docName: z.string(),
  channelId: z.string(),
  kind: objectKindSchema,
  title: z.string(),
});
export type ChannelObject = z.infer<typeof objectSchema>;

export const tokenSchema = z.object({
  url: z.string(),
  token: z.string(),
  access: z.enum(["read", "write", "suggest"]),
  liveDoc: z
    .object({
      sId: z.string(),
      title: z.string(),
      kind: objectKindSchema,
      conversationId: z.string().nullable(),
    })
    .nullable(),
  channelId: z.string(),
});
export type TokenResponse = z.infer<typeof tokenSchema>;

export const agentsSchema = z.object({ agents: z.array(agentConfigSchema) });
export type Agent = z.infer<typeof agentConfigSchema>;

export const harnessesSchema = z.object({
  harnesses: z.array(
    z.object({ id: z.string(), name: z.string(), command: z.array(z.string()) })
  ),
});

export const modelsSchema = z.object({
  models: z.array(z.object({ id: z.string(), name: z.string() })),
});

export const voiceSchema = z.object({ available: z.boolean() });

export const voicesSchema = z.object({
  voices: z.array(z.object({ id: z.string(), name: z.string() })),
});

export const settingsSchema = z.object({
  settings: z.object({
    providers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        saved: z.string().nullable(),
      })
    ),
    model: z.string(),
    harnesses: z.array(z.string()),
    memoryRoot: z.string(),
    speech: z.object({ elevenLabsKeySet: z.boolean() }),
    decide: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("model"), model: z.string().nullable() }),
      z.object({
        kind: z.literal("system-one"),
        url: z.string(),
        model: z.string(),
        apiKeySet: z.boolean(),
      }),
    ]),
  }),
});
export type PublicSettings = z.infer<typeof settingsSchema>["settings"];

const errorSchema = z.object({ error: z.string() });

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

// Every call to AirLink's own server: JSON in, a schema-checked body out, and the server's
// message when it refuses.
export async function api<T>(
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  init?: { method: "POST" | "PUT" | "DELETE"; body: unknown }
): Promise<ApiResult<T>> {
  const response = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init ? { "Content-Type": "application/json" } : undefined,
    body: init ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  }).catch(() => null);
  return readAnswer(response, schema);
}

export const maxFileBytes = 25_000_000;
export const fileInfoSchema = z.object({
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number(),
});

export const runnerInfoSchema = z.object({
  available: z.boolean(),
  frameBase: z.string(),
});

// The one call that is not JSON: the file's own bytes, named in a header.
export async function uploadFile(
  channelId: string,
  file: File
): Promise<ApiResult<z.infer<typeof objectSchema>>> {
  if (file.size > maxFileBytes) {
    return { ok: false, error: "Files can be up to 25 MB." };
  }
  const response = await fetch(`/api/channels/${channelId}/files`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
    credentials: "same-origin",
  }).catch(() => null);
  return readAnswer(response, z.object({ object: objectSchema })).then(
    (result) => (result.ok ? { ok: true, data: result.data.object } : result)
  );
}

async function readAnswer<T>(
  response: Response | null,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): Promise<ApiResult<T>> {
  if (!response) {
    return { ok: false, error: "AirLink is not reachable." };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body);
    return {
      ok: false,
      error: parsed.success ? parsed.data.error : `HTTP ${response.status}`,
    };
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: "Unexpected answer from AirLink." };
}

// ponytail: one fetch per mount plus manual reload; SWR-style caching when screens multiply.
export function useApi<T>(
  path: string | null,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
) {
  const [state, setState] = useState<{
    data: T | null;
    error: string | null;
    isLoading: boolean;
  }>({ data: null, error: null, isLoading: path !== null });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!path) {
      return;
    }
    let cancelled = false;
    setState((previous) => ({ ...previous, isLoading: true }));
    void api(path, schema).then((result) => {
      if (!cancelled) {
        setState(
          result.ok
            ? { data: result.data, error: null, isLoading: false }
            : { data: null, error: result.error, isLoading: false }
        );
      }
    });
    return () => {
      cancelled = true;
    };
    // `schema` is a module constant at every call site.
  }, [path, version]);

  return { ...state, reload };
}
