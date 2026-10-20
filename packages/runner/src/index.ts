import type * as Y from "yjs";
import { z } from "zod";

export type RunnerLanguage = "python" | "node";
export type RunnerStatus = "idle" | "running" | "ok" | "error" | "timeout";
export type RunnerOutput = { name: string; mime: string; sizeBytes: number };

export const runnerTailChars = 20_000;
export const notSetUpText = "Code running is not set up on this server.";

const actorSchema = z.object({
  kind: z.enum(["human", "agent"]),
  id: z.string(),
  name: z.string(),
});

// AirLink is the only intended writer, but every member holds a write token for the doc, so a
// field written wrong reads as its default instead of breaking the window.
const runnerStateSchema = z.object({
  title: z.string().catch(""),
  language: z.enum(["python", "node"]).catch("python"),
  code: z.string().catch(""),
  status: z.enum(["idle", "running", "ok", "error", "timeout"]).catch("idle"),
  lastRunAt: z.string().datetime().nullable().catch(null),
  lastRunBy: actorSchema.nullable().catch(null),
  refreshMinutes: z.number().int().min(0).catch(0),
  paused: z.boolean().catch(false),
  outputs: z
    .array(
      z.object({ name: z.string(), mime: z.string(), sizeBytes: z.number() })
    )
    .catch([]),
  hasDashboard: z.boolean().catch(false),
  stdout: z.string().catch(""),
  stderr: z.string().catch(""),
  notes: z.array(z.string()).catch([]),
});

export type RunnerState = z.infer<typeof runnerStateSchema>;

export const emptyRunnerState: RunnerState = runnerStateSchema.parse({});

export const runnerState = (doc: Y.Doc) => doc.getMap<unknown>("runnerState");

export function isRunnerDoc(doc: Y.Doc): boolean {
  return typeof runnerState(doc).get("status") === "string";
}

export function readRunnerState(doc: Y.Doc): RunnerState {
  return runnerStateSchema.parse(runnerState(doc).toJSON());
}

// The end of a long stream is what says why a script failed.
export const tailOf = (text: string, maxChars: number) =>
  text.length > maxChars ? text.slice(text.length - maxChars) : text;

export function writeRunnerState(doc: Y.Doc, patch: Partial<RunnerState>) {
  const state = runnerState(doc);
  doc.transact(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        continue;
      }
      state.set(
        key,
        typeof value === "string" && (key === "stdout" || key === "stderr")
          ? tailOf(value, runnerTailChars)
          : value
      );
    }
  });
}
