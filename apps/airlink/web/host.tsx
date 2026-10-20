import {
  browserFramesResponseSchema,
  browserVideoResponseSchema,
  commentResponseSchema,
  historyResponseSchema,
  mediaTokenResponseSchema,
  versionResponseSchema,
} from "@memo-air/protocol";
import type {
  LiveDockItem,
  LiveHost,
  LiveHostConnection,
  LiveHostDoc,
} from "@memo-air/react";
import { useSendNotification } from "@memo-air/react/ui";
import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { z } from "zod";

import type { ChannelObject, Person } from "./api.ts";
import {
  api,
  fileInfoSchema,
  runnerInfoSchema,
  tokenSchema,
  useApi,
  voiceSchema,
} from "./api.ts";

// What changes per screen (who is here, which channel, the theme); the LiveHost below is one
// constant object whose hooks read this.
export type AirlinkView = {
  person: Person;
  channelId: string | null;
  objects: ChannelObject[];
  isDark: boolean;
  openDoc: ((docId: string) => void) | null;
  dock: LiveDockItem[];
  deleteObject: (
    docName: string,
    options?: { ifUntouched: boolean }
  ) => Promise<boolean>;
  uploadFiles: (files: File[]) => void;
};

const AirlinkViewContext = createContext<AirlinkView | null>(null);

export function AirlinkViewProvider({
  view,
  children,
}: {
  view: AirlinkView;
  children: ReactNode;
}) {
  return (
    <AirlinkViewContext.Provider value={view}>
      {children}
    </AirlinkViewContext.Provider>
  );
}

function useView(): AirlinkView {
  const view = useContext(AirlinkViewContext);
  if (!view) {
    throw new Error("AirLink's live views need an AirlinkViewProvider.");
  }
  return view;
}

const liveRoute = (docId: string, route: string) =>
  `/api/live/${encodeURIComponent(docId)}/${route}`;

const okSchema = z.unknown();
const transcribeTokenSchema = z.object({
  token: z.string(),
  baseUri: z.string(),
});

export async function fetchToken(docName: string) {
  return api("/api/tokens", tokenSchema, {
    method: "POST",
    body: { docName },
  });
}

// A view's router and its body each ask for the doc's connection as they mount; one answer serves
// both. Tokens live five minutes, so a minute-old one is still good; a refresh always fetches.
const connectionReuseMs = 60_000;
const recentTokens = new Map<
  string,
  { fetchedAtMs: number; result: ReturnType<typeof fetchToken> }
>();
const connectionToken = (docName: string) => {
  const recent = recentTokens.get(docName);
  if (recent && Date.now() - recent.fetchedAtMs < connectionReuseMs) {
    return recent.result;
  }
  const result = fetchToken(docName);
  recentTokens.set(docName, { fetchedAtMs: Date.now(), result });
  void result.then((settled) => {
    if (!settled.ok) {
      recentTokens.delete(docName);
    }
  });
  return result;
};

function useConnection({
  docId,
  disabled,
}: {
  docId: string | undefined;
  disabled?: boolean;
}) {
  const [state, setState] = useState<{
    connection: LiveHostConnection | null;
    isLiveDocError: boolean;
  }>({ connection: null, isLiveDocError: false });

  useEffect(() => {
    if (!docId || disabled) {
      return;
    }
    let cancelled = false;
    setState({ connection: null, isLiveDocError: false });
    void connectionToken(docId).then((result) => {
      if (cancelled) {
        return;
      }
      setState(
        result.ok
          ? {
              connection: {
                url: result.data.url,
                token: result.data.token,
                access: result.data.access,
                liveDoc: result.data.liveDoc ?? {
                  sId: docId,
                  title: "Chat",
                  kind: "doc",
                  conversationId: result.data.channelId,
                },
                canShare: false,
              },
              isLiveDocError: false,
            }
          : { connection: null, isLiveDocError: true }
      );
    });
    return () => {
      cancelled = true;
    };
  }, [docId, disabled]);

  return {
    ...state,
    isLiveDocLoading:
      !disabled && !!docId && !state.connection && !state.isLiveDocError,
  };
}

