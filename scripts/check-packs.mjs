// Checks every tarball in .packs/: it holds only what a consumer needs, carries LICENSE (and the
// LiveKit notice for voice), contains every file its exports point at, has no env file or private
// key, and passes publint and attw. Prints each tarball's size for the J.6 log.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { liveRoot } from "./packages.mjs";

const packs = join(liveRoot, ".packs");
const allowed =
  /^package\/(dist\/.+|README\.md|LICENSE|NOTICE[^/]*|package\.json|CHANGELOG\.md|index\.mjs|templates\/.+)$/;
const envFile = /(^|\/)\.env($|\.)/;
const privateKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const problems = [];

const targetsOf = (exports) =>
  Object.values(exports ?? {}).flatMap((target) =>
    typeof target === "string" ? [target] : Object.values(target)
  );
const run = (command, args, label) => {
  try {
    execFileSync(command, args, {
      cwd: liveRoot,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (error) {
    problems.push(`${label}\n${error.stdout ?? ""}${error.stderr ?? ""}`);
  }
};

for (const file of readdirSync(packs)
  .filter((name) => name.endsWith(".tgz"))
  .sort()) {
  const tarball = join(packs, file);
  const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .trim()
    .split("\n");
  const dir = mkdtempSync(join(tmpdir(), "airlink-pack-"));
  execFileSync("tar", ["-xzf", tarball, "-C", dir]);
  const manifest = JSON.parse(
    readFileSync(join(dir, "package", "package.json"), "utf8")
  );

  for (const entry of files) {
    if (!allowed.test(entry)) {
      problems.push(`${file}: ships ${entry}`);
    }
    if (envFile.test(entry)) {
      problems.push(`${file}: ships an env file, ${entry}`);
    }
    if (privateKey.test(readFileSync(join(dir, entry), "utf8"))) {
      problems.push(`${file}: ${entry} holds a private key`);
    }
  }
  if (!files.includes("package/LICENSE")) {
    problems.push(`${file}: no LICENSE`);
  }
  if (
    manifest.name === "@memo-air/voice" &&
    !files.some((entry) => entry.startsWith("package/NOTICE"))
  ) {
    problems.push(`${file}: no LiveKit model licence notice`);
  }
  for (const target of targetsOf(manifest.exports)) {
    if (!files.includes(`package/${target.slice(2)}`)) {
      problems.push(`${file}: exports ${target}, which it does not contain`);
    }
  }
  run(
    "npx",
    [
      "--no-install",
      "publint",
      join(dir, "package"),
      "--pack",
      "false",
      "--strict",
    ],
    `${file}: publint`
  );
  if (manifest.exports) {
    // A stylesheet export has no types to resolve, so attw checks only the code entries.
    const stylesheets = Object.keys(manifest.exports).filter((subpath) =>
      subpath.endsWith(".css")
    );
    run(
      "npx",
      [
        "--no-install",
        "attw",
        tarball,
        "--profile",
        "esm-only",
        ...(stylesheets.length > 0
          ? ["--exclude-entrypoints", ...stylesheets]
          : []),
      ],
      `${file}: attw`
    );
  }
  process.stdout.write(
    `${file}\t${(statSync(tarball).size / 1024).toFixed(1)} kB\t${files.length} files\n`
  );
}
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
