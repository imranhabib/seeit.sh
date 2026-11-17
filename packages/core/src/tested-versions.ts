// Harness versions that have a recorded fixture in packages/core/fixtures.
//
// A call from any other version was parsed by code never checked against
// that version's format, so the gateway flags the first such call (ADR 0005,
// layer 3). Keys are the full harness version exactly as stored in the
// ledger (product/version from the user-agent): the same version number from
// a different client (codex_exec vs Codex Desktop) can send a different format.
//
// tested-versions.test.ts fails if this list and the fixture folder disagree.
// When you add a fixture, add its version here.

// Readonly: code that imports the list cannot change it (checked at compile time).
export const FIXTURE_FOR_VERSION: Readonly<Record<string, string>> = {
  "claude-cli/2.1.322": "anthropic-claude-2.1.322.sse",
  "codex_exec/0.153.4": "openai-codex-0.153.4.sse",
  "Codex Desktop/0.169.0-alpha.11.1": "openai-codex-desktop-0.169.0.sse",
};

export function hasFixture(harnessVersion: string): boolean {
  return Object.hasOwn(FIXTURE_FOR_VERSION, harnessVersion);
}
