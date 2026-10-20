import type { DecisionRecord } from "@memo-air/decide";
import type { LiveActor } from "@memo-air/protocol";
import { systemActor } from "@memo-air/protocol";
import type { Pool } from "pg";
import type { Logger } from "pino";
import * as Y from "yjs";

const schemaSql = `
CREATE TABLE IF NOT EXISTS live_doc_updates (id bigserial PRIMARY KEY, doc_name text NOT NULL, update bytea NOT NULL, actor jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS live_doc_updates_doc ON live_doc_updates (doc_name, id);
CREATE TABLE IF NOT EXISTS live_doc_snapshots (doc_name text PRIMARY KEY, state bytea NOT NULL, upto_id bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS live_events (id bigserial PRIMARY KEY, doc_name text NOT NULL, type text NOT NULL, actor jsonb NOT NULL, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS live_events_doc ON live_events (doc_name, id);
CREATE TABLE IF NOT EXISTS live_suggestions (id text PRIMARY KEY, doc_name text NOT NULL, workspace_id text NOT NULL, approver_id text, approver_name text, actor jsonb NOT NULL, insert_block_ids text[] NOT NULL, delete_block_ids text[] NOT NULL, status text NOT NULL DEFAULT 'pending', settled_by jsonb, created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz);
CREATE INDEX IF NOT EXISTS live_suggestions_doc ON live_suggestions (doc_name) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS live_browser_frames (id bigserial PRIMARY KEY, doc_name text NOT NULL, url text NOT NULL, actor jsonb NOT NULL, jpeg bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS live_browser_frames_doc ON live_browser_frames (doc_name, id);
CREATE TABLE IF NOT EXISTS live_decisions (id bigserial PRIMARY KEY, doc_name text, workspace_id text, point text NOT NULL, state_hash text NOT NULL, questions jsonb NOT NULL, answers jsonb, provider text NOT NULL, ms integer NOT NULL, error text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS live_decisions_doc ON live_decisions (doc_name, id);
`;

const historySql = `
WITH ordered AS (
  SELECT id, actor, created_at,
    CASE WHEN lag(actor->>'id') OVER w IS DISTINCT FROM actor->>'id'
           OR created_at - lag(created_at) OVER w > make_interval(secs => $3)
         THEN 1 ELSE 0 END AS starts_session
  FROM live_doc_updates WHERE doc_name = $1 WINDOW w AS (ORDER BY id)
), sessions AS (
  SELECT *, sum(starts_session) OVER (ORDER BY id) AS session FROM ordered
)
SELECT max(id)::text AS upto_id, (array_agg(actor ORDER BY id))[1] AS actor,
  min(created_at) AS started_at, max(created_at) AS ended_at, count(*)::int AS updates
FROM sessions GROUP BY session ORDER BY session DESC LIMIT $2`;

const historyEventTypes = [
  "agent_ops",
  "browser_navigate",
  "restore",
  "suggestion_accepted",
  "suggestion_rejected",
  "comment",
];

export type HistorySession = {
  uptoId: string;
  actor: LiveActor;
  startedAt: string;
  endedAt: string;
  updates: number;
};

