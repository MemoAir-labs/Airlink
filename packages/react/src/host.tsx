import type {
  BrowserFramesResponse,
  BrowserVideoResponse,
  HistoryResponse,
  LiveAccess,
  LiveDocKind,
  MediaTokenResponse,
  VersionResponse,
} from "@memo-air/protocol";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";

export type LiveHostDoc = {
  sId: string;
  title: string;
  kind: LiveDocKind;
  conversationId: string | null;
};

export type LiveHostConnection = {
  url: string;
  token: string;
  access: LiveAccess;
  liveDoc: LiveHostDoc;
  canShare: boolean;
};

export type LiveHostUser = { id: string; name: string };

export type LiveCommentRequest =
  | { threadId: string; body: string }
  | { blockId: string; quote: string; body: string };

export type LiveMentionRequest = {
  agentConfigurationId: string;
  threadId: string;
  blockId: string;
  quote: string;
  body: string;
};

export type LiveTranscriptLine = { id: string; text: string; final: boolean };

export type LiveHostFile = {
  name: string;
  mime: string;
  sizeBytes: number;
  url: string;
};

// A runner's controls and where its last run's files are served. The window never edits code.
export type LiveHostRunner = {
  // False when the host has no runner container; the window says so and offers no Re-run.
  available: boolean;
  outputUrl(name: string): string;
  // The last run's index.html, at a URL its relative links resolve against.
  dashboardUrl: string | null;
  // Each resolves to the host's refusal, or null when it went through.
  rerun(): Promise<string | null>;
  setPaused(paused: boolean): Promise<string | null>;
};

// What a host that draws the space as a desktop puts in its dock: one launcher per kind it can
// create there.
export type LiveDockItem = {
  kind: LiveDocKind;
  label: string;
  onOpen: () => void;
};

// What a live view needs from the app it runs in. Every member is a hook, so a host builds it
// from its own data layer (SWR in Memoair, plain fetch in Airlink); the object must not change
// between renders, which keeps the hook order stable.
export type LiveHost = {
  useConnection(args: { docId: string | undefined; disabled?: boolean }): {
    connection: LiveHostConnection | null;
    isLiveDocLoading: boolean;
    isLiveDocError: boolean;
  };
  // The provider calls this on every (re)connect, so it must stay stable per doc.
  useFetchToken(docId: string): () => Promise<string>;
  useUser(): LiveHostUser | null;
  useIsDark(): boolean;
  useLiveDocs(args?: { disabled?: boolean }): { liveDocs: LiveHostDoc[] };
  // Null when the host has no page of its own for one doc.
  useOpenDoc(): ((docId: string) => void) | null;
  useHistory(args: { docId: string; disabled?: boolean }): {
    history: HistoryResponse | null;
    isHistoryLoading: boolean;
    isHistoryError: boolean;
    mutateHistory: () => Promise<unknown>;
  };
  useVersion(args: {
    docId: string;
    uptoId: string | null;
    sinceId: string | null;
  }): { version: VersionResponse | null; isVersionLoading: boolean };
  useRestore(docId: string): (uptoId: string) => Promise<boolean>;
  useComment(
    docId: string
  ): (request: LiveCommentRequest) => Promise<string | null>;
  // Null when an @mention in a doc comment cannot ask an agent in this host.
  usePostMention(
    docId: string
  ): ((mention: LiveMentionRequest) => Promise<boolean>) | null;
  useDownloadFile(args: {
    docId: string;
    format: "xlsx" | "pptx";
  }): (title: string) => Promise<void>;
  useBrowserFrames(args: { docId: string; disabled?: boolean }): {
    frames: BrowserFramesResponse["frames"];
    frameUrl: (frameId: string) => string;
    isFramesLoading: boolean;
  };
  useFetchBrowserVideo(
    docId: string
  ): () => Promise<BrowserVideoResponse | null>;
  useFetchMediaToken(args: {
    docId: string;
    viewer?: string;
  }): () => Promise<MediaTokenResponse | null>;
  usePostTranscriptLine(
    docId: string
  ): (line: LiveTranscriptLine) => Promise<boolean>;
  // A single-use ElevenLabs Scribe token, so the call transcribes in every browser; null when the
  // host has no key, and the browser's own speech service is tried instead.
  useFetchTranscribeToken(): () => Promise<{
    token: string;
    baseUri: string;
  } | null>;
  // True when the host speaks for agents and transcribes the call itself; the browser then neither
  // transcribes its microphone nor voices agent lines. Null while the host is still finding out.
  useServerVoice?(): boolean | null;
  // Tells the host this person left the call, so it stops listening for them.
  useLeaveCall?(docId: string): (identity: string) => void;
  // Draws the space as a desktop — wallpaper, traffic-light windows, a dock, closed windows as
  // icons — when present and non-null; without it the space is a plain board.
  useDock?(): LiveDockItem[] | null;
  // Deletes an object for good (emptying the desktop's bin, or closing a window nobody wrote in
  // with ifUntouched); null or absent keeps the bin to putting things back.
  useDeleteObject?():
    | ((
        docName: string,
        options?: { ifUntouched: boolean }
      ) => Promise<boolean>)
    | null;
  // Puts files from the person's machine into the space, one window each; null or absent leaves
  // the desktop without uploads.
  useUploadFiles?(): ((files: File[]) => void) | null;
  // An uploaded file's name, type and size, and the URL its bytes are served from.
  useFile?(docId: string): LiveHostFile | null;
  // A runner's controls; runKey changes with every run so the host hands out fresh URLs. Absent
  // when the host keeps no runners.
  useRunner?(docId: string, runKey: string | null): LiveHostRunner | null;
  // Null hides the Share entry.
  renderShare:
    | ((args: {
        docId: string;
        title: string;
        isOpen: boolean;
        onClose: () => void;
      }) => ReactNode)
    | null;
};

const LiveHostContext = createContext<LiveHost | null>(null);

export function LiveHostProvider({
  host,
  children,
}: {
  host: LiveHost;
  children: ReactNode;
}) {
  return (
    <LiveHostContext.Provider value={host}>{children}</LiveHostContext.Provider>
  );
}

export function useLiveHost(): LiveHost {
  const host = useContext(LiveHostContext);
  if (!host) {
    throw new Error("A live view was rendered outside a LiveHostProvider.");
  }
  return host;
}
