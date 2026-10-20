import type { LiveActor } from "@memo-air/protocol";
import pg from "pg";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createPersistence } from "./persistence.ts";

const databaseUrl = process.env.TEST_LIVE_DATABASE_URI;
const actor: LiveActor = { kind: "human", id: "u1", name: "Ada" };

describe.skipIf(!databaseUrl)("live persistence", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const persistence = createPersistence({
    pool,
    logger: pino({ level: "silent" }),
    compactThreshold: 2,
  });
  const docName = `test:${crypto.randomUUID()}`;

  beforeAll(() => persistence.init());
  afterAll(async () => {
    await persistence.close();
    await pool.end();
  });

  it("reloads appended updates, and still does after compaction, keeping the log", async () => {
    const ydoc = new Y.Doc();
    ydoc.on("update", (update: Uint8Array) =>
      persistence.append(docName, update, actor)
    );
    const text = ydoc.getText("t");
    text.insert(0, "a");
    text.insert(1, "b");
    text.insert(2, "c");
    await persistence.flush();

    const reload = async () => {
      const loaded = new Y.Doc();
      const state = await persistence.load(docName);
      if (state) {
        Y.applyUpdate(loaded, state);
      }
      return loaded.getText("t").toString();
    };

    expect(await reload()).toBe("abc");

    await persistence.compactIfNeeded(docName, ydoc);
    const remaining = await pool.query(
      "SELECT count(*)::int AS n FROM live_doc_updates WHERE doc_name = $1",
      [docName]
    );
    expect(remaining.rows[0].n).toBe(3);
    expect(await reload()).toBe("abc");

    text.insert(3, "d");
    await persistence.flush();
    expect(await reload()).toBe("abcd");
  });

  it("rebuilds the state at any update and groups history by actor", async () => {
    const name = `test:${crypto.randomUUID()}`;
    const ydoc = new Y.Doc();
    let current: LiveActor = actor;
    ydoc.on("update", (update: Uint8Array) =>
      persistence.append(name, update, current)
    );
    const text = ydoc.getText("t");
    text.insert(0, "a");
    text.insert(1, "b");
    await persistence.flush();
    current = { kind: "agent", id: "a1", name: "Juno" };
    text.insert(2, "c");
    await persistence.flush();
    await persistence.compactIfNeeded(name, ydoc);
    text.insert(3, "d");
    await persistence.flush();

    const { sessions } = await persistence.history(name);
    expect(
      sessions.map((session) => [session.actor.name, session.updates])
    ).toEqual([
      ["Juno", 2],
      ["Ada", 2],
    ]);

    const textAt = async (uptoId: string) => {
      const doc = new Y.Doc();
      const state = await persistence.stateAt(name, uptoId);
      if (state) {
        Y.applyUpdate(doc, state);
      }
      return doc.getText("t").toString();
    };
    expect(await textAt(sessions[1].uptoId)).toBe("ab");
    expect(await textAt(sessions[0].uptoId)).toBe("abcd");
  });

  it("drains a backlog larger than one INSERT can carry", async () => {
    const name = `test:${crypto.randomUUID()}`;
    const ydoc = new Y.Doc();
    ydoc.on("update", (update: Uint8Array) =>
      persistence.append(name, update, actor)
    );
    const map = ydoc.getMap<number>("m");
    for (let i = 0; i < 25_000; i++) {
      map.set(String(i), i);
    }
    await persistence.flush();
    const written = await pool.query(
      "SELECT count(*)::int AS n FROM live_doc_updates WHERE doc_name = $1",
      [name]
    );
    expect(written.rows[0].n).toBe(25_000);
    const loaded = new Y.Doc();
    const state = await persistence.load(name);
    if (state) {
      Y.applyUpdate(loaded, state);
    }
    expect(loaded.getMap("m").size).toBe(25_000);
  }, 30_000);

  it("keeps the newest 500 browser frames of a doc and nobody else's", async () => {
    const browserDoc = `test:browser-${crypto.randomUUID()}`;
    const otherDoc = `test:browser-${crypto.randomUUID()}`;
    const jpeg = Buffer.from("not really a jpeg");
    await persistence.appendFrame(otherDoc, "https://a.test", actor, jpeg);
    for (let i = 0; i < 502; i++) {
      await persistence.appendFrame(
        browserDoc,
        `https://a.test/${i}`,
        actor,
        jpeg
      );
    }
    const frames = await persistence.listFrames(browserDoc, 1000);
    expect(frames).toHaveLength(500);
    expect(frames[0].url).toBe("https://a.test/501");
    expect(frames[frames.length - 1].url).toBe("https://a.test/2");
    expect(await persistence.listFrames(otherDoc)).toHaveLength(1);
  });

  it("returns null for an unknown doc", async () => {
    expect(await persistence.load(`test:${crypto.randomUUID()}`)).toBeNull();
  });
});
