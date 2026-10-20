// The self-hosted desktop's control server: AirLink's mouse, keyboard and screenshots become
// xdotool and scrot calls on neko's X display. Whoever holds the token controls the whole desktop,
// its terminal included, so the container is the security boundary. The checks here keep each op
// to what it says: argument arrays (never a shell), no xdotool command chaining, an app allowlist.
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const maxBodyBytes = 64 * 1024;
const maxTextLength = 4096;
const maxTargetLength = 2048;
const maxScrollAmount = 50;
const commandTimeoutMs = 10_000;
const keyPattern = /^[A-Za-z0-9_+]{1,64}$/;
// xdotool's `key` stops at the first argument naming a command and runs the rest as that command,
// so `key a exec sh` would start a program. The union of `xdotool help` across 3.x versions.
const xdotoolCommands = new Set(
  `getactivewindow getwindowfocus getwindowname getwindowclassname getwindowpid getwindowgeometry
  getdisplaygeometry search selectwindow help version behave behave_screen_edge click
  getmouselocation key keydown keyup mousedown mousemove mousemove_relative mouseup set_window type
  windowactivate windowfocus windowkill windowclose windowquit windowmap windowminimize windowmove
  windowraise windowreparent windowsize windowstate windowunmap set_num_desktops get_num_desktops
  set_desktop get_desktop set_desktop_for_window get_desktop_for_window get_desktop_viewport
  set_desktop_viewport exec sleep`.split(/\s+/)
);

// The extras (Firefox, LibreOffice) are only in the image built with DESKTOP_EXTRAS; launching
// one without them fails with ENOENT rather than running something else.
const applications = {
  terminal: ["xfce4-terminal"],
  "xfce4-terminal": ["xfce4-terminal"],
  files: ["thunar"],
  "file-manager": ["thunar"],
  thunar: ["thunar"],
  editor: ["mousepad"],
  mousepad: ["mousepad"],
  gedit: ["mousepad"],
  browser: ["firefox-esr"],
  firefox: ["firefox-esr"],
  "google-chrome": ["firefox-esr"],
  libreoffice: ["libreoffice"],
  writer: ["libreoffice", "--writer"],
  calc: ["libreoffice", "--calc"],
};

class BadRequest extends Error {}

const digest = (value) => createHash("sha256").update(value).digest();

function int(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BadRequest(`expected an integer from ${min} to ${max}`);
  }
  return String(value);
}

function str(value, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new BadRequest(`expected a string of 1 to ${max} characters`);
  }
  return value;
}

const coord = (value) => int(value, 0, 16_384);

// Only web and file URLs or absolute paths: no option-looking "-x", no .desktop launchers (they
// name a command to run) and no LibreOffice macro: or vnd.sun.star.script: URLs.
const target = (value) => {
  const checked = str(value, maxTargetLength);
  let decoded;
  try {
    decoded = decodeURIComponent(checked);
  } catch {
    throw new BadRequest("a target must be a valid URL or path");
  }
  if (!/^(https?:|file:|\/)/i.test(checked) || /\.desktop/i.test(decoded)) {
    throw new BadRequest(
      "a target is an http(s) or file URL or an absolute path, not a .desktop file"
    );
  }
  return checked;
};

