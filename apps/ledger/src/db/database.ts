import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
export type LedgerDatabase = Awaited<ReturnType<typeof openDatabase>>;

export async function openDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  // Idle connections emit errors outside a query's promise. Never log the
  // exception: connection errors can contain database addresses or credentials.
  pool.on("error", () => console.error("[ledger] idle database connection failed"));
  const db = drizzle(pool);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS });
  } catch (err) {
    await pool.end();
    throw err;
  }
  return { db, close: () => pool.end() };
}