function downloadBlob(blob: Blob, fileName: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

export const airlinkHost: LiveHost = {
  useConnection,
  useFetchToken: (docId) =>
    useCallback(async () => {
      const result = await fetchToken(docId);
      return result.ok ? result.data.token : "";
    }, [docId]),
  useUser: () => useView().person,
  useIsDark: () => useView().isDark,
  useLiveDocs: () => {
    const { objects, channelId } = useView();
    return {
      liveDocs: objects.map(
        (object): LiveHostDoc => ({
          sId: object.docName,
          title: object.title,
          kind: object.kind,
          conversationId: channelId,
        })
      ),
    };
  },
  useOpenDoc: () => useView().openDoc,
  useDock: () => useView().dock,
  useDeleteObject: () => useView().deleteObject,
  useUploadFiles: () => useView().uploadFiles,
  useFile: (docId) => {
    const { data } = useApi(
      `/api/files/${encodeURIComponent(docId)}/info`,
      fileInfoSchema
    );
    return useMemo(
      () =>
        data
          ? { ...data, url: `/api/files/${encodeURIComponent(docId)}` }
          : null,
      [data, docId]
    );
  },
  useRunner: (docId, runKey) => {
    const doc = encodeURIComponent(docId);
    const run = runKey ? `?run=${encodeURIComponent(runKey)}` : "";
    const { data } = useApi(`/api/runs/${doc}${run}`, runnerInfoSchema);
    return useMemo(
      () =>
        data
          ? {
              available: data.available,
              outputUrl: (name: string) =>
                `/api/runs/${doc}/out/${name.split("/").map(encodeURIComponent).join("/")}${run}`,
              dashboardUrl: `${data.frameBase}index.html${run}`,
              rerun: async () => {
                const result = await api(`/api/runs/${doc}/run`, okSchema, {
                  method: "POST",
                  body: {},
                });
                return result.ok ? null : result.error;
              },
              setPaused: async (paused: boolean) => {
                const result = await api(`/api/runs/${doc}/paused`, okSchema, {
                  method: "POST",
                  body: { paused },
                });
                return result.ok ? null : result.error;
              },
            }
          : null,
      [data, doc, run]
    );
  },
  useHistory: ({ docId, disabled }) => {
    const { data, error, isLoading, reload } = useApi(
      disabled ? null : liveRoute(docId, "history"),
      historyResponseSchema
    );
    return {
      history: data,
      isHistoryLoading: isLoading,
      isHistoryError: error !== null,
      mutateHistory: async () => reload(),
    };
  },
  useVersion: ({ docId, uptoId, sinceId }) => {
    const { data, isLoading } = useApi(
      uptoId
        ? liveRoute(
            docId,
            `versions/${uptoId}${sinceId ? `?since=${sinceId}` : ""}`
          )
        : null,
      versionResponseSchema
    );
    return { version: data, isVersionLoading: isLoading };
  },
  useRestore: (docId) => {
    const notify = useSendNotification();
    return useCallback(
      async (uptoId: string) => {
        const result = await api(liveRoute(docId, "restore"), okSchema, {
          method: "POST",
          body: { uptoId },
        });
        notify(
          result.ok
            ? { type: "success", title: "Version restored" }
            : { type: "error", title: "Could not restore this version" }
        );
        return result.ok;
      },
      [docId, notify]
    );
  },
  useComment: (docId) => {
    const notify = useSendNotification();
    return useCallback(
      async (request) => {
        const result = await api(
          liveRoute(docId, "comments"),
          commentResponseSchema,
          { method: "POST", body: request }
        );
        if (!result.ok) {
          notify({ type: "error", title: "Could not post the comment" });
          return null;
        }
        return result.data.threadId;
      },
      [docId, notify]
    );
  },
  // An @mention in a doc comment reaches agents through the channel in AirLink, not a side door.
  usePostMention: () => null,
  useDownloadFile: ({ docId, format }) => {
    const notify = useSendNotification();
    return useCallback(
      async (title: string) => {
        const response = await fetch(liveRoute(docId, format));
        if (!response.ok) {
          notify({ type: "error", title: `Could not export as ${format}` });
          return;
        }
        downloadBlob(await response.blob(), `${title}.${format}`);
      },
      [docId, format, notify]
    );
  },
  useBrowserFrames: ({ docId, disabled }) => {
    const { data, isLoading } = useApi(
      disabled ? null : liveRoute(docId, "frames"),
      browserFramesResponseSchema
    );
    return {
      frames: data?.frames ?? [],
      frameUrl: (frameId) => liveRoute(docId, `frames/${frameId}`),
      isFramesLoading: isLoading,
    };
  },
  useFetchBrowserVideo: (docId) =>
    useCallback(async () => {
      const result = await api(
        liveRoute(docId, "browser-video"),
        browserVideoResponseSchema,
        { method: "POST", body: {} }
      );
      return result.ok ? result.data : null;
    }, [docId]),
  useFetchMediaToken: ({ docId, viewer }) =>
    useCallback(async () => {
      const result = await api(
        liveRoute(docId, "media-token"),
        mediaTokenResponseSchema,
        { method: "POST", body: viewer ? { viewer } : {} }
      );
      return result.ok ? result.data : null;
    }, [docId, viewer]),
  usePostTranscriptLine: (docId) =>
    useCallback(
      async (line) =>
        (
          await api(liveRoute(docId, "transcript"), okSchema, {
            method: "POST",
            body: line,
          })
        ).ok,
      [docId]
    ),
  useFetchTranscribeToken: () =>
    useCallback(async () => {
      const result = await api("/api/transcribe-token", transcribeTokenSchema, {
        method: "POST",
        body: {},
      });
      return result.ok ? result.data : null;
    }, []),
  useServerVoice: () =>
    useApi("/api/voice", voiceSchema).data?.available ?? null,
  useLeaveCall: (docId) =>
    useCallback(
      (identity) => {
        void api(liveRoute(docId, "left"), okSchema, {
          method: "POST",
          body: { identity },
        });
      },
      [docId]
    ),
  renderShare: null,
};
