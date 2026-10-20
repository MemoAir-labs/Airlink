// The code runner's control server: AirLink posts a script and its channel's files, and each run
// gets a fresh directory and a bubblewrap jail that sees only that directory, a read-only /usr and
// /etc, and the network. Whoever holds the token can run code here, so the port stays on loopback
// and the token stays out of every jail (--clearenv, its own PID namespace, a fresh /proc).
import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

const maxCodeChars = 200_000;
// AirLink sends at most 32 MB of files (maxInputBytes in apps/airlink/server/runner.ts), which is
// about 43 MB once base64; the rest is headroom for the code and the JSON around it.
const maxBodyBytes = 48 * 1024 * 1024;
const maxInputFiles = 200;
const minTimeoutMs = 1000;
const maxTimeoutMs = 60_000;
const maxOutputBytes = 50 * 1024 * 1024;
const maxOutputFiles = 20;
const tailChars = 20_000;
const memoryBytes = 1024 * 1024 * 1024;
const nodeHeapMb = 768;
const maxProcesses = 256;
const maxConcurrentRuns = 2;
const walkMaxEntries = 10_000;
const walkMaxDepth = 16;
const jailPath = "/usr/local/bin:/usr/bin:/bin";
const fileNamePattern = /^[^/\\\0]{1,200}$/;
const allowedHostnames = ["localhost", "127.0.0.1", "[::1]", "runner"];

const mimes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const mimeOf = (name) => {
  const extension = extname(name).toLowerCase();
  return Object.hasOwn(mimes, extension)
    ? mimes[extension]
    : "application/octet-stream";
};

class BadRequest extends Error {}

const digest = (value) => createHash("sha256").update(value).digest();

// The argv for prlimit, which applies the per-run limits and execs bwrap with them; choom makes a
// jail the kernel's first choice when the container runs out of memory, not the control server.
export function jailArgv({ dir, language }) {
  const command =
    language === "python"
      ? ["python3", "/code/main.py"]
      : ["node", `--max-old-space-size=${nodeHeapMb}`, "/code/main.mjs"];
  return [
    `--nproc=${maxProcesses}`,
    `--fsize=${maxOutputBytes}`,
    ...(language === "python" ? [`--as=${memoryBytes}`] : []),
    "--",
    "choom",
    "-n",
    "1000",
    "--",
    "bwrap",
    "--unshare-user",
    "--disable-userns",
    "--uid",
    "65534",
    "--gid",
    "65534",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--hostname",
    "runner",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/etc",
    "/etc",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--bind",
    join(dir, "tmp"),
    "/tmp",
    "--ro-bind",
    join(dir, "code"),
    "/code",
    "--ro-bind",
    join(dir, "files"),
    "/files",
    "--bind",
    join(dir, "out"),
    "/out",
    "--setenv",
    "PATH",
    jailPath,
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "MPLBACKEND",
    "Agg",
    "--setenv",
    "MPLCONFIGDIR",
    "/tmp",
    "--chdir",
    "/out",
    "--",
    ...command,
  ];
}

export function tail(maxChars) {
  let text = "";
  return {
    push: (chunk) => {
      text += chunk;
      if (text.length > maxChars * 2) {
        text = text.slice(-maxChars);
      }
    },
    text: () => text.slice(-maxChars),
  };
}

// A script can chmod its own files to 000; the server owns them (the jail's uid maps to it), so it
// takes owner access back before reading or deleting. lstat first: chmod follows links.
async function restoreAccess(path) {
  try {
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      await chmod(path, stat.mode | 0o700);
      for (const entry of await readdir(path)) {
        await restoreAccess(join(path, entry));
      }
    } else if (stat.isFile()) {
      await chmod(path, stat.mode | 0o600);
    }
  } catch {
    // What cannot be restored is reported as unreadable by the walk, and rm says if it fails.
  }
}

