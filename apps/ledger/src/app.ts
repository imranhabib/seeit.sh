import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { LedgerDatabase } from "./db/database.ts";
import { MAX_RECORDING_BYTES, createIngest } from "./ingest.ts";

export function createApp(database: LedgerDatabase, options: { writeToken: string }) {
  const app = new Hono();
  app.get("/health", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      await database.db.execute(sql`select 1`);
      return c.json({ status: "ready" });
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
  });
  app.post(
    "/ingest/calls",
    bodyLimit({ maxSize: MAX_RECORDING_BYTES, onError: (c) => c.json({ error: "recording too large" }, 413) }),
    createIngest(database, options.writeToken),
  );
  return app;
}
