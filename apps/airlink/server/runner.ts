import type { LiveActor } from "@memo-air/protocol";
import { systemActor } from "@memo-air/protocol";
import type {
  RunnerLanguage,
  RunnerOutput,
  RunnerState,
  RunnerStatus,
} from "@memo-air/runner";
import {
  notSetUpText,
  runnerTailChars,
  tailOf,
  writeRunnerState,
} from "@memo-air/runner";
import type { createLiveServer } from "@memo-air/server";
import { z } from "zod";
import type { RunnerRow, Store } from "./store.ts";
import { workspaceId } from "./workspace.ts";

export const runTimeoutMs = 60_000;
export const toolTailChars = 8_000;
const controlGraceMs = 15_000;
const busyRetries = 15;
// control.mjs turns away a body much bigger than this, or more files.
export const maxInputBytes = 32_000_000;
export const maxInputFiles = 200;
const healthTimeoutMs = 3_000;
const healthTtlMs = 30_000;
const failuresBeforePause = 3;
const minuteMs = 60_000;
const restartedText = "AirLink restarted during this run.";

const controlResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  outputs: z.array(
    z.object({ name: z.string(), mime: z.string(), contentBase64: z.string() })
  ),
  notes: z.array(z.string()),
});

export type ControlResult = z.infer<typeof controlResultSchema>;
export type ControlRequest = {
  language: RunnerLanguage;
  code: string;
  files: { name: string; contentBase64: string }[];
  timeoutMs: number;
};
export type RunnerControl = {
  run(request: ControlRequest): Promise<ControlResult>;
  health(): Promise<boolean>;
};

export function controlClient({
  controlUrl,
  token,
  busyRetryMs = 2_000,
}: {
  controlUrl: string;
  token: string;
  busyRetryMs?: number;
}): RunnerControl {
  return {
    health: () =>
      fetch(`${controlUrl}/health`, {
        headers: { "x-runner-token": token },
        signal: AbortSignal.timeout(healthTimeoutMs),
      }).then(
        async (response) => {
          await response.body?.cancel();
          return response.ok;
        },
        () => false
      ),
    run: async (request) => {
      const body = JSON.stringify(request);
      const post = () =>
        fetch(`${controlUrl}/run`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-runner-token": token,
          },
          body,
          signal: AbortSignal.timeout(request.timeoutMs + controlGraceMs),
        });
      let response = await post();
      // 429 is the container's cap on runs at once: wait for a slot, then give up as busy.
      for (
        let retry = 0;
        response.status === 429 && retry < busyRetries;
        retry++
      ) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, busyRetryMs));
        response = await post();
      }
      if (response.status === 429) {
        throw new Error(
          "the runner is busy with other runs; try again shortly"
        );
      }
      if (!response.ok) {
        throw new Error(
          `the runner answered ${response.status}: ${(await response.text()).slice(0, 200)}`
        );
      }
      return controlResultSchema.parse(await response.json());
    },
  };
}

type Hocuspocus = ReturnType<typeof createLiveServer>["hocuspocus"];

// In process, as live-server writes a desktop's state; as the system actor, whose writes live-server
// does not count as edits, so a refresh every minute never wakes the room's agents.
export const docStateWriter =
  (hocuspocus: Hocuspocus) =>
  async (docName: string, patch: Partial<RunnerState>) => {
    const connection = await hocuspocus.openDirectConnection(docName, {
      actor: systemActor,
      access: "write",
      workspaceId,
    });
    try {
      await connection.transact((doc) => writeRunnerState(doc, patch));
    } finally {
      await connection.disconnect();
    }
  };

const listed = (names: string[]) =>
  `${names.slice(0, 10).join(", ")}${names.length > 10 ? ", …" : ""}`;

const leftOutNote = (names: string[]) =>
  `${names.length} of the channel's files ${names.length === 1 ? "was" : "were"} not given to the run (${listed(names)}): a run gets at most ${maxInputFiles} files and ${maxInputBytes / 1_000_000} MB, newest upload first.`;

