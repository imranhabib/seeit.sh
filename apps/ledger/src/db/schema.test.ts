// Until the cutover in ADR 0007 there are two ledger schemas: the gateway
// still writes SQLite (apps/gateway/src/db/schema.ts), the ledger service
// uses PostgreSQL (schema.ts here). The ledger must keep every field the
// gateway records, so a column added on one side only fails here.

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as sqlite from "../../../gateway/src/db/schema.ts";
import * as postgres from "./schema.ts";

const columnNames = (table: Parameters<typeof getTableColumns>[0]) =>
  Object.values(getTableColumns(table))
    .map((c) => c.name)
    .sort();

describe("ledger schema matches the gateway's SQLite schema", () => {
  it("has the same call columns", () => {
    expect(columnNames(postgres.calls)).toEqual(columnNames(sqlite.calls));
  });

  it("has the same body columns", () => {
    expect(columnNames(postgres.bodies)).toEqual(columnNames(sqlite.bodies));
  });
});
