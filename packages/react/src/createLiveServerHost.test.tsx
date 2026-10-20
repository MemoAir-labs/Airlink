// @vitest-environment jsdom
import { signLiveToken } from "@memo-air/protocol/tokens";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { Component, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { accessOf, createLiveServerHost } from "./createLiveServerHost";
import type { LiveHostDoc } from "./host";
import { LiveHostProvider } from "./host";
import { LiveBrowserView } from "./LiveBrowserView";
import { LiveCanvasView } from "./LiveCanvasView";
import { LiveDesktopView } from "./LiveDesktopView";
import { LiveDocView } from "./LiveDocView";
import { LiveFileView } from "./LiveFileView";
import { LiveMediaView } from "./LiveMediaView";
import { LiveRunnerView } from "./LiveRunnerView";
import { LiveSheetView } from "./LiveSheetView";
import { LiveSlidesView } from "./LiveSlidesView";
import { LiveSpaceView } from "./LiveSpaceView";
import type { LiveDocViewProps } from "./liveViewShared";

// Excalidraw needs a real canvas; the board is a lazy chunk the host has no say in.
vi.mock("./LiveCanvasBoard", () => ({ default: () => null }));

const secret = "test-secret";
const settleMs = 50;
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
  "space",
] as const;
const docs: LiveHostDoc[] = kinds.map((kind) => ({
  sId: `room-${kind}`,
  title: kind,
  kind,
  conversationId: "room",
}));
const views = {
  doc: LiveDocView,
  sheet: LiveSheetView,
  slides: LiveSlidesView,
  canvas: LiveCanvasView,
  browser: LiveBrowserView,
  desktop: LiveDesktopView,
  runner: LiveRunnerView,
  file: LiveFileView,
  media: LiveMediaView,
};

const tokenFor = (docName: string, access: "read" | "write" = "write") =>
  signLiveToken(
    { actor: { kind: "human", ...user }, workspaceId: "test", docName, access },
    secret,
    300
  );
const hostWith = (getToken = async (docId: string) => tokenFor(docId)) =>
  createLiveServerHost({ liveUrl: "ws://127.0.0.1:9", docs, user, getToken });

class Boundary extends Component<
  { errors: Error[]; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.errors.push(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => cleanup());

describe("accessOf", () => {
  it("reads what a token allows from its own claims", () => {
    expect(accessOf(tokenFor("room-doc", "read"))).toBe("read");
    expect(accessOf(tokenFor("room-doc"))).toBe("write");
    expect(accessOf("not-a-token")).toBeNull();
    expect(accessOf("a.e30.b")).toBeNull();
  });

  it("allows nothing once the token has expired", () => {
    expect(
      accessOf(
        signLiveToken(
          {
            actor: { kind: "human", ...user },
            workspaceId: "test",
            docName: "room-doc",
            access: "write",
          },
          secret,
          -10
        )
      )
    ).toBeNull();
  });
});

describe("useConnection", () => {
  it("connects to the live-server with the doc's kind and the token's access", async () => {
    const host = hostWith();
    const { result } = renderHook(() =>
      host.useConnection({ docId: "room-sheet" })
    );
    expect(result.current.isLiveDocLoading).toBe(true);
    await waitFor(() => expect(result.current.connection).not.toBeNull());
    expect(result.current.connection).toMatchObject({
      url: "ws://127.0.0.1:9",
      access: "write",
      canShare: false,
      liveDoc: { sId: "room-sheet", kind: "sheet" },
    });
    expect(result.current.isLiveDocError).toBe(false);
  });

  it("errors on a doc it was not given and on a failing token endpoint", async () => {
    const unknown = renderHook(() =>
      hostWith().useConnection({ docId: "elsewhere" })
    );
    expect(unknown.result.current).toEqual({
      connection: null,
      isLiveDocLoading: false,
      isLiveDocError: true,
    });
    const failingHost = hostWith(async () => {
      throw new Error("401");
    });
    const failing = renderHook(() =>
      failingHost.useConnection({ docId: "room-doc" })
    );
    await waitFor(() =>
      expect(failing.result.current.isLiveDocError).toBe(true)
    );
    expect(failing.result.current.connection).toBeNull();
  });
});

describe("every view with only a live-server behind it", () => {
  it.each(kinds)("renders %s without throwing", async (kind) => {
    const errors: Error[] = [];
    const props: LiveDocViewProps = {
      docId: `room-${kind}`,
      agents: [],
      renderHeader: ({ title }) => <h2>{title}</h2>,
    };
    const view =
      kind === "space" ? (
        <LiveSpaceView {...props} renderObject={() => null} />
      ) : (
        createElement(views[kind], props)
      );
    render(
      <LiveHostProvider host={hostWith()}>
        <Boundary errors={errors}>{view}</Boundary>
      </LiveHostProvider>
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    });
    expect(errors).toEqual([]);
  });
});
