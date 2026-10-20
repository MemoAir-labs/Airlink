// @vitest-environment jsdom
import { signLiveToken } from "@memo-air/protocol/tokens";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveServerHost } from "../createLiveServerHost";
import type { LiveHostDoc } from "../host";
import { LiveHostProvider } from "../host";
import type { LiveDocViewProps } from "../liveViewShared";
import { LiveObjectView } from "./all";

const { viewFor } = vi.hoisted(() => ({
  viewFor:
    (name: string) =>
    ({ docId }: LiveDocViewProps) => <p>{`${name} ${docId}`}</p>,
}));

vi.mock("../LiveDocView", () => ({ LiveDocView: viewFor("doc") }));
vi.mock("../LiveSheetView", () => ({ LiveSheetView: viewFor("sheet") }));
vi.mock("../LiveSlidesView", () => ({ LiveSlidesView: viewFor("slides") }));
vi.mock("../LiveCanvasView", () => ({ LiveCanvasView: viewFor("canvas") }));
vi.mock("../LiveBrowserView", () => ({ LiveBrowserView: viewFor("browser") }));
vi.mock("../LiveDesktopView", () => ({ LiveDesktopView: viewFor("desktop") }));
vi.mock("../LiveRunnerView", () => ({ LiveRunnerView: viewFor("runner") }));
vi.mock("../LiveFileView", () => ({ LiveFileView: viewFor("file") }));
vi.mock("../LiveMediaView", () => ({ LiveMediaView: viewFor("media") }));
vi.mock("../LiveSpaceView", () => ({
  LiveSpaceView: ({
    renderObject,
    ...props
  }: LiveDocViewProps & {
    renderObject: (object: LiveDocViewProps) => ReactNode;
  }) => (
    <section>
      <p>{`space ${props.docId}`}</p>
      {renderObject({ ...props, docId: "room-sheet" })}
    </section>
  ),
}));

const secret = "test-secret";
const user = { id: "ada", name: "Ada" };
const kinds = [
  "doc",
  "sheet",
  "slides",
  "canvas",
  "browser",
  "desktop",
  "runner",
  "file",
  "media",
] as const;
const docs: LiveHostDoc[] = [...kinds, "space" as const].map((kind) => ({
  sId: `room-${kind}`,
  title: kind,
  kind,
  conversationId: "room",
}));
const host = createLiveServerHost({
  liveUrl: "ws://127.0.0.1:9",
  docs,
  user,
  getToken: async (docName) =>
    signLiveToken(
      {
        actor: { kind: "human", ...user },
        workspaceId: "test",
        docName,
        access: "write",
      },
      secret,
      300
    ),
});
const renderObject = (docId: string) =>
  render(
    <LiveHostProvider host={host}>
      <LiveObjectView docId={docId} agents={[]} renderHeader={() => null} />
    </LiveHostProvider>
  );

afterEach(() => cleanup());

describe("LiveObjectView", () => {
  it.each(kinds)("draws a %s with its own view", async (kind) => {
    renderObject(`room-${kind}`);
    expect(await screen.findByText(`${kind} room-${kind}`)).toBeTruthy();
  });

  it("draws a space's objects through itself", async () => {
    renderObject("room-space");
    expect(await screen.findByText("space room-space")).toBeTruthy();
    expect(await screen.findByText("sheet room-sheet")).toBeTruthy();
  });
});
