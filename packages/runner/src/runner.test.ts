import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  emptyRunnerState,
  isRunnerDoc,
  readRunnerState,
  runnerState,
  runnerTailChars,
  writeRunnerState,
} from "./index.ts";

const juno = { kind: "agent" as const, id: "juno", name: "Juno" };

describe("runner model", () => {
  it("reads defaults until AirLink writes it, then what was written", () => {
    const doc = new Y.Doc();
    expect(isRunnerDoc(doc)).toBe(false);
    expect(readRunnerState(doc)).toEqual(emptyRunnerState);
    writeRunnerState(doc, {
      ...emptyRunnerState,
      title: "Q3",
      language: "node",
      code: "console.log(1)",
    });
    expect(isRunnerDoc(doc)).toBe(true);
    writeRunnerState(doc, {
      status: "ok",
      lastRunAt: "2026-10-20T10:00:00.000Z",
      lastRunBy: juno,
      outputs: [{ name: "chart.png", mime: "image/png", sizeBytes: 10 }],
      hasDashboard: true,
      notes: ["1 file was left out: a run keeps at most 20 files and 50 MB."],
    });
    expect(readRunnerState(doc)).toEqual({
      ...emptyRunnerState,
      title: "Q3",
      language: "node",
      code: "console.log(1)",
      status: "ok",
      lastRunAt: "2026-10-20T10:00:00.000Z",
      lastRunBy: juno,
      outputs: [{ name: "chart.png", mime: "image/png", sizeBytes: 10 }],
      hasDashboard: true,
      notes: ["1 file was left out: a run keeps at most 20 files and 50 MB."],
    });
  });

  it("keeps the last 20 000 characters of each stream", () => {
    const doc = new Y.Doc();
    writeRunnerState(doc, {
      stdout: `${"a".repeat(5)}${"b".repeat(runnerTailChars)}`,
      stderr: "short",
    });
    expect(readRunnerState(doc).stdout).toBe("b".repeat(20_000));
    expect(readRunnerState(doc).stderr).toBe("short");
  });

  it("reads a field someone wrote wrong as its default", () => {
    const doc = new Y.Doc();
    writeRunnerState(doc, { status: "ok", refreshMinutes: 5 });
    runnerState(doc).set("status", "exploded");
    runnerState(doc).set("refreshMinutes", -3);
    runnerState(doc).set("lastRunAt", "not a date");
    expect(readRunnerState(doc)).toMatchObject({
      status: "idle",
      refreshMinutes: 0,
      lastRunAt: null,
    });
  });
});