const mediaNote = (names: string[]) =>
  `${names.length} audio or video file${names.length === 1 ? " was" : "s were"} not given to the run (${listed(names)}): runs get no audio or video.`;

// Upload names are people's: in /files each becomes one plain name, and a second "data.csv" is
// "data (2).csv".
export function inputFiles(
  files: { name: string; bytes: Buffer }[],
  skipped: string[] = [],
  media: string[] = []
): {
  files: { name: string; contentBase64: string }[];
  notes: string[];
} {
  const taken = new Set<string>();
  const kept: { name: string; contentBase64: string }[] = [];
  const left: string[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (
      kept.length >= maxInputFiles ||
      totalBytes + file.bytes.length > maxInputBytes
    ) {
      left.push(file.name);
      continue;
    }
    totalBytes += file.bytes.length;
    const plain =
      file.name
        .replace(/[/\\\0]/g, "_")
        .replace(/^\.{1,2}$/, "_")
        .slice(0, 180) || "file";
    const dot = plain.lastIndexOf(".");
    const stem = dot > 0 ? plain.slice(0, dot) : plain;
    const extension = dot > 0 ? plain.slice(dot) : "";
    let name = plain;
    for (let copy = 2; taken.has(name); copy++) {
      name = `${stem} (${copy})${extension}`;
    }
    taken.add(name);
    kept.push({ name, contentBase64: file.bytes.toString("base64") });
  }
  left.push(...skipped);
  return {
    files: kept,
    notes: [
      ...(left.length ? [leftOutNote(left)] : []),
      ...(media.length ? [mediaNote(media)] : []),
    ],
  };
}

export type RunOutcome =
  | {
      ok: true;
      docName: string;
      title: string;
      status: RunnerStatus;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      outputs: RunnerOutput[];
      notes: string[];
    }
  | { ok: false; text: string };

