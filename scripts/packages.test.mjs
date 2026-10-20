import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { distExports, exportEntries, publishedPackages } from "./packages.mjs";

const reactLike = {
  ".": "./src/index.ts",
  "./ui": "./src/ui.tsx",
  "./doc": "./src/entry/doc.ts",
  "./theme.css": "./src/theme.css",
};

test("one tsdown entry per code export, named by its subpath", () => {
  assert.deepEqual(exportEntries(reactLike), {
    index: "./src/index.ts",
    ui: "./src/ui.tsx",
    doc: "./src/entry/doc.ts",
  });
});

test("each export points at what its entry emits, CSS at its copy", () => {
  assert.deepEqual(distExports(reactLike), {
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
    "./ui": { types: "./dist/ui.d.mts", import: "./dist/ui.mjs" },
    "./doc": { types: "./dist/doc.d.mts", import: "./dist/doc.mjs" },
    "./theme.css": "./dist/theme.css",
  });
});

test("every published export names a source file that exists", () => {
  for (const { dir, manifest } of publishedPackages()) {
    for (const source of Object.values(manifest.exports ?? {})) {
      assert.ok(existsSync(join(dir, source)), `${manifest.name}: ${source}`);
    }
  }
});
