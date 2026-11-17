import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db/database.ts";

async function main() {
  const connectionString = process.env.SEEIT_LEDGER_DATABASE_URL;
  if (!connectionString) throw new Error("SEEIT_LEDGER_DATABASE_URL is required");
  const database = await openDatabase(connectionString);
  let server: ReturnType<typeof serve>;
  try {
    server = serve({
      fetch: createApp(database).fetch,
      hostname: process.env.SEEIT_LEDGER_HOST ?? "127.0.0.1",
      port: Number(process.env.SEEIT_LEDGER_PORT ?? 8788),
    }, (info) => console.log(`seeit ledger on http://${info.address}:${info.port}`));
  } catch (err) {
    await database.close();
    throw err;
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      void database.close().catch(() => {
        console.error("[ledger] database shutdown failed");
        process.exitCode = 1;
      });
    });
  };
  server.on("error", () => {
    console.error("[ledger] HTTP server failed");
    process.exitCode = 1;
    stop();
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void main().catch(() => {
  console.error("[ledger] startup failed; check database configuration and migrations");
  process.exitCode = 1;
});
