import { fileURLToPath } from "node:url";

// <repo>/data/recordings, independent of the directory the process starts in.
const DEFAULT_RECORD_DIR = fileURLToPath(new URL("../../../data/recordings", import.meta.url));

export type Config = {
  host: string;
  port: number;
  recordDir: string;
  /** Path prefix (harness name) -> upstream base URL. */
  upstreams: Record<string, string>;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.SEEIT_HOST ?? "127.0.0.1",
    port: Number(env.SEEIT_PORT ?? 8787),
    recordDir: env.SEEIT_RECORD_DIR ?? DEFAULT_RECORD_DIR,
    upstreams: {
      claude: env.SEEIT_CLAUDE_UPSTREAM ?? "https://api.anthropic.com",
      codex: env.SEEIT_CODEX_UPSTREAM ?? "https://chatgpt.com/backend-api/codex",
    },
  };
}
