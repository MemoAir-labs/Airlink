import type { DecisionRecord } from "@memo-air/decide";
import type {
  BrowserFramesResponse,
  BrowserOpsRequest,
  BrowserOpsResponse,
  BrowserReadResponse,
  BrowserVideoResponse,
  CanvasOpsRequest,
  CanvasOpsResponse,
  CanvasReadResponse,
  ChatOpsRequest,
  ChatOpsResponse,
  ChatReadResponse,
  CommentRequest,
  DeckReadResponse,
  DesktopOpsRequest,
  DesktopOpsResponse,
  DesktopView,
  DocSummary,
  HistoryResponse,
  LiveOpsRequest,
  LiveOpsResponse,
  MediaTokenRequest,
  MediaTokenResponse,
  OutlineResponse,
  SheetOpsRequest,
  SheetOpsResponse,
  SheetReadResponse,
  SlidesOpsRequest,
  SlidesOpsResponse,
  SpaceOpsRequest,
  SpaceOpsResponse,
  SpaceReadResponse,
  SpeakResponse,
  TranscriptRequest,
  TranscriptResponse,
  VersionResponse,
} from "@memo-air/protocol";
import {
  browserFramesResponseSchema,
  browserOpsResponseSchema,
  browserReadResponseSchema,
  browserVideoResponseSchema,
  canvasOpsResponseSchema,
  canvasReadResponseSchema,
  chatOpsResponseSchema,
  chatReadResponseSchema,
  commentResponseSchema,
  deckReadResponseSchema,
  desktopOpsResponseSchema,
  desktopViewSchema,
  historyResponseSchema,
  liveOpsResponseSchema,
  mediaTokenResponseSchema,
  outlineResponseSchema,
  sheetOpsResponseSchema,
  sheetReadResponseSchema,
  slidesOpsResponseSchema,
  spaceOpsResponseSchema,
  spaceReadResponseSchema,
  speakResponseSchema,
  summariesResponseSchema,
  transcriptResponseSchema,
  versionResponseSchema,
} from "@memo-air/protocol";

export type LiveAgentClient = {
  outline(): Promise<OutlineResponse>;
  markdown(): Promise<string>;
  ops(request: LiveOpsRequest): Promise<LiveOpsResponse>;
  history(): Promise<HistoryResponse>;
  version(uptoId: string, sinceId?: string): Promise<VersionResponse>;
  restore(uptoId: string): Promise<void>;
  comment(request: CommentRequest): Promise<{ threadId: string }>;
  sheetOps(request: SheetOpsRequest): Promise<SheetOpsResponse>;
  readSheet(range?: string): Promise<SheetReadResponse>;
  xlsx(title: string): Promise<Buffer>;
  canvasOps(request: CanvasOpsRequest): Promise<CanvasOpsResponse>;
  readCanvas(): Promise<CanvasReadResponse>;
  chatOps(request: ChatOpsRequest): Promise<ChatOpsResponse>;
  readChat(options?: {
    since?: number;
    limit?: number;
  }): Promise<ChatReadResponse>;
  spaceOps(request: SpaceOpsRequest): Promise<SpaceOpsResponse>;
  readSpace(): Promise<SpaceReadResponse>;
  pptx(title: string): Promise<Buffer>;
  slidesOps(request: SlidesOpsRequest): Promise<SlidesOpsResponse>;
  readDeck(): Promise<DeckReadResponse>;
  browserOps(request: BrowserOpsRequest): Promise<BrowserOpsResponse>;
  readBrowser(options?: { screenshot?: boolean }): Promise<BrowserReadResponse>;
  browserVideo(): Promise<BrowserVideoResponse>;
  frames(): Promise<BrowserFramesResponse>;
  frame(id: string): Promise<Buffer>;
  desktopOps(request: DesktopOpsRequest): Promise<DesktopOpsResponse>;
  readDesktop(options?: { screenshot?: boolean }): Promise<DesktopView>;
  mediaToken(request?: MediaTokenRequest): Promise<MediaTokenResponse>;
  transcript(): Promise<TranscriptResponse>;
  addTranscript(line: TranscriptRequest): Promise<void>;
  speak(text: string): Promise<SpeakResponse>;
};

export class LiveRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    throw new LiveRequestError(response.status, await response.text());
  }
  return response;
}

export async function fetchLiveSummaries({
  baseUrl,
  serviceToken,
  docNames,
  viewerId,
}: {
  baseUrl: string;
  serviceToken: string;
  docNames: string[];
  viewerId?: string;
}): Promise<DocSummary[]> {
  const response = await request(`${baseUrl}/v1/summaries`, serviceToken, {
    method: "POST",
    body: JSON.stringify({ docNames, viewerId }),
  });
  return summariesResponseSchema.parse(await response.json()).summaries;
}

// A host's own decisions land in live_decisions beside the room's, under the same service token.
export async function recordLiveDecision({
  baseUrl,
  serviceToken,
  record,
}: {
  baseUrl: string;
  serviceToken: string;
  record: DecisionRecord & { docName?: string };
}): Promise<void> {
  await request(`${baseUrl}/v1/decisions`, serviceToken, {
    method: "POST",
    body: JSON.stringify(record),
  });
}

