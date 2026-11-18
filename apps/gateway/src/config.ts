import { fileURLToPath } from "node:url";

// <repo>/data/..., independent of the directory the process starts in.
const DATA_DIR = fileURLToPath(new URL("../../../data", import.meta.url));

export type Config = {
  host: string;
  port: number;
  recordDir: string;
  /** SQLite ledger file. */
  dbPath: string;
  /** Path prefix (harness name) -> upstream base URL. */
  upstreams: Record<string, string>;
  /**
   * The ledger service (ADR 0007). Calls are sent there only when both are
   * set; until the cutover the SQLite ledger is written either way.
   */
  ledgerUrl?: string;
  ledgerWriteToken?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.SEEIT_HOST ?? "127.0.0.1",
    port: Number(env.SEEIT_PORT ?? 8787),
    recordDir: env.SEEIT_RECORD_DIR ?? `${DATA_DIR}/recordings`,
    dbPath: env.SEEIT_DB ?? `${DATA_DIR}/seeit.db`,
    upstreams: {
      claude: env.SEEIT_CLAUDE_UPSTREAM ?? "https://api.anthropic.com",
      codex: env.SEEIT_CODEX_UPSTREAM ?? "https://chatgpt.com/backend-api/codex",
    },
    ledgerUrl: env.SEEIT_LEDGER_URL,
    ledgerWriteToken: env.SEEIT_LEDGER_WRITE_TOKEN,
  };
}