export type HistoryEvent = {
  type: string;
  actor: LiveActor;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type PendingSuggestionRow = {
  id: string;
  approverId: string | null;
  approverName: string | null;
  actor: LiveActor;
  insertBlockIds: string[];
  deleteBlockIds: string[];
  createdAt: string;
};

export type SuggestionInDoc = {
  id: string;
  actor: LiveActor;
  approverId: string | null;
  approverName: string | null;
  insertBlockIds: string[];
  deleteBlockIds: string[];
};

export type SettledSuggestion = {
  id: string;
  status: "accepted" | "rejected";
};

export type SettledRow = Pick<
  PendingSuggestionRow,
  "id" | "insertBlockIds" | "deleteBlockIds"
>;

export function settledStatus(
  row: SettledRow,
  presentBlockIds: ReadonlySet<string>
): SettledSuggestion["status"] {
  const survives = (ids: string[]) => ids.some((id) => presentBlockIds.has(id));
  if (row.insertBlockIds.length > 0) {
    return survives(row.insertBlockIds) ? "accepted" : "rejected";
  }
  return survives(row.deleteBlockIds) ? "rejected" : "accepted";
}

type QueuedUpdate = { docName: string; update: Uint8Array; actor: LiveActor };

const maxInsertRows = 5000;
const backlogAlarm = 50_000;
const maxFramesPerDoc = 500;

export type LivePersistence = ReturnType<typeof createPersistence>;

export function createPersistence({
  pool,
  logger,
  flushIntervalMs = 500,
  flushBatchSize = 200,
  compactThreshold = 500,
}: {
  pool: Pool;
  logger: Logger;
  flushIntervalMs?: number;
  flushBatchSize?: number;
  compactThreshold?: number;
}) {
  let queue: QueuedUpdate[] = [];
  // Flushes and compactions share one chain so a compaction never reads max(id) while a lower id
  // is still uncommitted.
  let writes: Promise<void> = Promise.resolve();

  const serialize = (task: () => Promise<void>): Promise<void> => {
    writes = writes.then(task, task);
    return writes;
  };

  // Postgres takes at most 65,535 bind parameters per statement, three per row here; a backlog
  // that grew past that during a burst must still drain, so it goes in slices.
  const writeQueued = async () => {
    while (queue.length > 0) {
      const batch = queue.slice(0, maxInsertRows);
      queue = queue.slice(maxInsertRows);
      const values = batch
        .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
        .join(", ");
      try {
        await pool.query(
          `INSERT INTO live_doc_updates (doc_name, update, actor) VALUES ${values}`,
          batch.flatMap((item) => [
            item.docName,
            Buffer.from(item.update),
            JSON.stringify(item.actor),
          ])
        );
      } catch (err) {
        // ponytail: retries forever in memory while Postgres is down; the alarm in `append` is
        // the only bound. Upgrade path: a Redis stream as write-ahead buffer.
        queue = [...batch, ...queue];
        logger.error({ err, count: batch.length }, "live: update flush failed");
        return;
      }
    }
  };

  const flush = () => serialize(writeQueued);

  const stateAt = async (
    docName: string,
    uptoId: string | null
  ): Promise<Uint8Array | null> => {
    const snapshot = await pool.query<{ state: Buffer; upto_id: string }>(
      "SELECT state, upto_id FROM live_doc_snapshots WHERE doc_name = $1 AND ($2::bigint IS NULL OR upto_id <= $2::bigint)",
      [docName, uptoId]
    );
    const tail = await pool.query<{ update: Buffer }>(
      "SELECT update FROM live_doc_updates WHERE doc_name = $1 AND id > $2 AND ($3::bigint IS NULL OR id <= $3::bigint) ORDER BY id",
      [docName, snapshot.rows[0]?.upto_id ?? "0", uptoId]
    );
    const parts = [
      ...snapshot.rows.map((row) => row.state),
      ...tail.rows.map((row) => row.update),
    ];
    return parts.length === 0 ? null : Y.mergeUpdates(parts);
  };

  // ponytail: in-process queue; a node crash loses ≤500 ms that connected clients resend on
  // reconnect. Upgrade path: a Redis stream as write-ahead buffer.
  const timer = setInterval(() => {
    void flush();
  }, flushIntervalMs);

  return {
    async init() {
      await pool.query(schemaSql);
    },

    async load(docName: string): Promise<Uint8Array | null> {
      await flush();
      return stateAt(docName, null);
    },

    // ponytail: a version older than the snapshot replays from the first row; upgrade by keeping
    // every compaction snapshot and replaying from the nearest one.
    stateAt: async (docName: string, uptoId: string) => {
      await flush();
      return stateAt(docName, uptoId);
    },

    async history(
      docName: string,
      { limit = 100, sessionGapSeconds = 120 } = {}
    ): Promise<{ sessions: HistorySession[]; events: HistoryEvent[] }> {
      await flush();
      const sessions = await pool.query<{
        upto_id: string;
        actor: LiveActor;
        started_at: Date;
        ended_at: Date;
        updates: number;
      }>(historySql, [docName, limit, sessionGapSeconds]);
      const events = await pool.query<{
        type: string;
        actor: LiveActor;
        payload: Record<string, unknown>;
        created_at: Date;
      }>(
        "SELECT type, actor, payload, created_at FROM live_events WHERE doc_name = $1 AND type = ANY($2) ORDER BY id DESC LIMIT $3",
        [docName, historyEventTypes, limit]
      );
      return {
        sessions: sessions.rows.map((row) => ({
          uptoId: row.upto_id,
          actor: row.actor,
          startedAt: row.started_at.toISOString(),
          endedAt: row.ended_at.toISOString(),
          updates: row.updates,
        })),
        events: events.rows.map((row) => ({
          type: row.type,
          actor: row.actor,
          payload: row.payload,
          createdAt: row.created_at.toISOString(),
        })),
      };
    },

    async reconcileSuggestions(
      docName: string,
      workspaceId: string,
      inDoc: SuggestionInDoc[],
      statusOf: (row: SettledRow) => SettledSuggestion["status"],
      settledBy: LiveActor
    ): Promise<SettledSuggestion[]> {
      const pending = await pool.query<{
        id: string;
        insert_block_ids: string[];
        delete_block_ids: string[];
      }>(
        "SELECT id, insert_block_ids, delete_block_ids FROM live_suggestions WHERE doc_name = $1 AND status = 'pending'",
        [docName]
      );
      const known = new Set(pending.rows.map((row) => row.id));
      const stillPending = new Set(inDoc.map((suggestion) => suggestion.id));
      // A suggestion back in the doc after a restore reopens its settled row.
      for (const suggestion of inDoc.filter((s) => !known.has(s.id))) {
        await pool.query(
          `INSERT INTO live_suggestions (id, doc_name, workspace_id, approver_id, approver_name, actor, insert_block_ids, delete_block_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET status = 'pending', settled_by = NULL, settled_at = NULL`,
          [
            suggestion.id,
            docName,
            workspaceId,
            suggestion.approverId,
            suggestion.approverName,
            JSON.stringify(suggestion.actor),
            suggestion.insertBlockIds,
            suggestion.deleteBlockIds,
          ]
        );
      }
      const settled = pending.rows
        .filter((row) => !stillPending.has(row.id))
        .map((row) => ({
          id: row.id,
          status: statusOf({
            id: row.id,
            insertBlockIds: row.insert_block_ids,
            deleteBlockIds: row.delete_block_ids,
          }),
        }));
      for (const { id, status } of settled) {
        await pool.query(
          "UPDATE live_suggestions SET status = $2, settled_by = $3, settled_at = now() WHERE id = $1",
          [id, status, JSON.stringify(settledBy)]
        );
      }
      return settled;
    },

    async pendingSuggestions(
      workspaceId: string,
      docNames: string[]
    ): Promise<Map<string, PendingSuggestionRow[]>> {
      const rows = await pool.query<{
        id: string;
        doc_name: string;
        approver_id: string | null;
        approver_name: string | null;
        actor: LiveActor;
        insert_block_ids: string[];
        delete_block_ids: string[];
        created_at: Date;
      }>(
        "SELECT * FROM live_suggestions WHERE workspace_id = $1 AND doc_name = ANY($2) AND status = 'pending' ORDER BY created_at",
        [workspaceId, docNames]
      );
      const byDoc = new Map<string, PendingSuggestionRow[]>();
      for (const row of rows.rows) {
        byDoc.set(row.doc_name, [
          ...(byDoc.get(row.doc_name) ?? []),
          {
            id: row.id,
            approverId: row.approver_id,
            approverName: row.approver_name,
            actor: row.actor,
            insertBlockIds: row.insert_block_ids,
            deleteBlockIds: row.delete_block_ids,
            createdAt: row.created_at.toISOString(),
          },
        ]);
      }
      return byDoc;
    },

    async lastSeen(
      docNames: string[],
      viewerId: string
    ): Promise<Map<string, string>> {
      const rows = await pool.query<{ doc_name: string; seen_at: Date }>(
        "SELECT doc_name, max(created_at) AS seen_at FROM live_events WHERE doc_name = ANY($1) AND type = 'join' AND actor->>'id' = $2 GROUP BY doc_name",
        [docNames, viewerId]
      );
      return new Map(
        rows.rows.map((row) => [row.doc_name, row.seen_at.toISOString()])
      );
    },

    async lastEditors(
      docNames: string[]
    ): Promise<Map<string, { actor: LiveActor; editedAt: string }>> {
      const rows = await pool.query<{
        doc_name: string;
        actor: LiveActor;
        created_at: Date;
      }>(
        // The server's own bookkeeping (a desktop starting or stopping) is not someone's edit.
        "SELECT DISTINCT ON (doc_name) doc_name, actor, created_at FROM live_doc_updates WHERE doc_name = ANY($1) AND actor->>'id' <> $2 ORDER BY doc_name, id DESC",
        [docNames, systemActor.id]
      );
      return new Map(
        rows.rows.map((row) => [
          row.doc_name,
          { actor: row.actor, editedAt: row.created_at.toISOString() },
        ])
      );
    },

    append(docName: string, update: Uint8Array, actor: LiveActor) {
      queue.push({ docName, update, actor });
      if (queue.length === backlogAlarm) {
        logger.warn(
          { count: queue.length },
          "live: update backlog is growing faster than Postgres takes it"
        );
      }
      if (queue.length >= flushBatchSize) {
        void flush();
      }
    },

    flush,

    compactIfNeeded(docName: string, ydoc: Y.Doc): Promise<void> {
      return serialize(async () => {
        await writeQueued();
        // The log is kept for history and replay; the snapshot only shortens cold loads.
        // ponytail: the log grows forever; archive rows below the oldest kept version once a doc
        // passes ~1M rows.
        const tail = await pool.query<{ count: string; max_id: string | null }>(
          `SELECT count(*) AS count, max(id) AS max_id FROM live_doc_updates
           WHERE doc_name = $1 AND id > COALESCE((SELECT upto_id FROM live_doc_snapshots WHERE doc_name = $1), 0)`,
          [docName]
        );
        const { count, max_id: maxId } = tail.rows[0];
        if (maxId === null || Number(count) <= compactThreshold) {
          return;
        }
        try {
          await pool.query(
            `INSERT INTO live_doc_snapshots (doc_name, state, upto_id, updated_at) VALUES ($1, $2, $3, now())
             ON CONFLICT (doc_name) DO UPDATE SET state = EXCLUDED.state, upto_id = EXCLUDED.upto_id, updated_at = now()`,
            [docName, Buffer.from(Y.encodeStateAsUpdate(ydoc)), maxId]
          );
        } catch (err) {
          logger.error({ err, docName }, "live: compaction failed");
        }
      });
    },

    // History keyframes: one per navigation and one per 10 s while the page changes, the newest
    // maxFramesPerDoc kept. Live pixels go over the LiveKit video track, not through here.
    async appendFrame(
      docName: string,
      url: string,
      actor: LiveActor,
      jpeg: Buffer
    ) {
      await pool.query(
        "INSERT INTO live_browser_frames (doc_name, url, actor, jpeg) VALUES ($1, $2, $3, $4)",
        [docName, url, JSON.stringify(actor), jpeg]
      );
      await pool.query(
        "DELETE FROM live_browser_frames WHERE doc_name = $1 AND id NOT IN (SELECT id FROM live_browser_frames WHERE doc_name = $1 ORDER BY id DESC LIMIT $2)",
        [docName, maxFramesPerDoc]
      );
    },

    async listFrames(
      docName: string,
      limit = 200
    ): Promise<
      { id: string; url: string; actor: LiveActor; createdAt: string }[]
    > {
      const rows = await pool.query<{
        id: string;
        url: string;
        actor: LiveActor;
        created_at: Date;
      }>(
        "SELECT id::text, url, actor, created_at FROM live_browser_frames WHERE doc_name = $1 ORDER BY live_browser_frames.id DESC LIMIT $2",
        [docName, limit]
      );
      return rows.rows.map((row) => ({
        id: row.id,
        url: row.url,
        actor: row.actor,
        createdAt: row.created_at.toISOString(),
      }));
    },

    async frame(docName: string, id: string): Promise<Buffer | null> {
      const rows = await pool.query<{ jpeg: Buffer }>(
        "SELECT jpeg FROM live_browser_frames WHERE doc_name = $1 AND id = $2",
        [docName, id]
      );
      return rows.rows[0]?.jpeg ?? null;
    },

    async logEvent(
      docName: string,
      type: string,
      actor: LiveActor,
      payload: Record<string, unknown> = {}
    ) {
      await pool.query(
        "INSERT INTO live_events (doc_name, type, actor, payload) VALUES ($1, $2, $3, $4)",
        [docName, type, JSON.stringify(actor), JSON.stringify(payload)]
      );
    },

    async recordDecision(
      record: DecisionRecord & { docName?: string; workspaceId?: string }
    ) {
      await pool.query(
        "INSERT INTO live_decisions (doc_name, workspace_id, point, state_hash, questions, answers, provider, ms, error) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [
          record.docName ?? null,
          record.workspaceId ?? null,
          record.point,
          record.stateHash,
          JSON.stringify(record.questions),
          record.answers ? JSON.stringify(record.answers) : null,
          record.provider,
          record.ms,
          record.error ?? null,
        ]
      );
    },

    async listDecisions(docName: string, limit = 50) {
      const rows = await pool.query<{
        point: string;
        answers: Record<string, unknown> | null;
        provider: string;
        ms: number;
        created_at: Date;
      }>(
        "SELECT point, answers, provider, ms, created_at FROM live_decisions WHERE doc_name = $1 ORDER BY id DESC LIMIT $2",
        [docName, limit]
      );
      return rows.rows.map((row) => ({
        point: row.point,
        answers: row.answers,
        provider: row.provider,
        ms: row.ms,
        createdAt: row.created_at.toISOString(),
      }));
    },

    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}
