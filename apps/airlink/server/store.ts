import { randomBytes } from "node:crypto";
import type { LiveActor, LiveDocKind } from "@memo-air/protocol";
import type { RunnerLanguage, RunnerStatus } from "@memo-air/runner";
import type pg from "pg";

export type Channel = {
  id: string;
  name: string;
  chatDoc: string;
  spaceDoc: string;
  // Open to everyone in the workspace, people and agents alike; every other channel is by invite.
  open: boolean;
};

export type MemberKind = "human" | "agent";

export type ChannelObject = {
  docName: string;
  channelId: string;
  kind: LiveDocKind;
  title: string;
};

export type ChannelDoc =
  | { role: "chat" | "space"; channel: Channel }
  | { role: "object"; channel: Channel; object: ChannelObject };

export type RunnerRow = {
  docName: string;
  channel: Channel;
  title: string;
  language: RunnerLanguage;
  code: string;
  refreshMinutes: number;
  paused: boolean;
  failures: number;
};

export type RunRecord = {
  status: RunnerStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  files: { name: string; mime: string; bytes: Buffer }[];
};

const liveDocKinds: readonly LiveDocKind[] = [
  "doc",
  "sheet",
  "canvas",
  "slides",
  "browser",
  "desktop",
  "media",
  "space",
  "file",
  "runner",
];

const keptRuns = 100;

const isLiveDocKind = (kind: string): kind is LiveDocKind =>
  liveDocKinds.some((known) => known === kind);

const newId = () => randomBytes(6).toString("base64url").toLowerCase();

const channelFromRow = (row: {
  id: string;
  name: string;
  chat_doc: string;
  space_doc: string;
  is_open: boolean;
}): Channel => ({
  id: row.id,
  name: row.name,
  chatDoc: row.chat_doc,
  spaceDoc: row.space_doc,
  open: row.is_open,
});

const objectFromRow = (row: {
  doc_name: string;
  channel_id: string;
  kind: string;
  title: string;
}): ChannelObject => ({
  docName: row.doc_name,
  channelId: row.channel_id,
  kind: isLiveDocKind(row.kind) ? row.kind : "doc",
  title: row.title,
});

