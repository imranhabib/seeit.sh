import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Configuration is checked before the database opens, so these tests need no
// PostgreSQL server: the URL below is never used.
function start(env: Record<string, string>) {
  const { SEEIT_LEDGER_DATABASE_URL: _url, SEEIT_LEDGER_PORT: _port, SEEIT_LEDGER_WRITE_TOKEN: _token, ...rest } = process.env;
  return promisify(execFile)(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...rest, ...env },
    timeout: 4000,
  });
}

describe("ledger configuration", () => {
  it("names the missing database URL", async () => {
    await expect(start({})).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("SEEIT_LEDGER_DATABASE_URL is required"),
    });
  });

  it.each(["", "invalid", "0", "65536", "8788abc"])("rejects port %j", async (port) => {
    const url = "postgresql://127.0.0.1:1/unused";
    await expect(start({ SEEIT_LEDGER_DATABASE_URL: url, SEEIT_LEDGER_PORT: port, SEEIT_LEDGER_WRITE_TOKEN: "t" })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("SEEIT_LEDGER_PORT must be an integer from 1 to 65535"),
    });
  });

  it("names the missing write token", async () => {
    await expect(start({ SEEIT_LEDGER_DATABASE_URL: "postgresql://127.0.0.1:1/unused" })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("SEEIT_LEDGER_WRITE_TOKEN is required"),
    });
  });
});