// The jail is gone when this runs (its PID namespace dies with bwrap), so nothing can swap a file
// for a link between the lstat and the read; links are never followed, so /out cannot point the
// control server at its own environment or at another run. The walk is bounded so a script that
// writes a huge or deep tree cannot keep the server busy.
export async function collectOutputs(outDir) {
  const outputs = [];
  let totalBytes = 0;
  let leftOut = 0;
  let skipped = 0;
  let unreadable = 0;
  let visited = 0;
  let truncated = false;
  const full = () =>
    outputs.length >= maxOutputFiles || totalBytes >= maxOutputBytes;
  const walk = async (relative, depth) => {
    let entries;
    try {
      entries = (await readdir(join(outDir, relative))).sort();
    } catch {
      unreadable++;
      return;
    }
    for (const entry of entries) {
      if (++visited > walkMaxEntries) {
        truncated = true;
        return;
      }
      const name = relative ? `${relative}/${entry}` : entry;
      try {
        const stat = await lstat(join(outDir, name));
        if (stat.isDirectory()) {
          if (depth >= walkMaxDepth || full()) {
            truncated = true;
          } else {
            await walk(name, depth + 1);
          }
        } else if (!stat.isFile()) {
          skipped++;
        } else if (
          outputs.length >= maxOutputFiles ||
          totalBytes + stat.size > maxOutputBytes
        ) {
          leftOut++;
        } else {
          const content = await readFile(join(outDir, name));
          totalBytes += content.length;
          outputs.push({
            name,
            mime: mimeOf(name),
            contentBase64: content.toString("base64"),
          });
        }
      } catch {
        unreadable++;
      }
    }
  };
  await walk("", 0);
  const notes = [];
  if (leftOut) {
    notes.push(
      `${leftOut} file${leftOut === 1 ? " was" : "s were"} left out: a run keeps at most ${maxOutputFiles} files and 50 MB.`
    );
  }
  if (skipped) {
    notes.push(
      `${skipped} link${skipped === 1 ? " or special file was" : "s or special files were"} skipped: only regular files are kept.`
    );
  }
  if (unreadable) {
    notes.push(
      `${unreadable} entr${unreadable === 1 ? "y" : "ies"} could not be read and ${unreadable === 1 ? "was" : "were"} skipped.`
    );
  }
  if (truncated) {
    notes.push(
      `The output folder was only partly listed: a run looks at ${walkMaxEntries} entries at most, ${walkMaxDepth} folders deep, and stops descending once it is full.`
    );
  }
  return { outputs, notes };
}

export const runJail = (file, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: jailPath },
    });
    const stdout = tail(tailChars);
    const stderr = tail(tailChars);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", stdout.push);
    child.stderr.setEncoding("utf8").on("data", stderr.push);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : code,
        timedOut,
        stdout: stdout.text(),
        stderr: stderr.text(),
      });
    });
  });

function parseRun(body) {
  const { language, code, files = [], timeoutMs } = body ?? {};
  if (language !== "python" && language !== "node") {
    throw new BadRequest("language is python or node");
  }
  if (
    typeof code !== "string" ||
    code.length === 0 ||
    code.length > maxCodeChars
  ) {
    throw new BadRequest(`code is 1 to ${maxCodeChars} characters`);
  }
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < minTimeoutMs ||
    timeoutMs > maxTimeoutMs
  ) {
    throw new BadRequest(`timeoutMs is ${minTimeoutMs} to ${maxTimeoutMs}`);
  }
  if (!Array.isArray(files) || files.length > maxInputFiles) {
    throw new BadRequest(`files is a list of at most ${maxInputFiles}`);
  }
  const names = new Set();
  for (const file of files) {
    if (
      typeof file?.name !== "string" ||
      !fileNamePattern.test(file.name) ||
      file.name === "." ||
      file.name === ".." ||
      names.has(file.name) ||
      typeof file.contentBase64 !== "string"
    ) {
      throw new BadRequest(
        "each file has a unique plain name and base64 content"
      );
    }
    names.add(file.name);
  }
  return { language, code, files, timeoutMs };
}

// A page on any site can point its own name at 127.0.0.1 and post here as same-origin; the Host it
// sends still carries that name, so only the names AirLink uses to reach this server get in.
export const hostAllowed = (host, extraHostnames = []) => {
  if (typeof host !== "string") {
    return false;
  }
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return [...allowedHostnames, ...extraHostnames].includes(hostname);
};