// What the room shares lives in the database live-server already needs: the channels and the
// objects placed in each. The person's own settings stay in files (settings.ts).
export function createStore(pool: pg.Pool) {
  // Returns the channels that predate membership, for the caller to fill from their history.
  const init = async (): Promise<Channel[]> => {
    const { rowCount: hadMembers } = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'airlink_members'"
    );
    // Two AirLinks starting on a fresh database would deadlock creating these linked tables.
    await transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('airlink_init'))"
      );
      await client.query(`
      CREATE TABLE IF NOT EXISTS airlink_channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        chat_doc TEXT NOT NULL UNIQUE,
        space_doc TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS airlink_objects (
        doc_name TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES airlink_channels(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS airlink_objects_channel ON airlink_objects (channel_id);
      CREATE TABLE IF NOT EXISTS airlink_files (
        doc_name TEXT PRIMARY KEY REFERENCES airlink_objects(doc_name) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes BYTEA NOT NULL
      );
      ALTER TABLE airlink_channels ADD COLUMN IF NOT EXISTS is_open BOOLEAN NOT NULL DEFAULT false;
      CREATE TABLE IF NOT EXISTS airlink_members (
        channel_id TEXT NOT NULL REFERENCES airlink_channels(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
        member_id TEXT NOT NULL,
        added_by TEXT NOT NULL,
        added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (channel_id, kind, member_id)
      );
      CREATE TABLE IF NOT EXISTS airlink_join_requests (
        channel_id TEXT NOT NULL REFERENCES airlink_channels(id) ON DELETE CASCADE,
        person_id TEXT NOT NULL,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (channel_id, person_id)
      );
      CREATE TABLE IF NOT EXISTS airlink_people (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS airlink_runners (
        doc_name TEXT PRIMARY KEY REFERENCES airlink_objects(doc_name) ON DELETE CASCADE,
        language TEXT NOT NULL CHECK (language IN ('python', 'node')),
        code TEXT NOT NULL,
        refresh_minutes INTEGER NOT NULL DEFAULT 0 CHECK (refresh_minutes >= 0),
        paused BOOLEAN NOT NULL DEFAULT false,
        failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS airlink_runs (
        id BIGSERIAL PRIMARY KEY,
        doc_name TEXT NOT NULL REFERENCES airlink_objects(doc_name) ON DELETE CASCADE,
        actor JSONB NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ended_at TIMESTAMPTZ,
        status TEXT NOT NULL,
        exit_code INTEGER,
        stdout TEXT NOT NULL DEFAULT '',
        stderr TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS airlink_runs_doc ON airlink_runs (doc_name, id);
      CREATE TABLE IF NOT EXISTS airlink_run_files (
        doc_name TEXT NOT NULL REFERENCES airlink_objects(doc_name) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes BYTEA NOT NULL,
        PRIMARY KEY (doc_name, name)
      );
    `);
    });
    const { rowCount } = await pool.query(
      "SELECT 1 FROM airlink_channels LIMIT 1"
    );
    if (!rowCount) {
      await createChannel("general", "airlink", true);
      return [];
    }
    if (hadMembers) {
      return [];
    }
    await pool.query(
      "UPDATE airlink_channels SET is_open = true WHERE name = 'general'"
    );
    await pool.query(
      `INSERT INTO airlink_members (channel_id, kind, member_id, added_by)
       SELECT id, 'human', created_by, 'airlink' FROM airlink_channels
       WHERE NOT is_open AND created_by <> 'airlink'
       ON CONFLICT DO NOTHING`
    );
    return (await listChannels()).filter((each) => !each.open);
  };

  // A new channel holds only whoever made it; they add the rest.
  const createChannel = async (
    name: string,
    createdBy: string,
    open = false
  ): Promise<Channel | null> => {
    const id = newId();
    const { rows } = await pool.query(
      `INSERT INTO airlink_channels (id, name, chat_doc, space_doc, created_by, is_open)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (name) DO NOTHING
       RETURNING id, name, chat_doc, space_doc, is_open`,
      [id, name, `airlink-${id}-chat`, `airlink-${id}-space`, createdBy, open]
    );
    const created = rows[0] ? channelFromRow(rows[0]) : null;
    if (created && !open) {
      await addMembers(
        created.id,
        [{ kind: "human", id: createdBy }],
        createdBy
      );
    }
    return created;
  };

  const addMembers = async (
    channelId: string,
    members: { kind: MemberKind; id: string }[],
    addedBy: string
  ) => {
    if (members.length === 0) {
      return;
    }
    await pool.query(
      `INSERT INTO airlink_members (channel_id, kind, member_id, added_by)
       SELECT $1, kind, member_id, $4 FROM unnest($2::text[], $3::text[]) AS m(kind, member_id)
       ON CONFLICT DO NOTHING`,
      [
        channelId,
        members.map((member) => member.kind),
        members.map((member) => member.id),
        addedBy,
      ]
    );
    await pool.query(
      "DELETE FROM airlink_join_requests WHERE channel_id = $1 AND person_id = ANY($2::text[])",
      [
        channelId,
        members
          .filter((member) => member.kind === "human")
          .map((member) => member.id),
      ]
    );
  };

  const removeMember = async (
    channelId: string,
    member: { kind: MemberKind; id: string }
  ) => {
    await pool.query(
      "DELETE FROM airlink_members WHERE channel_id = $1 AND kind = $2 AND member_id = $3",
      [channelId, member.kind, member.id]
    );
  };

  const membersOf = async (
    channelId: string
  ): Promise<{ humans: string[]; agents: string[] }> => {
    const { rows } = await pool.query(
      "SELECT kind, member_id FROM airlink_members WHERE channel_id = $1 ORDER BY added_at",
      [channelId]
    );
    return {
      humans: rows
        .filter((row: { kind: string }) => row.kind === "human")
        .map((row: { member_id: string }) => row.member_id),
      agents: rows
        .filter((row: { kind: string }) => row.kind === "agent")
        .map((row: { member_id: string }) => row.member_id),
    };
  };

  const isMember = async (
    channel: Channel,
    member: { kind: MemberKind; id: string }
  ): Promise<boolean> =>
    channel.open ||
    ((
      await pool.query(
        "SELECT 1 FROM airlink_members WHERE channel_id = $1 AND kind = $2 AND member_id = $3",
        [channel.id, member.kind, member.id]
      )
    ).rowCount ?? 0) > 0;

  // The invite-only channels one person is in, and those they have asked to join.
  const standingOf = async (
    personId: string
  ): Promise<{ memberOf: Set<string>; requested: Set<string> }> => {
    const [members, requests] = await Promise.all([
      pool.query(
        "SELECT channel_id FROM airlink_members WHERE kind = 'human' AND member_id = $1",
        [personId]
      ),
      pool.query(
        "SELECT channel_id FROM airlink_join_requests WHERE person_id = $1",
        [personId]
      ),
    ]);
    return {
      memberOf: new Set(
        members.rows.map((row: { channel_id: string }) => row.channel_id)
      ),
      requested: new Set(
        requests.rows.map((row: { channel_id: string }) => row.channel_id)
      ),
    };
  };

  const requestToJoin = async (channelId: string, personId: string) => {
    await pool.query(
      "INSERT INTO airlink_join_requests (channel_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [channelId, personId]
    );
  };

  const dropJoinRequest = async (channelId: string, personId: string) => {
    await pool.query(
      "DELETE FROM airlink_join_requests WHERE channel_id = $1 AND person_id = $2",
      [channelId, personId]
    );
  };

  const joinRequests = async (
    channelId: string
  ): Promise<{ personId: string; requestedAtMs: number }[]> =>
    (
      await pool.query(
        "SELECT person_id, requested_at FROM airlink_join_requests WHERE channel_id = $1 ORDER BY requested_at",
        [channelId]
      )
    ).rows.map((row: { person_id: string; requested_at: Date }) => ({
      personId: row.person_id,
      requestedAtMs: row.requested_at.getTime(),
    }));

  // There are no accounts, so the workspace's people are whoever has joined: recorded when they
  // give a name and each time they come back, under their latest name.
  const seePerson = async (person: { id: string; name: string }) => {
    await pool.query(
      `INSERT INTO airlink_people (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, seen_at = now()`,
      [person.id, person.name]
    );
  };

  // People found in a channel's history: added if new, and their name and last-seen moved
  // forward only when the history is newer than what is on record.
  const rememberPeople = async (
    people: { id: string; name: string; seenAtMs: number }[]
  ) => {
    for (const member of people) {
      await pool.query(
        `INSERT INTO airlink_people (id, name, seen_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))
         ON CONFLICT (id) DO UPDATE SET
           name = CASE WHEN EXCLUDED.seen_at > airlink_people.seen_at THEN EXCLUDED.name ELSE airlink_people.name END,
           seen_at = GREATEST(airlink_people.seen_at, EXCLUDED.seen_at)`,
        [member.id, member.name, member.seenAtMs]
      );
    }
  };

  const listPeople = async (): Promise<
    { id: string; name: string; seenAtMs: number }[]
  > =>
    (
      await pool.query(
        "SELECT id, name, seen_at FROM airlink_people ORDER BY seen_at DESC"
      )
    ).rows.map((row: { id: string; name: string; seen_at: Date }) => ({
      id: row.id,
      name: row.name,
      seenAtMs: row.seen_at.getTime(),
    }));

  const listChannels = async (): Promise<Channel[]> =>
    (
      await pool.query(
        "SELECT id, name, chat_doc, space_doc, is_open FROM airlink_channels ORDER BY created_at"
      )
    ).rows.map(channelFromRow);

  const channel = async (id: string): Promise<Channel | null> => {
    const { rows } = await pool.query(
      "SELECT id, name, chat_doc, space_doc, is_open FROM airlink_channels WHERE id = $1",
      [id]
    );
    return rows[0] ? channelFromRow(rows[0]) : null;
  };

  const objects = async (channelId: string): Promise<ChannelObject[]> =>
    (
      await pool.query(
        "SELECT doc_name, channel_id, kind, title FROM airlink_objects WHERE channel_id = $1 ORDER BY created_at",
        [channelId]
      )
    ).rows.map(objectFromRow);

  // Emptying the bin: the object leaves its channel for good. Its edit history stays in
  // live-server's log, unreachable once no channel names the doc.
  // ponytail: the log rows are kept; prune them when deleted docs add up.
  const deleteObject = async (
    channelId: string,
    docName: string
  ): Promise<boolean> =>
    ((
      await pool.query(
        "DELETE FROM airlink_objects WHERE channel_id = $1 AND doc_name = $2",
        [channelId, docName]
      )
    ).rowCount ?? 0) > 0;

  const allObjects = async (): Promise<ChannelObject[]> =>
    (
      await pool.query(
        "SELECT doc_name, channel_id, kind, title FROM airlink_objects ORDER BY created_at"
      )
    ).rows.map(objectFromRow);

  const addObject = async (input: {
    channelId: string;
    kind: LiveDocKind;
    title: string;
    createdBy: string;
  }): Promise<ChannelObject> => {
    const docName = `airlink-${input.channelId}-${input.kind}-${newId()}`;
    await pool.query(
      "INSERT INTO airlink_objects (doc_name, channel_id, kind, title, created_by) VALUES ($1, $2, $3, $4, $5)",
      [docName, input.channelId, input.kind, input.title, input.createdBy]
    );
    return {
      docName,
      channelId: input.channelId,
      kind: input.kind,
      title: input.title,
    };
  };

  // An uploaded file is an object whose bytes sit beside its row, so deleting the object for good
  // takes the bytes with it.
  const addFile = async (input: {
    channelId: string;
    name: string;
    mime: string;
    bytes: Buffer;
    createdBy: string;
  }): Promise<ChannelObject> => {
    const object: ChannelObject = {
      docName: `airlink-${input.channelId}-file-${newId()}`,
      channelId: input.channelId,
      kind: "file",
      title: input.name,
    };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO airlink_objects (doc_name, channel_id, kind, title, created_by) VALUES ($1, $2, 'file', $3, $4)",
        [object.docName, input.channelId, input.name, input.createdBy]
      );
      await client.query(
        "INSERT INTO airlink_files (doc_name, name, mime, bytes) VALUES ($1, $2, $3, $4)",
        [object.docName, input.name, input.mime, input.bytes]
      );
      await client.query("COMMIT");
      return object;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  const fileInfo = async (
    docName: string
  ): Promise<{ name: string; mime: string; sizeBytes: number } | null> => {
    const { rows } = await pool.query(
      "SELECT name, mime, octet_length(bytes) AS size_bytes FROM airlink_files WHERE doc_name = $1",
      [docName]
    );
    return rows[0]
      ? {
          name: rows[0].name,
          mime: rows[0].mime,
          sizeBytes: Number(rows[0].size_bytes),
        }
      : null;
  };

  const fileBytes = async (
    docName: string
  ): Promise<{ name: string; mime: string; bytes: Buffer } | null> => {
    const { rows } = await pool.query(
      "SELECT name, mime, bytes FROM airlink_files WHERE doc_name = $1",
      [docName]
    );
    return rows[0] ?? null;
  };

  // Two agents asking for the same object at once get the one object: the lookup and the insert
  // run under a per-channel lock, which holds across processes since it lives in Postgres.
  const findOrAddObject = async (input: {
    channelId: string;
    kind: LiveDocKind;
    title: string;
    onePerRoom: boolean;
    createdBy: string;
  }): Promise<{ object: ChannelObject; existing: boolean }> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        input.channelId,
      ]);
      const { rows } = await client.query(
        `SELECT doc_name, channel_id, kind, title FROM airlink_objects
         WHERE channel_id = $1 AND kind = $2 AND ($3 OR lower(trim(title)) = lower(trim($4)))
         ORDER BY created_at LIMIT 1`,
        [input.channelId, input.kind, input.onePerRoom, input.title]
      );
      const found = rows[0] ? objectFromRow(rows[0]) : null;
      const docName = `airlink-${input.channelId}-${input.kind}-${newId()}`;
      if (!found) {
        await client.query(
          "INSERT INTO airlink_objects (doc_name, channel_id, kind, title, created_by) VALUES ($1, $2, $3, $4, $5)",
          [docName, input.channelId, input.kind, input.title, input.createdBy]
        );
      }
      await client.query("COMMIT");
      return found
        ? { object: found, existing: true }
        : {
            object: {
              docName,
              channelId: input.channelId,
              kind: input.kind,
              title: input.title,
            },
            existing: false,
          };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  const transaction = async <T>(
    work: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  // The code that runs is this copy, never the doc's: every member can write the doc.
  const addRunner = async (input: {
    channelId: string;
    title: string;
    language: RunnerLanguage;
    code: string;
    createdBy: string;
  }): Promise<ChannelObject> => {
    const object: ChannelObject = {
      docName: `airlink-${input.channelId}-runner-${newId()}`,
      channelId: input.channelId,
      kind: "runner",
      title: input.title,
    };
    await transaction(async (client) => {
      await client.query(
        "INSERT INTO airlink_objects (doc_name, channel_id, kind, title, created_by) VALUES ($1, $2, 'runner', $3, $4)",
        [object.docName, input.channelId, input.title, input.createdBy]
      );
      await client.query(
        "INSERT INTO airlink_runners (doc_name, language, code) VALUES ($1, $2, $3)",
        [object.docName, input.language, input.code]
      );
    });
    return object;
  };

  const updateRunner = async (
    docName: string,
    input: { title: string; language: RunnerLanguage; code: string }
  ) => {
    await transaction(async (client) => {
      await client.query(
        "UPDATE airlink_objects SET title = $2 WHERE doc_name = $1",
        [docName, input.title]
      );
      await client.query(
        "UPDATE airlink_runners SET language = $2, code = $3 WHERE doc_name = $1",
        [docName, input.language, input.code]
      );
    });
  };

  const runner = async (docName: string): Promise<RunnerRow | null> => {
    const { rows } = await pool.query(
      `SELECT r.doc_name, r.language, r.code, r.refresh_minutes, r.paused, r.failures, o.title,
              c.id, c.name, c.chat_doc, c.space_doc, c.is_open
       FROM airlink_runners r
       JOIN airlink_objects o ON o.doc_name = r.doc_name
       JOIN airlink_channels c ON c.id = o.channel_id
       WHERE r.doc_name = $1`,
      [docName]
    );
    const row = rows[0];
    return row
      ? {
          docName: row.doc_name,
          channel: channelFromRow(row),
          title: row.title,
          language: row.language === "node" ? "node" : "python",
          code: row.code,
          refreshMinutes: row.refresh_minutes,
          paused: row.paused,
          failures: row.failures,
        }
      : null;
  };

  const scheduledRunners = async (): Promise<string[]> =>
    (
      await pool.query(
        "SELECT doc_name FROM airlink_runners WHERE refresh_minutes > 0 AND NOT paused"
      )
    ).rows.map((row: { doc_name: string }) => row.doc_name);

  const setRunnerSchedule = async (
    docName: string,
    change: { refreshMinutes?: number; paused?: boolean; failures?: number }
  ) => {
    await pool.query(
      `UPDATE airlink_runners SET
         refresh_minutes = COALESCE($2, refresh_minutes),
         paused = COALESCE($3, paused),
         failures = COALESCE($4, failures)
       WHERE doc_name = $1`,
      [
        docName,
        change.refreshMinutes ?? null,
        change.paused ?? null,
        change.failures ?? null,
      ]
    );
  };

  const addRunnerFailure = async (docName: string): Promise<number> =>
    (
      await pool.query(
        "UPDATE airlink_runners SET failures = failures + 1 WHERE doc_name = $1 RETURNING failures",
        [docName]
      )
    ).rows[0]?.failures ?? 0;

  const startRun = async (docName: string, actor: LiveActor): Promise<number> =>
    Number(
      (
        await pool.query(
          "INSERT INTO airlink_runs (doc_name, actor, status) VALUES ($1, $2, 'running') RETURNING id",
          [docName, JSON.stringify(actor)]
        )
      ).rows[0].id
    );

  // A run's files replace the last run's. False when the runner was deleted while it ran.
  const finishRun = async (
    runId: number,
    docName: string,
    record: RunRecord
  ): Promise<boolean> =>
    transaction(async (client) => {
      const { rowCount } = await client.query(
        "UPDATE airlink_runs SET ended_at = now(), status = $2, exit_code = $3, stdout = $4, stderr = $5 WHERE id = $1",
        [runId, record.status, record.exitCode, record.stdout, record.stderr]
      );
      if (!rowCount) {
        return false;
      }
      await client.query("DELETE FROM airlink_run_files WHERE doc_name = $1", [
        docName,
      ]);
      for (const file of record.files) {
        await client.query(
          "INSERT INTO airlink_run_files (doc_name, name, mime, bytes) VALUES ($1, $2, $3, $4)",
          [docName, file.name, file.mime, file.bytes]
        );
      }
      await client.query(
        `DELETE FROM airlink_runs WHERE doc_name = $1 AND id NOT IN
           (SELECT id FROM airlink_runs WHERE doc_name = $1 ORDER BY id DESC LIMIT $2)`,
        [docName, keptRuns]
      );
      return true;
    });

  const failUnfinishedRuns = async (reason: string): Promise<string[]> => [
    ...new Set(
      (
        await pool.query(
          "UPDATE airlink_runs SET ended_at = now(), status = 'error', stderr = $1 WHERE ended_at IS NULL RETURNING doc_name",
          [reason]
        )
      ).rows.map((row: { doc_name: string }) => row.doc_name)
    ),
  ];

  const runFile = async (
    docName: string,
    name: string
  ): Promise<{ mime: string; bytes: Buffer } | null> =>
    (
      await pool.query(
        "SELECT mime, bytes FROM airlink_run_files WHERE doc_name = $1 AND name = $2",
        [docName, name]
      )
    ).rows[0] ?? null;

  // Only the bytes within the caps leave Postgres; the rest come back by name.
  const channelFiles = async (
    channelId: string,
    caps: { maxFiles: number; maxBytes: number }
  ): Promise<{
    files: { name: string; bytes: Buffer }[];
    skipped: string[];
    media: string[];
  }> => {
    // Newest first, since the upload a person just made is the one they mean; audio and video
    // never go in, and do not count against the caps.
    const { rows } = await pool.query(
      `SELECT name, media, CASE WHEN NOT media AND n <= $2 AND total <= $3 THEN bytes END AS bytes FROM (
         SELECT f.name, f.bytes,
                (f.mime LIKE 'audio/%' OR f.mime LIKE 'video/%') AS media,
                ROW_NUMBER() OVER newest AS n,
                SUM(octet_length(f.bytes)) OVER newest AS total
         FROM airlink_files f
         JOIN airlink_objects o ON o.doc_name = f.doc_name
         WHERE o.channel_id = $1
         WINDOW newest AS (
           PARTITION BY (f.mime LIKE 'audio/%' OR f.mime LIKE 'video/%')
           ORDER BY o.created_at DESC, f.doc_name
         )
       ) ranked ORDER BY media, n`,
      [channelId, caps.maxFiles, caps.maxBytes]
    );
    const picked: { name: string; media: boolean; bytes: Buffer | null }[] =
      rows;
    return {
      files: picked.flatMap((file) =>
        file.bytes ? [{ name: file.name, bytes: file.bytes }] : []
      ),
      skipped: picked.flatMap((file) =>
        file.bytes || file.media ? [] : [file.name]
      ),
      media: picked.flatMap((file) => (file.media ? [file.name] : [])),
    };
  };

  // Every token AirLink mints goes through this: a doc that is not a channel's chat, its space
  // or one of its objects has no token at all.
  const docOf = async (docName: string): Promise<ChannelDoc | null> => {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.chat_doc, c.space_doc, c.is_open,
              o.doc_name, o.channel_id, o.kind, o.title
       FROM airlink_channels c
       LEFT JOIN airlink_objects o ON o.channel_id = c.id AND o.doc_name = $1
       WHERE c.chat_doc = $1 OR c.space_doc = $1 OR o.doc_name = $1
       LIMIT 1`,
      [docName]
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const found = channelFromRow(row);
    if (row.doc_name) {
      return { role: "object", channel: found, object: objectFromRow(row) };
    }
    return {
      role: found.chatDoc === docName ? "chat" : "space",
      channel: found,
    };
  };

  return {
    init,
    seePerson,
    rememberPeople,
    listPeople,
    createChannel,
    addMembers,
    removeMember,
    membersOf,
    isMember,
    standingOf,
    requestToJoin,
    dropJoinRequest,
    joinRequests,
    listChannels,
    channel,
    objects,
    allObjects,
    addObject,
    addFile,
    fileInfo,
    fileBytes,
    deleteObject,
    findOrAddObject,
    docOf,
    addRunner,
    updateRunner,
    runner,
    scheduledRunners,
    setRunnerSchedule,
    addRunnerFailure,
    startRun,
    finishRun,
    failUnfinishedRuns,
    runFile,
    channelFiles,
  };
}

export type Store = ReturnType<typeof createStore>;
