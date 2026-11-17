import { spawnSync } from "node:child_process";

if (!process.env.SEEIT_TEST_DATABASE_URL) {
  console.error("Set SEEIT_TEST_DATABASE_URL to a dedicated PostgreSQL test database.");
  process.exit(1);
}
const result = spawnSync("pnpm", ["exec", "vitest", "run", "src/db/postgres.test.ts"], { stdio: "inherit" });
process.exit(result.status ?? 1);
