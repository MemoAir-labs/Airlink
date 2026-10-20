// Seeds the exported repository's package-lock.json from the monorepo's, so a clean install gets
// the versions the tests already pass on instead of whatever is newest. Keeps the hoisted
// packages and live/'s own workspaces (moved from live/<dir> to <dir>); `npm install` then prunes
// what only the monorepo's other workspaces needed.
// Usage: node scripts/seed-lockfile.mjs <monorepo package-lock.json> <exported repository>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [source, dest] = process.argv.slice(2);
if (!source || !dest) {
  process.stderr.write(
    "usage: seed-lockfile.mjs <monorepo package-lock.json> <exported repository>\n"
  );
  process.exit(1);
}

const lock = JSON.parse(readFileSync(source, "utf8"));
const root = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
const workspacePrefix = "live/";

const packages = {
  "": {
    name: root.name,
    license: root.license,
    workspaces: root.workspaces,
    devDependencies: root.devDependencies,
    engines: root.engines,
  },
};
for (const [key, entry] of Object.entries(lock.packages)) {
  if (key.startsWith("node_modules/")) {
    // A link into the monorepo's other workspaces has no target in the export.
    if (entry.link && !entry.resolved?.startsWith(workspacePrefix)) {
      continue;
    }
    packages[key] = entry.link
      ? { ...entry, resolved: entry.resolved.slice(workspacePrefix.length) }
      : entry;
  } else if (key.startsWith(workspacePrefix)) {
    packages[key.slice(workspacePrefix.length)] = entry;
  }
}

writeFileSync(
  join(dest, "package-lock.json"),
  `${JSON.stringify({ ...lock, name: root.name, packages }, null, 2)}\n`
);
