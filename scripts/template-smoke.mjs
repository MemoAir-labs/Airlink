// Scaffolds every template with the packed create-airlink, with the argv `npm create airlink` delivers, installs
// the packed @memo-air tarballs into it, and runs what it scaffolded: type-check, tests and build, or
// `docker compose config` for a template with no code. Fails if a built bundle holds the secret.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { liveRoot, publishedPackages } from "./packages.mjs";

const packs = join(liveRoot, ".packs");
const tarballs = readdirSync(packs).filter((name) => name.endsWith(".tgz"));
const creator = tarballs.find((name) => name.startsWith("create-airlink-"));
if (!creator) {
  throw new Error(
    "template-smoke: no create-airlink tarball; run npm run pack:all first"
  );
}
const manifests = new Map(
  publishedPackages().map(({ manifest }) => [manifest.name, manifest])
);
const tarballOf = (name) =>
  join(
    packs,
    `${name.slice(1).replace("/", "-")}-${manifests.get(name).version}.tgz`
  );

// The @memo-air packages a template names and every @memo-air package they depend on, as tarballs,
// so they resolve here instead of on the registry. Only those: an agent never installs the React views.
function librariesOf({ dependencies = {}, devDependencies = {} }) {
  const names = new Set();
  const visit = (name) => {
    if (!name.startsWith("@memo-air/") || names.has(name)) {
      return;
    }
    names.add(name);
    Object.keys(manifests.get(name).dependencies ?? {}).forEach(visit);
  };
  Object.keys({ ...dependencies, ...devDependencies }).forEach(visit);
  return [...names].map(tarballOf);
}
const root = mkdtempSync(join(tmpdir(), "airlink-templates-"));
process.on("exit", (code) => {
  if (code === 0) {
    rmSync(root, { recursive: true, force: true });
  } else {
    process.stderr.write(`template-smoke: kept ${root} for inspection\n`);
  }
});

// A file only that template has, so a CLI that fell back to another template fails here.
const markers = {
  "room-react": "vite.config.ts",
  "agent-node": "agent.ts",
  full: "data/agents.json",
};

for (const [template, marker] of Object.entries(markers)) {
  const dir = join(root, template);
  const run = (command, args) =>
    execFileSync(command, args, { cwd: dir, stdio: "inherit" });
  // npm parses this argv as it does `npm create airlink@latest <dir> <template> -- --no-install`.
  execFileSync(
    "npm",
    [
      "exec",
      "--yes",
      `--package=${join(packs, creator)}`,
      "create-airlink",
      dir,
      template,
      "--",
      "--no-install",
    ],
    { cwd: root, stdio: "inherit" }
  );
  if (!existsSync(join(dir, marker))) {
    throw new Error(`template-smoke: asked for ${template}, got no ${marker}`);
  }
  if (!existsSync(join(dir, "package.json"))) {
    run("docker", ["compose", "config", "--quiet"]);
    continue;
  }
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  run("npm", ["install", "--no-audit", "--no-fund", ...librariesOf(manifest)]);
  const { scripts } = manifest;
  for (const script of ["typecheck", "test", "build"]) {
    if (scripts[script]) {
      run("npm", ["run", script]);
    }
  }
  const secret = readFileSync(join(dir, ".env"), "utf8").match(
    /^LIVE_JWT_SECRET=(.+)$/m
  )?.[1];
  const dist = join(dir, "dist");
  if (secret && existsSync(dist)) {
    for (const file of readdirSync(dist, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (
        file.isFile() &&
        readFileSync(join(file.parentPath, file.name), "utf8").includes(secret)
      ) {
        throw new Error(
          `template-smoke: ${template}'s bundle holds LIVE_JWT_SECRET (${file.name})`
        );
      }
    }
  }
}
process.stdout.write("template-smoke: 3 templates scaffolded and checked\n");
