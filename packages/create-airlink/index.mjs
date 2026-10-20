#!/usr/bin/env node
// npm create airlink@latest [dir] [template] [-- --template room-react|agent-node|full --no-install]
// npm reads flags itself unless they come after `--`, so the template is also taken positionally.
// Copies a template, pins its @memo-air packages to this release, writes .env with a fresh signing
// secret, installs with the package manager that ran it, and prints what to do next. No dependencies.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { cp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const templates = ["room-react", "agent-node", "full"];

const docsBase = "https://memoair-labs.github.io/Airlink/docs/templates/";
const nextSteps = {
  "room-react": {
    commands: ["docker compose up -d", "{pm} run dev"],
    url: "http://localhost:5173",
  },
  "agent-node": {
    commands: [
      "docker compose up -d",
      "{pm} start",
      '{pm} run say -- "@Scout what can you do?"',
    ],
    url: null,
  },
  full: { commands: ["docker compose up -d"], url: "http://localhost:3030" },
};
const usage = `Usage: npm create airlink@latest [dir] [template]
       npm create airlink@latest [dir] -- [--template ${templates.join("|")}] [--no-install]\n`;

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      template: { type: "string", short: "t" },
      "no-install": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return {
    dir: positionals[0] ?? null,
    template: values.template ?? positionals[1] ?? null,
    install: !values["no-install"],
    help: values.help,
  };
}

export function packageManagerOf(userAgent) {
  const name = (userAgent ?? "").split("/")[0];
  return ["npm", "pnpm", "yarn", "bun"].includes(name) ? name : "npm";
}

export const packageNameOf = (dir) =>
  basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "") || "airlink-app";

// Versions are locked together, so every @memo-air package takes this release's own version.
export function pinAirlinkVersions(manifest, version, name) {
  const pin = (deps) =>
    deps &&
    Object.fromEntries(
      Object.entries(deps).map(([dep, range]) => [
        dep,
        dep.startsWith("@memo-air/") ? `^${version}` : range,
      ])
    );
  return {
    ...manifest,
    name,
    dependencies: pin(manifest.dependencies),
    devDependencies: pin(manifest.devDependencies),
  };
}

// A template never runs against a newer server than its packages expect.
export const pinImages = (compose, version) =>
  compose.replace(
    /(ghcr\.io\/memoair-labs\/airlink[a-z-]*):latest\b/g,
    `$1:${version}`
  );

const withSecret = (envExample) =>
  envExample.replace(
    /^LIVE_JWT_SECRET=$/m,
    `LIVE_JWT_SECRET=${randomBytes(32).toString("hex")}`
  );

// Quoted for a POSIX shell only when it has to be, so the printed `cd` line pastes as is.
export const shellPath = (path) =>
  /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;

export async function scaffold({ dir, template, version, templatesDir }) {
  if (!templates.includes(template)) {
    throw new Error(
      `Unknown template "${template}". Pick one of: ${templates.join(", ")}.`
    );
  }
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    throw new Error(`${dir} is a file. Pick a new or empty directory.`);
  }
  if (existsSync(dir) && (await readdir(dir)).length > 0) {
    throw new Error(`${dir} is not empty. Pick a new or empty directory.`);
  }
  await cp(join(templatesDir, template), dir, { recursive: true });
  for (const [from, to] of [
    ["_gitignore", ".gitignore"],
    ["_env.example", ".env.example"],
  ]) {
    if (existsSync(join(dir, from))) {
      await rename(join(dir, from), join(dir, to));
    }
  }
  if (existsSync(join(dir, ".env.example"))) {
    await writeFile(
      join(dir, ".env"),
      withSecret(await readFile(join(dir, ".env.example"), "utf8")),
      {
        mode: 0o600,
      }
    );
  }
  const manifestPath = join(dir, "package.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(
      manifestPath,
      `${JSON.stringify(pinAirlinkVersions(manifest, version, packageNameOf(dir)), null, 2)}\n`
    );
  }
}

async function ask(question, fallback) {
  if (!process.stdin.isTTY) {
    return fallback;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = (await prompt.question(question)).trim();
  prompt.close();
  return answer || fallback;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  const dir =
    options.dir ?? (await ask("Directory [my-airlink]: ", "my-airlink"));
  if (!options.template && !process.stdin.isTTY) {
    throw new Error(
      `No template given. Pass one: npm create airlink@latest ${dir} ${templates[0]}\n${usage}`
    );
  }
  const template =
    options.template ??
    (await ask(
      `Template (${templates.join(" | ")}) [room-react]: `,
      "room-react"
    ));
  const { version } = JSON.parse(
    await readFile(join(import.meta.dirname, "package.json"), "utf8")
  );
  await scaffold({
    dir,
    template,
    version,
    templatesDir: join(import.meta.dirname, "templates"),
  });

  const pm = packageManagerOf(process.env.npm_config_user_agent);
  const hasManifest = existsSync(join(dir, "package.json"));
  if (options.install && hasManifest) {
    // On Windows the package manager is a .cmd shim, which Node only starts through a shell.
    const result = spawnSync(pm, ["install"], {
      cwd: dir,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) {
      throw new Error(`${pm} install failed; run it yourself in ${dir}.`);
    }
  }
  const { commands, url } = nextSteps[template];
  const lines = [
    `cd ${shellPath(dir)}`,
    ...(hasManifest && !options.install ? [`${pm} install`] : []),
    ...commands.map((command) => command.replaceAll("{pm}", pm)),
  ];
  process.stdout.write(
    `\nCreated ${dir} from the ${template} template (AirLink ${version}).\n\n${lines
      .map((line) => `  ${line}`)
      .join(
        "\n"
      )}\n\n${url ? `Then open ${url}. ` : ""}Docs: ${docsBase}${template}/\n`
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`create-airlink: ${error.message}\n`);
    process.exit(1);
  });
}
