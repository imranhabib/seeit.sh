import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolConfig } from "pg";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
export type LedgerDatabase = Awaited<ReturnType<typeof openDatabase>>;

function createPool(config: PoolConfig) {
  const pool = new Pool({ connectionTimeoutMillis: 5000, ...config });
  // Idle connections emit errors outside a query's promise. Never log the
  // exception: connection errors can contain database addresses or credentials.
  pool.on("error", () => console.error("[ledger] idle database connection failed"));
  return pool;
}

export async function openDatabase(connectionString: string) {
  // Migrations use their own connection with no query timeout: a migration on
  // a large table can take longer than any request should.
  const migrationPool = createPool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(migrationPool), { migrationsFolder: MIGRATIONS });
  } finally {
    // Ignore a close failure so it cannot replace the migration error.
    await migrationPool.end().catch(() => {});
  }

  const pool = createPool({ connectionString, query_timeout: 10000 });
  return { db: drizzle(pool), close: () => pool.end() };
}
