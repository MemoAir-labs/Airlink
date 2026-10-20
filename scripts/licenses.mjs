// Walks the production dependencies of every package under live/ (resolved the way Node does,
// from each package's folder upward) and fails on a licence outside the allowed set.
// Usage: node scripts/licenses.mjs [--list]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const liveRoot = join(import.meta.dirname, "..");
const allowed = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Unlicense",
  "Python-2.0",
  "MPL-2.0",
  "WTFPL",
  "Zlib",
]);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// Reviewed by hand, each pinned to the version that was reviewed.
const exceptions = new Map([
  [
    "buffers@0.1.1",
    "no licence declared; reached through exceljs → unzipper → binary for xlsx export",
  ],
  [
    "@livekit/local-inference@0.2.7",
    "Apache-2.0 code plus the LiveKit Model License for its on-device VAD and end-of-turn models; a hard dependency of @livekit/agents, used only inside LiveKit Agents as that licence allows, never to train other models (accepted by the owner 2026-10-20)",
  ],
]);

const aliases = new Map([["MIT/X11", "MIT"]]);

const declaredLicence = (manifest) => {
  const raw = manifest.license ?? manifest.licenses;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw.map((entry) => entry.type ?? entry).join(" OR ");
  }
  return raw?.type ?? "UNKNOWN";
};

// Some packages leave the field empty or say UNLICENSED while shipping an MIT licence file.
const licenceOf = (manifest, dir) => {
  const declared = declaredLicence(manifest);
  if (declared !== "UNKNOWN" && declared !== "UNLICENSED") {
    return aliases.get(declared) ?? declared;
  }
  const file = readdirSync(dir).find((name) => /^licen[cs]e/i.test(name));
  const text = file ? readFileSync(join(dir, file), "utf8").slice(0, 200) : "";
  return /\bMIT License\b/i.test(text) ? "MIT" : declared;
};

// "(MIT OR Apache-2.0)" passes when any alternative is allowed; "A AND B" needs both.
const isAllowed = (expression) =>
  expression
    .replace(/[()]/g, "")
    .split(/\s+OR\s+/)
    .some((alternative) =>
      alternative.split(/\s+AND\s+/).every((id) => allowed.has(id.trim()))
    );

const resolve = (fromDir, name) => {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dirname(dir) === dir) {
      return null;
    }
  }
};

const workspaces = ["packages", "apps"].flatMap((group) =>
  readdirSync(join(liveRoot, group))
    .map((name) => join(liveRoot, group, name, "package.json"))
    .filter(existsSync)
);
const workspaceNames = new Set(workspaces.map((path) => readJson(path).name));

const seen = new Map();
const missing = new Set();
const visit = (manifestPath) => {
  const manifest = readJson(manifestPath);
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (workspaceNames.has(name)) {
      continue;
    }
    const found = resolve(dirname(manifestPath), name);
    if (!found) {
      missing.add(name);
      continue;
    }
    const dep = readJson(found);
    const key = `${dep.name}@${dep.version}`;
    if (!seen.has(key)) {
      seen.set(key, licenceOf(dep, dirname(found)));
      visit(found);
    }
  }
};
for (const workspace of workspaces) {
  visit(workspace);
}

const refused = [...seen].filter(
  ([key, licence]) => !isAllowed(licence) && !exceptions.has(key)
);
const counts = new Map();
for (const [, licence] of seen) {
  counts.set(licence, (counts.get(licence) ?? 0) + 1);
}
process.stdout.write(
  `${seen.size} production dependencies: ${[...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([licence, count]) => `${licence} ${count}`)
    .join(", ")}\n`
);
if (process.argv.includes("--list")) {
  for (const [key, licence] of [...seen].sort()) {
    process.stdout.write(`${licence}\t${key}\n`);
  }
}
for (const [key, reason] of exceptions) {
  if (seen.has(key)) {
    process.stdout.write(`exception: ${key}: ${reason}\n`);
  }
}
if (missing.size) {
  process.stdout.write(`not installed: ${[...missing].join(", ")}\n`);
}
if (refused.length) {
  process.stdout.write(
    `refused:\n${refused.map(([key, licence]) => `  ${key}: ${licence}`).join("\n")}\n`
  );
  process.exit(1);
}