export function createRunnerHandler({
  token,
  workDir,
  jail,
  extraHostnames = [],
  fontCacheDir = null,
}) {
  const expected = digest(token);

  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req, res) =>
    new Promise((resolve, reject) => {
      if (Number(req.headers["content-length"] ?? 0) > maxBodyBytes) {
        res.setHeader("connection", "close");
        reject(new BadRequest("body too large"));
        return;
      }
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBodyBytes) {
          res.setHeader("connection", "close");
          reject(new BadRequest("body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const run = async (request) => {
    const dir = join(workDir, `run-${randomUUID()}`);
    try {
      for (const part of ["tmp", "code", "files", "out"]) {
        await mkdir(join(dir, part), { recursive: true, mode: 0o700 });
      }
      // Matplotlib's font list, built once with the image, so a run does not spend seconds
      // rebuilding it in its own /tmp (MPLCONFIGDIR).
      if (fontCacheDir) {
        await cp(fontCacheDir, join(dir, "tmp"), { recursive: true });
      }
      await writeFile(
        join(
          dir,
          "code",
          request.language === "python" ? "main.py" : "main.mjs"
        ),
        request.code
      );
      for (const file of request.files) {
        await writeFile(
          join(dir, "files", file.name),
          Buffer.from(file.contentBase64, "base64")
        );
      }
      const result = await jail(
        "prlimit",
        jailArgv({ dir, language: request.language }),
        { timeoutMs: request.timeoutMs }
      );
      await restoreAccess(join(dir, "out"));
      return { ...result, ...(await collectOutputs(join(dir, "out"))) };
    } finally {
      await restoreAccess(dir);
      await rm(dir, { recursive: true, force: true }).catch((err) =>
        process.stderr.write(`control: could not remove ${dir}: ${err}\n`)
      );
    }
  };

  let activeRuns = 0;

  return async (req, res) => {
    if (!hostAllowed(req.headers.host, extraHostnames)) {
      send(res, 421, { error: "unknown host" });
      return;
    }
    const header = req.headers["x-runner-token"];
    if (
      typeof header !== "string" ||
      !timingSafeEqual(digest(header), expected)
    ) {
      send(res, 401, { error: "bad token" });
      return;
    }
    try {
      if (req.method === "GET" && req.url === "/health") {
        send(res, 200, { ok: true });
        return;
      }
      if (req.method !== "POST" || req.url !== "/run") {
        send(res, 404, { error: "not found" });
        return;
      }
      // Counted from the body read on, so the cap bounds buffered bodies as well as jails.
      if (activeRuns >= maxConcurrentRuns) {
        send(res, 429, {
          error: `at most ${maxConcurrentRuns} runs at a time; try again shortly`,
        });
        return;
      }
      activeRuns++;
      try {
        let body;
        try {
          body = JSON.parse(await readBody(req, res));
        } catch (err) {
          throw err instanceof BadRequest ? err : new BadRequest("bad JSON");
        }
        send(res, 200, await run(parseRun(body)));
      } finally {
        activeRuns--;
      }
    } catch (err) {
      if (err instanceof BadRequest) {
        send(res, 400, { error: err.message });
        return;
      }
      process.stderr.write(
        `control: run failed: ${err instanceof Error ? err.stack : String(err)}\n`
      );
      send(res, 500, { error: "the runner failed; see its logs" });
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const token = process.env.RUNNER_CONTROL_TOKEN;
  if (!token) {
    process.stderr.write("control: RUNNER_CONTROL_TOKEN is not set\n");
    process.exit(1);
  }
  const port = Number(process.env.RUNNER_CONTROL_PORT ?? 7000);
  const workDir = process.env.RUNNER_WORK_DIR ?? join(tmpdir(), "runner");
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  createServer(
    createRunnerHandler({
      token,
      workDir,
      jail: runJail,
      extraHostnames: (process.env.RUNNER_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
      fontCacheDir: process.env.RUNNER_FONT_CACHE ?? null,
    })
  ).listen(port, () => process.stdout.write(`control: listening on ${port}\n`));
}
