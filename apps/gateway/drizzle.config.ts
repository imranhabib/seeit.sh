import { defineConfig } from "drizzle-kit";

// `pnpm db:generate` writes a new SQL migration to ./drizzle after a schema change.
// The gateway applies pending migrations itself at startup.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
