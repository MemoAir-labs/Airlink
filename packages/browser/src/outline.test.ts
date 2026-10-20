import { describe, expect, it } from "vitest";

import type { AxNode } from "./index.ts";
import { diffOutline, formatOutline, outlineFromAxTree } from "./index.ts";

function node(
  nodeId: string,
  role: string,
  name: string,
  extra: Partial<AxNode> = {}
): AxNode {
  return {
    nodeId,
    role: { value: role },
    name: { value: name },
    ...extra,
  };
}

const page: AxNode[] = [
  node("1", "RootWebArea", "Shop", { childIds: ["2", "3", "6", "8", "10"] }),
  node("2", "heading", "Welcome to the shop", {
    properties: [{ name: "level", value: { value: 1 } }],
    childIds: ["2a"],
  }),
  node("2a", "StaticText", "Welcome to the shop"),
  node("3", "link", "Sign in", { backendDOMNodeId: 31, childIds: ["4"] }),
  node("4", "StaticText", "Sign in"),
  node("6", "textbox", "Search", {
    backendDOMNodeId: 61,
    value: { value: "shoes" },
  }),
  node("8", "checkbox", "In stock only", {
    backendDOMNodeId: 81,
    properties: [{ name: "checked", value: { value: "true" } }],
  }),
  node("10", "generic", "", { childIds: ["11", "12"] }),
  node("11", "StaticText", "  Free shipping   over $50 "),
  node("12", "button", "", { ignored: true, backendDOMNodeId: 121 }),
];

describe("outline", () => {
  it("numbers interactive elements and keeps text once", () => {
    const outline = outlineFromAxTree(page);
    expect(formatOutline(outline)).toBe(
      [
        'h1 "Welcome to the shop"',
        'e1 link "Sign in"',
        'e2 textbox "Search" = "shoes"',
        'e3 checkbox "In stock only" [checked]',
        'text "Free shipping over $50"',
      ].join("\n")
    );
    expect(outline.refs).toEqual({ e1: 31, e2: 61, e3: 81 });
  });

  it("reports what a step changed by content, not by ref", () => {
    const before = outlineFromAxTree(page);
    const after = outlineFromAxTree([
      node("1", "RootWebArea", "Shop", { childIds: ["3", "6", "9"] }),
      node("3", "link", "Sign in", { backendDOMNodeId: 31 }),
      node("6", "textbox", "Search", {
        backendDOMNodeId: 61,
        value: { value: "boots" },
      }),
      node("9", "button", "Add to cart", { backendDOMNodeId: 91 }),
    ]);
    expect(diffOutline(before, after)).toEqual({
      added: ['e textbox "Search" = "boots"', 'e button "Add to cart"'],
      removed: [
        'h1 "Welcome to the shop"',
        'e textbox "Search" = "shoes"',
        'e checkbox "In stock only" [checked]',
        'text "Free shipping over $50"',
      ],
    });
  });
});
