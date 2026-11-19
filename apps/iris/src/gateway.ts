// Starts the real gateway entry point (apps/gateway/src/index.ts) as its own
// process, the same way a user runs it. Iris treats it as a black box: it
// only sets environment variables and talks HTTP to it.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import type { Harness } from "@seeit/core";

export type RunningGateway = {
  /** For example http://127.0.0.1:53990; a harness uses `${url}/${harness}`. */
  url: string;
  stop(): Promise<void>;
};

export async function startGateway(options: {
  repo: string;
  dataDir: string;
  upstreams: Record<Harness, string>;
  /** The ledger service the gateway sends its calls to. */
  ledger: { url: string; writeToken: string };
  logFile: string;
}): Promise<RunningGateway> {
  const gatewayDir = join(options.repo, "apps/gateway");
  const child = spawn(join(gatewayDir, "node_modules/.bin/tsx"), ["src/index.ts"], {
    cwd: gatewayDir,
    env: {
      ...process.env,
      SEEIT_PORT: "0", // any free port; the gateway prints the one it got
      SEEIT_LEDGER_URL: options.ledger.url,
      SEEIT_LEDGER_WRITE_TOKEN: options.ledger.writeToken,
      SEEIT_RECORD_DIR: join(options.dataDir, "recordings"),
      SEEIT_CLAUDE_UPSTREAM: options.upstreams.claude,
      SEEIT_CODEX_UPSTREAM: options.upstreams.codex,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = createWriteStream(options.logFile);
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway did not start within 30 s; see " + options.logFile)), 30_000);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      // index.ts prints "seeit gateway on http://127.0.0.1:<port>" when ready.
      const match = output.match(/seeit gateway on (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gateway exited with code ${code}; see ${options.logFile}`));
    });
  });

  return {
    url,
    async stop() {
      child.kill("SIGTERM");
      await exited;
      log.end();
    },
  };
}
