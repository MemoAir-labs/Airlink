import { join } from "node:path";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { createStarlightTypeDocPlugin } from "starlight-typedoc";

import { exportEntries, publishedPackages } from "../scripts/packages.mjs";

// One TypeDoc instance per published package: its export sources as entry points, its own
// tsconfig, output under /docs/api/<package>/. TypeDoc reads source, so nothing is built first.
// A configured readme (a one-line stub) keeps the per-module pages that the package page links to.
const typeDocs = publishedPackages()
  .map(({ dir, manifest }) => ({
    dir,
    manifest,
    entryPoints: Object.values(exportEntries(manifest.exports)).map((source) =>
      join(dir, source)
    ),
  }))
  .filter(({ entryPoints }) => entryPoints.length > 0)
  .map(({ dir, manifest, entryPoints }) => {
    const [plugin, sidebar] = createStarlightTypeDocPlugin();
    return {
      sidebar,
      plugin: plugin({
        entryPoints,
        tsconfig: join(dir, "tsconfig.json"),
        output: `api/${dir.split(/[/\\]/).pop()}`,
        sidebar: { label: manifest.name, collapsed: true },
        typeDoc: {
          skipErrorChecking: true,
          readme: join(import.meta.dirname, "api-readme.md"),
        },
      }),
    };
  });

export default defineConfig({
  site: "https://memoair-labs.github.io",
  base: "/Airlink/docs",
  integrations: [
    starlight({
      title: "AirLink",
      favicon: "https://memoair-labs.github.io/Airlink/memoair.svg",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/MemoAir-labs/Airlink",
        },
      ],
      components: { SiteTitle: "./src/components/SiteTitle.astro" },
      plugins: typeDocs.map(({ plugin }) => plugin),
      sidebar: [
        {
          label: "AirLink home",
          link: "https://memoair-labs.github.io/Airlink/",
        },
        {
          label: "Start",
          items: [
            { label: "Introduction", link: "/" },
            { slug: "getting-started" },
            {
              label: "Templates",
              items: [{ autogenerate: { directory: "templates" } }],
            },
          ],
        },
        {
          label: "Concepts",
          items: [
            { slug: "architecture" },
            { slug: "agents" },
            { slug: "huddle" },
            { slug: "desktop" },
          ],
        },
        {
          label: "Operate",
          items: [{ slug: "self-hosting" }, { slug: "security" }],
        },
        {
          label: "Packages",
          items: [{ autogenerate: { directory: "packages" } }],
        },
        {
          label: "API reference",
          items: typeDocs.map(({ sidebar }) => sidebar),
        },
        { slug: "faq" },
      ],
    }),
  ],
});
