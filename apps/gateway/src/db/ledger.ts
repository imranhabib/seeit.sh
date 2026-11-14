import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import Database from "better-sqlite3";
import { lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { bodies, calls, type CallRow } from "./schema.ts";

const gzipAsync = promisify(gzip);
const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
const BODY_RETENTION_DAYS = 14;

export type Ledger = ReturnType<typeof openLedger>;

export function openLedger(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  // WAL lets the dashboard read while the gateway writes.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS });

  return {
    db,

    /** Store one call and its bodies. Called after the response, never on the hot path. */
    async record(call: CallRow, body: { request: string | null; response: string | null }) {
      // gzip runs on libuv's thread pool, so a 400 KB request body does not
      // block the event loop that streams other responses.
      const [requestGz, responseGz] = await Promise.all([
        body.request ? gzipAsync(body.request) : null,
        body.response ? gzipAsync(body.response) : null,
      ]);
      db.transaction((tx) => {
        tx.insert(calls).values(call).run();
        tx.insert(bodies).values({ callId: call.id, createdAt: call.startedAt, requestGz, responseGz }).run();
      });
    },

    /** Delete bodies older than the retention period. Call rows are kept. */
    pruneBodies(now = new Date()) {
      const cutoff = new Date(now.getTime() - BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      return db.delete(bodies).where(lt(bodies.createdAt, cutoff)).run().changes;
    },

    close() {
      sqlite.close();
    },
  };
}
