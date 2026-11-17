import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { LedgerDatabase } from "./db/database.ts";

export function createApp(database: LedgerDatabase) {
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
  return app;
}
