import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURE_FOR_VERSION, hasFixture } from "./tested-versions.ts";

describe("tested harness versions", () => {
  // Keeps the list honest: adding or removing a fixture file without
  // updating FIXTURE_FOR_VERSION fails here.
  it("lists exactly the fixture files in packages/core/fixtures", () => {
    const files = readdirSync(new URL("../fixtures/", import.meta.url)).filter((f) => f.endsWith(".sse"));
    expect(Object.values(FIXTURE_FOR_VERSION).sort()).toEqual(files.sort());
  });

  it("matches the full harness version, as stored in the ledger", () => {
    expect(hasFixture("claude-cli/2.1.322")).toBe(true);
    expect(hasFixture("Codex Desktop/0.169.0-alpha.11.1")).toBe(true);
    // Same version number, different client: not covered.
    expect(hasFixture("codex_exec/0.169.0")).toBe(false);
    expect(hasFixture("claude-cli/2.1.311")).toBe(false);
  });
});