export function createControlHandler({ token, exec, detach, shot }) {
  const expected = digest(token);
  const xdotool = (args) => exec("xdotool", args);
  const ops = {
    move: async ([x, y]) => {
      await xdotool(["mousemove", coord(x), coord(y)]);
    },
    press: async ([button]) => {
      await xdotool(["mousedown", int(button, 1, 3)]);
    },
    release: async ([button]) => {
      await xdotool(["mouseup", int(button, 1, 3)]);
    },
    click: async ([x, y, button, count]) => {
      await xdotool([
        "mousemove",
        coord(x),
        coord(y),
        "click",
        "--repeat",
        int(count, 1, 3),
        int(button, 1, 3),
      ]);
    },
    drag: async ([x1, y1, x2, y2]) => {
      await xdotool([
        "mousemove",
        coord(x1),
        coord(y1),
        "mousedown",
        "1",
        "sleep",
        "0.1",
        "mousemove",
        coord(x2),
        coord(y2),
        "sleep",
        "0.1",
        "mouseup",
        "1",
      ]);
    },
    scroll: async ([direction, amount]) => {
      if (direction !== "up" && direction !== "down") {
        throw new BadRequest("direction is up or down");
      }
      await xdotool([
        "click",
        "--repeat",
        int(amount, 1, maxScrollAmount),
        direction === "up" ? "4" : "5",
      ]);
    },
    key: async (keys) => {
      if (keys.length === 0 || keys.length > 16) {
        throw new BadRequest("expected 1 to 16 keys");
      }
      for (const key of keys) {
        if (
          typeof key !== "string" ||
          !keyPattern.test(key) ||
          xdotoolCommands.has(key)
        ) {
          throw new BadRequest("a key is an X keysym like Return or ctrl+s");
        }
      }
      await xdotool(["key", ...keys]);
    },
    type: async ([text]) => {
      await xdotool(["type", "--delay", "12", "--", str(text, maxTextLength)]);
    },
    open: async ([value]) => {
      await detach("xdg-open", [target(value)]);
    },
    launch: async ([name, uri]) => {
      const argv = Object.hasOwn(applications, name)
        ? applications[name]
        : null;
      if (!argv) {
        throw new BadRequest(
          `launch takes one of: ${Object.keys(applications).join(", ")}`
        );
      }
      const [file, ...rest] = argv;
      await detach(file, uri === undefined ? rest : [...rest, target(uri)]);
    },
    size: async () => {
      const [width, height] = String(await xdotool(["getdisplaygeometry"]))
        .trim()
        .split(/\s+/)
        .map(Number);
      return { width, height };
    },
  };

  const send = (res, status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };

  const readBody = (req, res) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBodyBytes) {
          // Answer 400 and close after it instead of destroying the socket mid-request, which
          // would drop the answer too.
          res.setHeader("connection", "close");
          reject(new BadRequest("body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  return async (req, res) => {
    const header = req.headers["x-desktop-token"];
    if (
      typeof header !== "string" ||
      !timingSafeEqual(digest(header), expected)
    ) {
      send(res, 401, { error: "bad token" });
      return;
    }
    try {
      if (req.method === "GET" && req.url === "/shot.png") {
        send(res, 200, await shot(), "image/png");
        return;
      }
      if (req.method !== "POST" || req.url !== "/op") {
        send(res, 404, { error: "not found" });
        return;
      }
      let body;
      try {
        body = JSON.parse(await readBody(req, res));
      } catch (err) {
        throw err instanceof BadRequest ? err : new BadRequest("bad JSON");
      }
      const name = body?.name;
      const args = body?.args ?? [];
      if (typeof name !== "string" || !Object.hasOwn(ops, name)) {
        throw new BadRequest(`unknown op: ${String(name)}`);
      }
      if (!Array.isArray(args)) {
        throw new BadRequest("args is an array");
      }
      send(res, 200, { ok: true, result: (await ops[name](args)) ?? null });
    } catch (err) {
      send(res, err instanceof BadRequest ? 400 : 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

const exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        timeout: commandTimeoutMs,
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });

// scrot cannot write to Node's stdout pipe (a socket, so /dev/stdout is ENXIO); a file per shot
// keeps concurrent requests apart.
const shot = async () => {
  const path = join(tmpdir(), `shot-${randomUUID()}.png`);
  try {
    await exec("scrot", ["-o", path]);
    return await readFile(path);
  } finally {
    await rm(path, { force: true });
  }
};

// Apps outlive the request; resolving on "spawn" still reports a missing binary as an error.
const detach = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const token = process.env.DESKTOP_CONTROL_TOKEN;
  if (!token) {
    process.stderr.write("control: DESKTOP_CONTROL_TOKEN is not set\n");
    process.exit(1);
  }
  const port = Number(process.env.DESKTOP_CONTROL_PORT ?? 7000);
  createServer(createControlHandler({ token, exec, detach, shot })).listen(
    port,
    () => process.stdout.write(`control: listening on ${port}\n`)
  );
}
