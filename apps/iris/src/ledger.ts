// Starts the real ledger service (apps/ledger/src/index.ts) as its own
// process for an Iris run, on Iris's own PostgreSQL database. Like the
// gateway, Iris treats it as a black box: environment variables and HTTP.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Pool } from "pg";

export type RunningLedger = {
  /** For example http://127.0.0.1:53990. */
  url: string;
  stop(): Promise<void>;
};

/** Create the database in the URL if it does not exist (connects to the server's "postgres" database). */
export async function ensureDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  try {
    const found = await admin.query("select 1 from pg_database where datname = $1", [name]);
    // A name cannot be a query parameter; quote it as an identifier.
    if (found.rowCount === 0) await admin.query(`create database "${name.replaceAll('"', '""')}"`);
  } finally {
    await admin.end();
  }
}

export async function startLedger(options: { repo: string; databaseUrl: string; writeToken: string; logFile: string }): Promise<RunningLedger> {
  const ledgerDir = join(options.repo, "apps/ledger");
  // The ledger accepts ports 1-65535 only (no "0"), so pick a free one first.
  const port = await freePort();
  const child = spawn(join(ledgerDir, "node_modules/.bin/tsx"), ["src/index.ts"], {
    cwd: ledgerDir,
    env: { ...process.env, SEEIT_LEDGER_DATABASE_URL: options.databaseUrl, SEEIT_LEDGER_PORT: String(port), SEEIT_LEDGER_WRITE_TOKEN: options.writeToken },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = createWriteStream(options.logFile);
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ledger did not start within 30 s; see " + options.logFile)), 30_000);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      // index.ts prints "seeit ledger on http://127.0.0.1:<port>" once migrations ran.
      const match = output.match(/seeit ledger on (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`ledger exited with code ${code}; see ${options.logFile}`));
    });
  });

  return {
    url,
    async stop() {
      child.kill("SIGTERM");
      await exited;
      log.end();
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
