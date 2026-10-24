import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

import { liveRoot, publishedPackages } from "./packages.mjs";
import { sectionOf } from "./release-notes.mjs";

const changesetBin = createRequire(import.meta.url).resolve(
  "@changesets/cli/bin.js"
);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

// What `changeset version` reads: the root manifest, every workspace's package.json and the config,
// plus a package-lock.json, without which Changesets does not take the directory for an npm
// workspace root. Inside liveRoot so the changelog module resolves; the GitHub changelog is swapped
// for the default one because it needs a token and the public repository's commits.
function scratchCopy() {
  const dir = mkdtempSync(join(liveRoot, ".changeset-scratch-"));
  cpSync(join(liveRoot, "package.json"), join(dir, "package.json"));
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  for (const group of ["packages", "apps", "templates"]) {
    for (const name of readdirSync(join(liveRoot, group))) {
      const manifest = join(liveRoot, group, name, "package.json");
      if (existsSync(manifest)) {
        mkdirSync(join(dir, group, name), { recursive: true });
        cpSync(manifest, join(dir, group, name, "package.json"));
      }
    }
  }
  mkdirSync(join(dir, ".changeset"));
  writeFileSync(
    join(dir, ".changeset", "config.json"),
    JSON.stringify({
      ...read(join(liveRoot, ".changeset", "config.json")),
      changelog: "@changesets/cli/changelog",
    })
  );
  return dir;
}

test("a change to one package moves every published package together, and no private one", () => {
  const [major, minor] = read(
    join(liveRoot, "packages", "server", "package.json")
  ).version.split(".");
  const next = `${major}.${Number(minor) + 1}.0`;
  const dir = scratchCopy();
  try {
    writeFileSync(
      join(dir, ".changeset", "server-change.md"),
      '---\n"@memo-air/server": minor\n---\n\nA change.\n'
    );
    execFileSync(process.execPath, [changesetBin, "version"], {
      cwd: dir,
      stdio: "pipe",
    });

    const published = publishedPackages().map(({ dir: packageDir }) =>
      packageDir.slice(liveRoot.length + 1)
    );
    assert.equal(published.length, 22);
    for (const path of published) {
      const manifest = read(join(dir, path, "package.json"));
      assert.equal(manifest.version, next, manifest.name);
      for (const [name, range] of Object.entries({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      })) {
        if (name.startsWith("@memo-air/")) {
          assert.equal(range, `^${next}`, `${manifest.name} → ${name}`);
        }
      }
    }
    for (const path of [
      "apps/airlink",
      "apps/live-server",
      "apps/bench",
      "templates/room-react",
      "templates/agent-node",
    ]) {
      assert.deepEqual(
        read(join(dir, path, "package.json")),
        read(join(liveRoot, path, "package.json")),
        path
      );
    }
    assert.match(
      sectionOf(
        readFileSync(join(dir, "packages/server/CHANGELOG.md"), "utf8"),
        next
      ),
      /A change\./
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads one version's section out of a changelog", () => {
  const changelog =
    "# Changelog\n\n## [Unreleased]\n\n## [0.1.0]\n\nFirst.\n\n## 0.0.9\n\nOld.\n";
  assert.equal(sectionOf(changelog, "0.1.0"), "First.");
  assert.equal(sectionOf(changelog, "0.0.9"), "Old.");
  assert.equal(sectionOf(changelog, "9.9.9"), "");
});
