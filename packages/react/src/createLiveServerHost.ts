import type { LiveAccess } from "@memo-air/protocol";
import { liveTokenClaimsSchema } from "@memo-air/protocol";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type {
  LiveHost,
  LiveHostConnection,
  LiveHostDoc,
  LiveHostUser,
} from "./host";

export type LiveServerHostOptions = {
  // The live-server's WebSocket URL, e.g. ws://localhost:3020.
  liveUrl: string;
  // The objects this app opens. A token carries no kind, so the app says what each doc is.
  docs: LiveHostDoc[];
  user: LiveHostUser;
  // The app's token endpoint: a fresh live token for one doc. Called on every (re)connect.
  getToken: (docId: string) => Promise<string>;
};

type Settled = { docId: string; connection: LiveHostConnection | null };

const darkQuery = "(prefers-color-scheme: dark)";
const subscribeDark = (onChange: () => void) => {
  const query = matchMedia(darkQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const isDark = () => matchMedia(darkQuery).matches;

// Stable, so views that list them in effect dependencies do not re-run every render.
const none = async () => null;
const refuse = async () => false;
const nothing = async () => undefined;
const noComments = async () => "This app keeps no comment threads over HTTP.";
const noHistory = {
  history: null,
  isHistoryLoading: false,
  isHistoryError: true,
  mutateHistory: nothing,
};
const noVersion = { version: null, isVersionLoading: false };
const noFrames = { frames: [], frameUrl: () => "", isFramesLoading: false };

// What a token allows, from its own claims; an expired token allows nothing. Only display depends
// on it: live-server checks the signature and refuses what the token does not allow.
export function accessOf(token: string): LiveAccess | null {
  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    const json: unknown = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
    );
    const isExpired =
      typeof json === "object" &&
      json !== null &&
      "exp" in json &&
      typeof json.exp === "number" &&
      json.exp * 1000 <= Date.now();
    const claims = liveTokenClaimsSchema.safeParse(json);
    return claims.success && !isExpired ? claims.data.access : null;
  } catch {
    return null;
  }
}

// A LiveHost for an app that has a live-server and a token endpoint and nothing else. Features only
// a full host provides (history, exports, browser frames, call tokens, sharing) report themselves
// unavailable, and each view shows its empty state for them. Create it once, outside render.
export function createLiveServerHost({
  liveUrl,
  docs,
  user,
  getToken,
}: LiveServerHostOptions): LiveHost {
  const liveDocs = { liveDocs: docs };
  return {
    useConnection: ({ docId, disabled }) => {
      const liveDoc = docs.find((doc) => doc.sId === docId) ?? null;
      const [settled, setSettled] = useState<Settled | null>(null);
      useEffect(() => {
        if (!liveDoc || disabled) {
          return;
        }
        let current = true;
        const settle = (connection: LiveHostConnection | null) => {
          if (current) {
            setSettled({ docId: liveDoc.sId, connection });
          }
        };
        getToken(liveDoc.sId).then(
          (token) => {
            const access = accessOf(token);
            settle(
              access
                ? { url: liveUrl, token, access, liveDoc, canShare: false }
                : null
            );
          },
          () => settle(null)
        );
        return () => {
          current = false;
        };
      }, [liveDoc, disabled]);
      const mine = settled?.docId === docId ? settled : null;
      return {
        connection: mine?.connection ?? null,
        isLiveDocLoading: Boolean(liveDoc) && !disabled && !mine,
        isLiveDocError:
          Boolean(docId) && (!liveDoc || (mine !== null && !mine.connection)),
      };
    },
    useFetchToken: (docId) => useCallback(() => getToken(docId), [docId]),
    useUser: () => user,
    useIsDark: () => useSyncExternalStore(subscribeDark, isDark, () => false),
    useLiveDocs: () => liveDocs,
    useOpenDoc: () => null,
    useHistory: () => noHistory,
    useVersion: () => noVersion,
    useRestore: () => refuse,
    useComment: () => noComments,
    usePostMention: () => null,
    useDownloadFile: () => nothing,
    useBrowserFrames: () => noFrames,
    useFetchBrowserVideo: () => none,
    useFetchMediaToken: () => none,
    usePostTranscriptLine: () => refuse,
    useFetchTranscribeToken: () => none,
    renderShare: null,
  };
}