export function createLiveAgentClient({
  baseUrl,
  docName,
  token,
}: {
  baseUrl: string;
  docName: string;
  token: string;
}): LiveAgentClient {
  const call = (route: string, init: RequestInit = {}) =>
    request(
      `${baseUrl}/v1/docs/${encodeURIComponent(docName)}/${route}`,
      token,
      init
    );

  return {
    outline: async () =>
      outlineResponseSchema.parse(await (await call("outline")).json()),
    markdown: async () => (await call("markdown")).text(),
    ops: async (request) =>
      liveOpsResponseSchema.parse(
        await (
          await call("ops", { method: "POST", body: JSON.stringify(request) })
        ).json()
      ),
    history: async () =>
      historyResponseSchema.parse(await (await call("history")).json()),
    version: async (uptoId, sinceId) =>
      versionResponseSchema.parse(
        await (
          await call(
            `versions/${uptoId}${sinceId ? `?since=${encodeURIComponent(sinceId)}` : ""}`
          )
        ).json()
      ),
    comment: async (request) =>
      commentResponseSchema.parse(
        await (
          await call("comments", {
            method: "POST",
            body: JSON.stringify(request),
          })
        ).json()
      ),
    sheetOps: async (request) =>
      sheetOpsResponseSchema.parse(
        await (
          await call("sheet-ops", {
            method: "POST",
            body: JSON.stringify(request),
          })
        ).json()
      ),
    readSheet: async (range) =>
      sheetReadResponseSchema.parse(
        await (
          await call(
            `sheet${range ? `?range=${encodeURIComponent(range)}` : ""}`
          )
        ).json()
      ),
    xlsx: async (title) =>
      Buffer.from(
        await (
          await call(`xlsx?title=${encodeURIComponent(title)}`)
        ).arrayBuffer()
      ),
    canvasOps: async (request) =>
      canvasOpsResponseSchema.parse(
        await (
          await call("canvas-ops", {
            method: "POST",
            body: JSON.stringify(request),
          })
        ).json()
      ),
    readCanvas: async () =>
      canvasReadResponseSchema.parse(await (await call("canvas")).json()),
    chatOps: async (request) =>
      chatOpsResponseSchema.parse(
        await (
          await call("chat-ops", {
            method: "POST",
            body: JSON.stringify(request),
          })
        ).json()
      ),
    readChat: async ({ since, limit } = {}) => {
      const query = new URLSearchParams();
      if (since !== undefined) {
        query.set("since", String(since));
      }
      if (limit !== undefined) {
        query.set("limit", String(limit));
      }
      const search = query.toString();
      return chatReadResponseSchema.parse(
        await (await call(`chat${search ? `?${search}` : ""}`)).json()
      );
    },
    spaceOps: async (request) =>
      spaceOpsResponseSchema.parse(
        await (
          await call("space-ops", {
            method: "POST",
            body: JSON.stringify(request),
          })
        ).json()
      ),
    readSpace: async () =>
      spaceReadResponseSchema.parse(await (await call("space")).json()),
    pptx: async (title) =>
      Buffer.from(
        await (
          await call(`pptx?title=${encodeURIComponent(title)}`)
        ).arrayBuffer()
      ),
    slidesOps: async (request) =>
      slidesOpsResponseSchema.parse(
        await (
          await call("slides-ops", {
            method: "POST",
            body: JSON.stringify(request),
          })
        ).json()
      ),
    readDeck: async () =>
      deckReadResponseSchema.parse(await (await call("deck")).json()),
    browserOps: async (request) =>
      browserOpsResponseSchema.parse(
        await (
          await call("browser-ops", {
            method: "POST",
            body: JSON.stringify(request),
          })
        ).json()
      ),
    readBrowser: async ({ screenshot = false } = {}) =>
      browserReadResponseSchema.parse(
        await (await call(`browser${screenshot ? "?screenshot=1" : ""}`)).json()
      ),
    desktopOps: async (request) =>
      desktopOpsResponseSchema.parse(
        await (
          await call("desktop-ops", {
            method: "POST",
            body: JSON.stringify(request),
          })
        ).json()
      ),
    readDesktop: async ({ screenshot = false } = {}) =>
      desktopViewSchema.parse(
        await (await call(`desktop${screenshot ? "?screenshot=1" : ""}`)).json()
      ),
    browserVideo: async () =>
      browserVideoResponseSchema.parse(
        await (await call("browser-video", { method: "POST" })).json()
      ),
    mediaToken: async (request = {}) =>
      mediaTokenResponseSchema.parse(
        await (
          await call("media-token", {
            method: "POST",
            body: JSON.stringify(request),
          })
        ).json()
      ),
    transcript: async () =>
      transcriptResponseSchema.parse(await (await call("transcript")).json()),
    addTranscript: async (line) => {
      await call("transcript", { method: "POST", body: JSON.stringify(line) });
    },
    speak: async (text) =>
      speakResponseSchema.parse(
        await (
          await call("speak", {
            method: "POST",
            body: JSON.stringify({ text }),
          })
        ).json()
      ),
    frames: async () =>
      browserFramesResponseSchema.parse(await (await call("frames")).json()),
    frame: async (id) =>
      Buffer.from(
        await (await call(`frames/${encodeURIComponent(id)}`)).arrayBuffer()
      ),
    restore: async (uptoId) => {
      await call("restore", {
        method: "POST",
        body: JSON.stringify({ uptoId }),
      });
    },
  };
}
