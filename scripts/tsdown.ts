import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsdown";

import { exportEntries } from "./packages.mjs";

// Every published package builds the same way: ESM plus bundled .d.mts, one entry per export (read
// from the package's own exports, so there is one list). Every bare import stays external, in code
// and in the .d.mts alike, so no package carries a private copy of a dependency (or of its types,
// as @tiptap/pm/model's re-export of prosemirror-model would otherwise put into richtext's).
export function airlinkPackage(dir: string) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return defineConfig({
    entry: Object.fromEntries(
      Object.entries(exportEntries(manifest.exports)).map(([name, source]) => [
        name,
        join(dir, source),
      ])
    ),
    format: "esm",
    fixedExtension: true,
    platform: manifest.airlink?.platform ?? "neutral",
    tsconfig: join(dir, "tsconfig.json"),
    outDir: join(dir, "dist"),
    clean: true,
    deps: { neverBundle: true },
    dts: {
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
      },
    },
  });
}