export function describeRun(outcome: RunOutcome): string {
  if (!outcome.ok) {
    return outcome.text;
  }
  const files = outcome.outputs.length
    ? outcome.outputs
        .map(
          (output) =>
            `${output.name} (${output.mime}, ${output.sizeBytes} bytes)`
        )
        .join(", ")
    : "none";
  return [
    `Runner ${outcome.docName} ("${outcome.title}"): ${outcome.status}${outcome.exitCode === null ? "" : `, exit code ${outcome.exitCode}`}.`,
    outcome.status === "timeout"
      ? `It was stopped after ${runTimeoutMs / 1000} s; below is what it printed before.`
      : null,
    `stdout (last ${toolTailChars} characters):\n${tailOf(outcome.stdout, toolTailChars) || "(empty)"}`,
    `stderr (last ${toolTailChars} characters):\n${tailOf(outcome.stderr, toolTailChars) || "(empty)"}`,
    `Output files: ${files}.${outcome.outputs.some((output) => output.name === "index.html") ? " index.html is shown as the runner's dashboard." : ""}`,
    ...outcome.notes,
  ]
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

export const unreachableText = `${notSetUpText} (the runner container is not reachable)`;

const failureNote = (err: unknown) => {
  const cause = err instanceof Error ? err.cause : undefined;
  if (
    cause instanceof Error &&
    "code" in cause &&
    cause.code === "ECONNREFUSED"
  ) {
    return unreachableText;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `The runner stopped during this run: ${message}${cause instanceof Error ? ` (${cause.message})` : ""}`;
};

const failed = (err: unknown): Finished => ({
  status: "error",
  exitCode: null,
  stdout: "",
  stderr: "",
  files: [],
  notes: [failureNote(err)],
});

type Finished = {
  status: RunnerStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  files: { name: string; mime: string; bytes: Buffer }[];
  notes: string[];
};

export type Runner = ReturnType<typeof createRunner>;

export function createRunner({
  store,
  control,
  writeState,
  postNote,
  logger,
  after = (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
}: {
  store: Store;
  control: RunnerControl | null;
  writeState: (docName: string, patch: Partial<RunnerState>) => Promise<void>;
  postNote: (chatDoc: string, text: string) => Promise<void>;
  logger: { error(obj: object, msg: string): void };
  after?: (ms: number, run: () => void) => () => void;
}) {
  const running = new Set<string>();
  const timers = new Map<string, () => void>();
  let closed = false;

  const disarm = (docName: string) => {
    timers.get(docName)?.();
    timers.delete(docName);
  };

  // The next tick is armed only after a run ends, so a slow script never has ticks stacking behind it.
  const arm = async (docName: string) => {
    const row = await store.runner(docName);
    disarm(docName);
    if (!closed && row && row.refreshMinutes > 0 && !row.paused) {
      timers.set(
        docName,
        after(row.refreshMinutes * minuteMs, () => void tick(docName))
      );
    }
  };

  const tick = async (docName: string) => {
    timers.delete(docName);
    try {
      if (!running.has(docName)) {
        await run(docName, systemActor, "schedule");
      }
      await arm(docName);
    } catch (err) {
      logger.error({ err, docName }, "runner: scheduled run failed");
    }
  };

  const afterRun = async (
    row: RunnerRow,
    status: RunnerStatus,
    trigger: "manual" | "schedule"
  ) => {
    if (status === "ok") {
      if (row.failures) {
        await store.setRunnerSchedule(row.docName, { failures: 0 });
      }
      return;
    }
    if (trigger !== "schedule") {
      return;
    }
    if ((await store.addRunnerFailure(row.docName)) < failuresBeforePause) {
      return;
    }
    await store.setRunnerSchedule(row.docName, { paused: true });
    await writeState(row.docName, { paused: true });
    await postNote(
      row.channel.chatDoc,
      `"${row.title}" failed ${failuresBeforePause} scheduled runs in a row, so its refresh is paused. Open it to see why, and resume it once it is fixed.`
    );
  };

  // Anything that throws in here still finishes the run, as an error with a note.
  const execute = async (
    withControl: RunnerControl,
    row: RunnerRow,
    actor: LiveActor
  ): Promise<Finished> => {
    // The doc shows the stored code, rewritten every run, so an edit someone made to the doc
    // never runs and never lingers.
    await writeState(row.docName, {
      title: row.title,
      language: row.language,
      code: row.code,
      status: "running",
      lastRunAt: new Date().toISOString(),
      lastRunBy: actor,
      refreshMinutes: row.refreshMinutes,
      paused: row.paused,
    });
    const picked = await store.channelFiles(row.channel.id, {
      maxFiles: maxInputFiles,
      maxBytes: maxInputBytes,
    });
    const inputs = inputFiles(picked.files, picked.skipped, picked.media);
    const result = await withControl.run({
      language: row.language,
      code: row.code,
      files: inputs.files,
      timeoutMs: runTimeoutMs,
    });
    return {
      status: result.timedOut
        ? "timeout"
        : result.exitCode === 0
          ? "ok"
          : "error",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      files: result.outputs.map((output) => ({
        name: output.name,
        mime: output.mime,
        bytes: Buffer.from(output.contentBase64, "base64"),
      })),
      notes: [...inputs.notes, ...result.notes],
    };
  };

  const run = async (
    docName: string,
    actor: LiveActor,
    trigger: "manual" | "schedule"
  ): Promise<RunOutcome> => {
    if (!control) {
      return { ok: false, text: notSetUpText };
    }
    if (running.has(docName)) {
      return {
        ok: false,
        text: "This runner is already running; wait for it to finish.",
      };
    }
    running.add(docName);
    try {
      const row = await store.runner(docName);
      if (!row) {
        return { ok: false, text: "That runner is gone." };
      }
      const runId = await store.startRun(docName, actor);
      const finished = await execute(control, row, actor).catch(failed);
      const outputs = finished.files.map((file) => ({
        name: file.name,
        mime: file.mime,
        sizeBytes: file.bytes.length,
      }));
      const recorded = await store.finishRun(runId, docName, {
        status: finished.status,
        exitCode: finished.exitCode,
        stdout: tailOf(finished.stdout, runnerTailChars),
        stderr: tailOf(finished.stderr, runnerTailChars),
        files: finished.files,
      });
      if (!recorded) {
        return { ok: false, text: "That runner is gone." };
      }
      // The run is recorded either way; a doc left at "running" would never let go of its window.
      try {
        await writeState(docName, {
          status: finished.status,
          outputs,
          hasDashboard: outputs.some((output) => output.name === "index.html"),
          stdout: finished.stdout,
          stderr: finished.stderr,
          notes: finished.notes,
        });
      } catch (err) {
        logger.error({ err, docName }, "runner: could not show a finished run");
        await writeState(docName, {
          status: "error",
          notes: [
            `The run finished (${finished.status}) but its result could not be shown: ${err instanceof Error ? err.message : String(err)}`,
          ],
        }).catch((again) =>
          logger.error(
            { err: again, docName },
            "runner: could not mark the run failed"
          )
        );
      }
      await afterRun(row, finished.status, trigger);
      return {
        ok: true,
        docName,
        title: row.title,
        status: finished.status,
        exitCode: finished.exitCode,
        stdout: finished.stdout,
        stderr: finished.stderr,
        outputs,
        notes: finished.notes,
      };
    } finally {
      running.delete(docName);
    }
  };

  let health: { atMs: number; up: Promise<boolean> } | null = null;
  // The container is probed, not assumed: a config that names a runner says nothing about whether
  // it is up. A probe answers for 30 s, so a window or a tool call never waits on more than one.
  const reachable = (): Promise<boolean> => {
    if (!control) {
      return Promise.resolve(false);
    }
    if (!health || Date.now() - health.atMs > healthTtlMs) {
      health = { atMs: Date.now(), up: control.health() };
    }
    return health.up;
  };

  return {
    available: control !== null,
    reachable,
    isRunning: (docName: string) => running.has(docName),
    run: (docName: string, actor: LiveActor) => run(docName, actor, "manual"),
    // Answers at once; the window follows the run through the doc.
    rerun: (
      docName: string,
      actor: LiveActor
    ): "started" | "running" | "unavailable" => {
      if (!control) {
        return "unavailable";
      }
      if (running.has(docName)) {
        return "running";
      }
      void run(docName, actor, "manual").catch((err) =>
        logger.error({ err, docName }, "runner: run failed")
      );
      return "started";
    },
    setPaused: async (docName: string, paused: boolean) => {
      await store.setRunnerSchedule(
        docName,
        paused ? { paused } : { paused, failures: 0 }
      );
      await writeState(docName, { paused });
      await arm(docName);
    },
    setRefresh: async (docName: string, refreshMinutes: number) => {
      await store.setRunnerSchedule(docName, {
        refreshMinutes,
        paused: false,
        failures: 0,
      });
      await writeState(docName, { refreshMinutes, paused: false });
      await arm(docName);
    },
    // Once, at start: runs the last process left open are closed as failed, and every schedule is
    // armed again from Postgres.
    start: async () => {
      for (const docName of await store.failUnfinishedRuns(restartedText)) {
        await writeState(docName, {
          status: "error",
          notes: [restartedText],
        }).catch((err) =>
          logger.error({ err, docName }, "runner: could not mark a stale run")
        );
      }
      for (const docName of await store.scheduledRunners()) {
        await arm(docName);
      }
    },
    forget: disarm,
    close: () => {
      closed = true;
      for (const docName of [...timers.keys()]) {
        disarm(docName);
      }
    },
  };
}
