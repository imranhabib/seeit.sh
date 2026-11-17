// Runs one scenario step with a harness in non-interactive mode
// (claude -p / codex exec), pointed at the gateway.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { IrisConfig } from "../config.ts";
import type { Scenario, Step } from "../scenarios.ts";

export type Command = { file: string; args: string[]; env: NodeJS.ProcessEnv };

// Scenarios test the gateway and the harness's request format, not the
// model's answers, so they use lightweight models to save quota. Subagents
// and the harness's own side calls may still pick other models.
export const MODELS = { claude: "claude-sonnet-5-5", codex: "gpt-6-luna" } as const;

/**
 * Claude Code. --strict-mcp-config and --disable-slash-commands keep out the
 * MCP servers and skills Claude Code syncs from the account, so requests do
 * not change when the account's extras change.
 */
export function claudeCommand(scenario: Scenario, step: Step, gatewayUrl: string, config: IrisConfig, baseEnv: NodeJS.ProcessEnv): Command {
  const args = ["-p", step.prompt];
  if (step.continue) args.push("--continue");
  args.push("--model", MODELS.claude);
  if (scenario.effort) args.push("--effort", scenario.effort);
  args.push("--strict-mcp-config");
  if (!scenario.slashCommands) args.push("--disable-slash-commands");
  if (scenario.allowedTools?.length) args.push("--allowedTools", scenario.allowedTools.join(","));
  return {
    file: "claude",
    args,
    env: harnessEnv(baseEnv, {
      ANTHROPIC_BASE_URL: `${gatewayUrl}/claude`,
      CLAUDE_CONFIG_DIR: config.claudeConfigDir,
      DISABLE_AUTOUPDATER: "1", // stay on one version for the whole run
      ...scenario.env,
    }),
  };
}

/** Codex, with a custom provider that points at the gateway (as in the README). */
export function codexCommand(scenario: Scenario, step: Step, gatewayUrl: string, config: IrisConfig, baseEnv: NodeJS.ProcessEnv): Command {
  const provider = [
    ...(scenario.codexBuiltinProvider
      ? [`openai_base_url="${gatewayUrl}/codex"`]
      : [
          "model_provider=seeit",
          'model_providers.seeit.name="seeit"',
          `model_providers.seeit.base_url="${gatewayUrl}/codex"`,
          'model_providers.seeit.wire_api="responses"',
          "model_providers.seeit.requires_openai_auth=true",
        ]),
    // Let the tool loop write test files; set as config because `exec resume` has no -s flag.
    'sandbox_mode="workspace-write"',
    `model="${MODELS.codex}"`,
    ...(scenario.codexConfig ?? []),
  ];
  const args = ["exec"];
  if (step.continue) args.push("resume", "--last");
  // Codex only runs a project's hooks in a trusted project with trusted
  // hooks. --trust saves the trust in Iris's own CODEX_HOME; Iris writes the
  // hook itself, so skipping the hook-trust prompt is safe here.
  if (scenario.hook) args.push("--trust", "--dangerously-bypass-hook-trust");
  for (const c of provider) args.push("-c", c);
  args.push(step.prompt);
  return {
    file: "codex",
    args,
    // An empty HOME keeps skills in the user's ~/.agents/skills out of the
    // requests; the login is a file in CODEX_HOME (see config.ts).
    env: harnessEnv(baseEnv, { CODEX_HOME: config.codexHome, HOME: config.codexUserHome, ...scenario.env }),
  };
}

// API keys would switch a harness from the subscription login to API
// billing, so they are removed from the harness environment.
function harnessEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...base, ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

export type RunningCommand = {
  done: Promise<{ exitCode: number | null; durationMs: number }>;
  /** Like the user pressing Ctrl+C in the harness's terminal. */
  interrupt(): void;
};

/** Start a command in the sandbox; write its output to `logFile`. Kills it after `timeoutMs`. */
export function startCommand(command: Command, cwd: string, logFile: string, timeoutMs = 10 * 60_000): RunningCommand {
  const start = performance.now();
  const log = createWriteStream(logFile);
  const child = spawn(command.file, command.args, { cwd, env: command.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  const done = new Promise<{ exitCode: number | null; durationMs: number }>((resolve) => {
    child.once("error", (err) => log.write(`\n[iris] failed to start: ${err.message}\n`));
    child.once("close", (code) => {
      clearTimeout(timer);
      log.end();
      resolve({ exitCode: code, durationMs: Math.round(performance.now() - start) });
    });
  });
  return { done, interrupt: () => void child.kill("SIGINT") };
}
