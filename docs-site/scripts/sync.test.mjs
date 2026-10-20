import assert from "node:assert/strict";
import { test } from "node:test";

import { rewriteLinks, siteBase, titleAndBody } from "./sync.mjs";

const pages = new Map([
  ["README.md", ""],
  ["docs/security.md", "security"],
  ["packages/react/README.md", "packages/react"],
]);
const from = "packages/react/README.md";

test("the first H1 becomes the title and leaves the body", () => {
  assert.deepEqual(titleAndBody("<div>\n\n# AirLink\n\nOne room.\n", "x"), {
    title: "AirLink",
    body: "<div>\n\n\nOne room.\n",
  });
  assert.deepEqual(titleAndBody("No heading.\n", "faq"), {
    title: "faq",
    body: "No heading.\n",
  });
});

test("links to published markdown become site routes, keeping anchors", () => {
  assert.equal(
    rewriteLinks("[s](../../docs/security.md#tokens)", from, pages, siteBase),
    "[s](/Airlink/docs/security/#tokens)"
  );
  assert.equal(
    rewriteLinks("[home](../../README.md)", from, pages, siteBase),
    "[home](/Airlink/docs/)"
  );
});

test("links to anything else point at GitHub; absolute links and anchors stay", () => {
  assert.equal(
    rewriteLinks(
      "[c](../../CONTRIBUTING.md) [a](../../apps/airlink/README.md)",
      from,
      pages,
      siteBase
    ),
    "[c](https://github.com/MemoAir-labs/Airlink/blob/main/CONTRIBUTING.md) [a](https://github.com/MemoAir-labs/Airlink/blob/main/apps/airlink/README.md)"
  );
  assert.equal(
    rewriteLinks(
      "[x](https://example.com/a.md) [top](#use)",
      from,
      pages,
      siteBase
    ),
    "[x](https://example.com/a.md) [top](#use)"
  );
});
