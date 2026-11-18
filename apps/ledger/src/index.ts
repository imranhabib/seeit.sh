import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db/database.ts";

// Configuration messages are our own text, so they are safe to print.
// Database errors are not: they can contain the connection URL.
function configError(message: string): never {
  console.error(`[ledger] ${message}`);
  process.exit(1);
}

function readConfig() {
  const connectionString = process.env.SEEIT_LEDGER_DATABASE_URL;
  if (!connectionString) configError("SEEIT_LEDGER_DATABASE_URL is required");
  // Number("") is 0, which makes the server listen on a random port, so
  // accept digits only.
  const portText = process.env.SEEIT_LEDGER_PORT ?? "8788";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    configError("SEEIT_LEDGER_PORT must be an integer from 1 to 65535");
  }
  // The gateway's credential for POST /ingest/calls. Required: the ledger
  // never accepts unauthenticated writes, even on loopback.
  const writeToken = process.env.SEEIT_LEDGER_WRITE_TOKEN;
  if (!writeToken) configError("SEEIT_LEDGER_WRITE_TOKEN is required");
  return { connectionString, port, writeToken, hostname: process.env.SEEIT_LEDGER_HOST ?? "127.0.0.1" };
}

async function main() {
  const { connectionString, port, writeToken, hostname } = readConfig();
  const database = await openDatabase(connectionString);
  let server: ReturnType<typeof serve>;
  try {
    server = serve({ fetch: createApp(database, { writeToken }).fetch, hostname, port }, (info) =>
      console.log(`seeit ledger on http://${info.address}:${info.port}`),
    );
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
