// What AirLink is made of, read from the package.json files themselves, so every script works from
// one list: the packages under packages/, and what platform each one targets.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const liveRoot = join(import.meta.dirname, "..");

export function workspacePackages() {
  return readdirSync(join(liveRoot, "packages")).flatMap((name) => {
    const dir = join(liveRoot, "packages", name);
    const path = join(dir, "package.json");
    return existsSync(path)
      ? [{ dir, manifest: JSON.parse(readFileSync(path, "utf8")) }]
      : [];
  });
}

export const platformOf = (manifest) => manifest.airlink?.platform ?? "neutral";

export const publishedPackages = () =>
  workspacePackages().filter(({ manifest }) => manifest.private !== true);

const entryName = (subpath) => (subpath === "." ? "index" : subpath.slice(2));
const isCss = (source) => source.endsWith(".css");

// tsdown's entries and the tarball's exports both come from here, so they cannot disagree.
export function exportEntries(exports) {
  return Object.fromEntries(
    Object.entries(exports ?? {})
      .filter(([, source]) => !isCss(source))
      .map(([subpath, source]) => [entryName(subpath), source])
  );
}

export function distExports(exports) {
  return Object.fromEntries(
    Object.entries(exports).map(([subpath, source]) => [
      subpath,
      isCss(source)
        ? `./dist/${entryName(subpath)}`
        : {
            types: `./dist/${entryName(subpath)}.d.mts`,
            import: `./dist/${entryName(subpath)}.mjs`,
          },
    ])
  );
}
