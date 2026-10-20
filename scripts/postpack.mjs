// Runs as `postpack`, and by hand after a crashed pack: restores package.json from prepack's backup
// and removes what prepack copied in. Safe to run any number of times.
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, sep } from "node:path";

import { liveRoot } from "./packages.mjs";

const dir = process.cwd();
if (!dir.startsWith(join(liveRoot, "packages") + sep)) {
  throw new Error(`postpack: run it from a folder under packages/, not ${dir}`);
}
const backupPath = join(dir, "package.json.prepack");
if (existsSync(backupPath)) {
  renameSync(backupPath, join(dir, "package.json"));
}
rmSync(join(dir, "LICENSE"), { force: true });
if (
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name ===
  "create-airlink"
) {
  rmSync(join(dir, "templates"), { recursive: true, force: true });
}
