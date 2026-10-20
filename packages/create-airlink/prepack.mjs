// Runs as `prepack`: copies the repo's templates into this package, renaming the dotfiles npm would
// drop or rename, and pinning each template's images to this release. Only files git tracks are
// copied, so whatever a local run left in a template (data/settings.json with pasted keys, .env.local,
// node_modules) never ships. scripts/postpack.mjs removes the copy and the LICENSE.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { pinImages } from "./index.mjs";

const here = import.meta.dirname;
const liveRoot = join(here, "../..");
const { version } = JSON.parse(
  readFileSync(join(here, "package.json"), "utf8")
);
const out = join(here, "templates");

// Throws when git is missing or this is not a checkout: packing everything instead could ship secrets.
const tracked = execFileSync("git", ["ls-files", "-z", "--", "templates"], {
  cwd: liveRoot,
  encoding: "utf8",
})
  .split("\0")
  .filter((path) => path && existsSync(join(liveRoot, path)));
if (tracked.length === 0) {
  throw new Error(
    "prepack: git tracks no files under templates/; add them before packing"
  );
}
rmSync(out, { recursive: true, force: true });
for (const path of tracked) {
  const target = join(here, path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(liveRoot, path), target);
}
for (const template of readdirSync(out)) {
  for (const [from, to] of [
    [".gitignore", "_gitignore"],
    [".env.example", "_env.example"],
  ]) {
    const path = join(out, template, from);
    if (existsSync(path)) {
      renameSync(path, join(out, template, to));
    }
  }
  const compose = join(out, template, "docker-compose.yml");
  if (existsSync(compose)) {
    writeFileSync(compose, pinImages(readFileSync(compose, "utf8"), version));
  }
}
copyFileSync(join(liveRoot, "LICENSE"), join(here, "LICENSE"));
