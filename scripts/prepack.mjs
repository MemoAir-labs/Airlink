// Runs as each published package's `prepack`: builds it with tsdown, then rewrites package.json so
// the tarball exports dist instead of src, ships its NOTICE files and carries the root LICENSE.
// postpack.mjs puts everything back; in the repo, exports keep pointing at src.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";

import { distExports, liveRoot } from "./packages.mjs";

const dir = process.cwd();
if (!dir.startsWith(join(liveRoot, "packages") + sep)) {
  throw new Error(`prepack: run it from a folder under packages/, not ${dir}`);
}
const manifestPath = join(dir, "package.json");
const backupPath = join(dir, "package.json.prepack");
// A pack that crashed before postpack left the rewritten file behind; the backup is the original.
const original = readFileSync(
  existsSync(backupPath) ? backupPath : manifestPath,
  "utf8"
);
writeFileSync(backupPath, original);
const manifest = JSON.parse(original);

execFileSync("npx", ["--no-install", "tsdown"], { cwd: dir, stdio: "inherit" });
mkdirSync(join(dir, "dist"), { recursive: true });
for (const [subpath, source] of Object.entries(manifest.exports)) {
  if (source.endsWith(".css")) {
    copyFileSync(join(dir, source), join(dir, "dist", subpath.slice(2)));
  }
}
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      ...manifest,
      exports: distExports(manifest.exports),
      files: ["dist", "NOTICE*"],
    },
    null,
    2
  )}\n`
);
copyFileSync(join(liveRoot, "LICENSE"), join(dir, "LICENSE"));
