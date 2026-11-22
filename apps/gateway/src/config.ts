import { fileURLToPath } from "node:url";

// <repo>/data/..., independent of the directory the process starts in.
const DATA_DIR = fileURLToPath(new URL("../../../data", import.meta.url));

export type Config = {
  host: string;
  port: number;
  recordDir: string;
  /** seeit's own user for every recorded call (ADR 0009). No sign-in yet: the ledger trusts it. */
  userId: string;
  /** Path prefix (harness name) -> upstream base URL. */
  upstreams: Record<string, string>;
  /**
   * The ledger service (ADR 0007), which analyzes and stores every call.
   * Without both, the gateway only forwards traffic and records nothing.
   */
  ledgerUrl?: string;
  ledgerWriteToken?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.SEEIT_HOST ?? "127.0.0.1",
    port: Number(env.SEEIT_PORT ?? 8787),
    recordDir: env.SEEIT_RECORD_DIR ?? `${DATA_DIR}/recordings`,
    userId: env.SEEIT_USER_ID || "local",
    upstreams: {
      claude: env.SEEIT_CLAUDE_UPSTREAM ?? "https://api.anthropic.com",
      codex: env.SEEIT_CODEX_UPSTREAM ?? "https://chatgpt.com/backend-api/codex",
    },
    ledgerUrl: env.SEEIT_LEDGER_URL,
    ledgerWriteToken: env.SEEIT_LEDGER_WRITE_TOKEN,
  };
}
