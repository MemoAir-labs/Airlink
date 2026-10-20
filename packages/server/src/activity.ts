import type { Hocuspocus } from "@hocuspocus/server";
import type { DocSummary, LiveActor } from "@memo-air/protocol";
import { liveActorSchema } from "@memo-air/protocol";
import type { Logger } from "pino";

import type { LivePersistence, PendingSuggestionRow } from "./persistence.ts";

const activityDebounceMs = 300;

type DocState = {
  workspaceId: string | null;
  lastEditor: { actor: LiveActor; editedAt: string } | null;
  pending: PendingSuggestionRow[] | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Activity is what a card, a Library row or Home shows about a doc without opening it: who is in
// it, which agent is writing which section, the last edit and the pending suggestions. It is
// pushed to watchers as a stateless message, debounced per doc.
export function createActivity({
  hocuspocus,
  persistence,
  logger,
}: {
  hocuspocus: Hocuspocus;
  persistence: LivePersistence;
  logger: Logger;
}) {
  const docs = new Map<string, DocState>();
  const watchersByDoc = new Map<string, Set<string>>();
  const timers = new Map<string, NodeJS.Timeout>();
  const dirty = new Set<string>();
  // Agents writing right now, recorded where their caret moves; a doc can unload mid-write when no
  // human has it open, so awareness alone would lose them.
  const writers = new Map<string, Map<string, DocSummary["writing"][number]>>();

  const stateOf = (docName: string): DocState => {
    const state = docs.get(docName) ?? {
      workspaceId: null,
      lastEditor: null,
      pending: null,
    };
    docs.set(docName, state);
    return state;
  };

  const presentIn = (docName: string): LiveActor[] => {
    const byId = new Map<string, LiveActor>();
    for (const connection of hocuspocus.documents
      .get(docName)
      ?.getConnections() ?? []) {
      const actor = liveActorSchema.safeParse(
        isRecord(connection.context) ? connection.context.actor : null
      );
      if (actor.success) {
        byId.set(actor.data.id, actor.data);
      }
    }
    return [...byId.values()];
  };

  const summarize = async (
    workspaceId: string,
    docNames: string[],
    viewerId?: string
  ): Promise<DocSummary[]> => {
    const missingEditors = docNames.filter(
      (name) => !docs.get(name)?.lastEditor
    );
    const missingPending = docNames.filter((name) => !docs.get(name)?.pending);
    const [editors, pending, seen] = await Promise.all([
      missingEditors.length
        ? persistence.lastEditors(missingEditors)
        : Promise.resolve(new Map()),
      missingPending.length
        ? persistence.pendingSuggestions(workspaceId, missingPending)
        : Promise.resolve(new Map<string, PendingSuggestionRow[]>()),
      viewerId && docNames.length
        ? persistence.lastSeen(docNames, viewerId)
        : Promise.resolve(new Map<string, string>()),
    ]);
    return docNames.map((docName) => {
      const state = docs.get(docName);
      const editor = state?.lastEditor ?? editors.get(docName) ?? null;
      // Pending rows cached in memory belong to the workspace that wrote them; a different
      // workspace's token never reads them.
      const cachedPending =
        state?.workspaceId === workspaceId ? state.pending : null;
      return {
        docName,
        lastEditor: editor?.actor ?? null,
        lastEditedAt: editor?.editedAt ?? null,
        seenAt: seen.get(docName) ?? null,
        present: presentIn(docName),
        writing: [...(writers.get(docName)?.values() ?? [])],
        pending: (cachedPending ?? pending.get(docName) ?? []).map((row) => ({
          id: row.id,
          approverId: row.approverId,
          approverName: row.approverName,
          actor: row.actor,
          createdAt: row.createdAt,
        })),
      };
    });
  };

  const push = async (docName: string) => {
    const watchers = watchersByDoc.get(docName);
    const { workspaceId } = stateOf(docName);
    if (!watchers?.size || !workspaceId) {
      return;
    }
    const [summary] = await summarize(workspaceId, [docName]);
    const payload = JSON.stringify({ type: "activity", summary });
    for (const watchDoc of watchers) {
      hocuspocus.documents.get(watchDoc)?.broadcastStateless(payload);
    }
  };

  const pushNow = (docName: string) => {
    push(docName).catch((err) =>
      logger.error({ err, docName }, "live: activity push failed")
    );
  };

  // Leading-edge throttle: the first change goes out at once, later ones at most every
  // activityDebounceMs, and the last change in a burst is never dropped.
  const schedule = (docName: string) => {
    if (!watchersByDoc.get(docName)?.size) {
      return;
    }
    if (timers.has(docName)) {
      dirty.add(docName);
      return;
    }
    pushNow(docName);
    const tick = () => {
      if (dirty.delete(docName)) {
        pushNow(docName);
        timers.set(docName, setTimeout(tick, activityDebounceMs));
      } else {
        timers.delete(docName);
      }
    };
    timers.set(docName, setTimeout(tick, activityDebounceMs));
  };

  return {
    summarize,
    schedule,

    noteWorkspace(docName: string, workspaceId: string | null) {
      if (workspaceId) {
        stateOf(docName).workspaceId = workspaceId;
      }
    },

    noteWriter(docName: string, actor: LiveActor, section: string | null) {
      writers.set(
        docName,
        new Map(writers.get(docName)).set(actor.id, {
          name: actor.name,
          kind: actor.kind,
          section,
        })
      );
      schedule(docName);
    },

    clearWriter(docName: string, actorId: string) {
      const current = writers.get(docName);
      if (current?.delete(actorId) && current.size === 0) {
        writers.delete(docName);
      }
      schedule(docName);
    },

    noteEdit(docName: string, actor: LiveActor) {
      stateOf(docName).lastEditor = {
        actor,
        editedAt: new Date().toISOString(),
      };
      schedule(docName);
    },

    async refreshPending(docName: string, workspaceId: string) {
      const pending = await persistence.pendingSuggestions(workspaceId, [
        docName,
      ]);
      const state = stateOf(docName);
      state.workspaceId = workspaceId;
      state.pending = pending.get(docName) ?? [];
      schedule(docName);
    },

    watch(watchDoc: string, docNames: string[]) {
      for (const docName of docNames) {
        watchersByDoc.set(
          docName,
          new Set([...(watchersByDoc.get(docName) ?? []), watchDoc])
        );
      }
    },

    unwatch(watchDoc: string, docNames: string[]) {
      for (const docName of docNames) {
        const watchers = watchersByDoc.get(docName);
        watchers?.delete(watchDoc);
        if (watchers?.size === 0) {
          watchersByDoc.delete(docName);
        }
      }
    },

    forget(docName: string) {
      if (!watchersByDoc.has(docName)) {
        docs.delete(docName);
      }
    },
  };
}

export type LiveActivity = ReturnType<typeof createActivity>;
