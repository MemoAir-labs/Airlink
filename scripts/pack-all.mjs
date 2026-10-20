// Packs every published package into .packs/ the way `npm publish` would (prepack, pack, postpack),
// for the package checks, the consumer smoke and the template smoke.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { liveRoot, publishedPackages } from "./packages.mjs";

const out = join(liveRoot, ".packs");
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const { dir } of publishedPackages()) {
  try {
    execFileSync("npm", ["pack", "--pack-destination", out], {
      cwd: dir,
      stdio: "inherit",
    });
  } catch (error) {
    // A failed pack skips npm's postpack, leaving prepack's rewritten package.json in the tree.
    execFileSync("node", [join(liveRoot, "scripts", "postpack.mjs")], {
      cwd: dir,
      stdio: "inherit",
    });
    throw error;
  }
}
