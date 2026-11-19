// Runs one scenario step with a harness in non-interactive mode
// (claude -p / codex exec), pointed at the gateway.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import type { IrisConfig } from "../config.ts";
import type { Scenario, Step } from "../scenarios.ts";

export type Command = { file: string; args: string[]; env: NodeJS.ProcessEnv };

// Scenarios test the gateway and the harness's request format, not the
// model's answers, so they use lightweight models to save quota. Subagents
// and the harness's own side calls may still pick other models.
export const MODELS = { claude: "claude-sonnet-5-5", codex: "gpt-6-luna" } as const;

/** The Iris MCP server (fixtures/mcp-server.mjs), named "iris" in both harnesses. */
const mcpServer = (config: IrisConfig) => ({ command: "node", args: [join(config.fixtures, "mcp-server.mjs")] });

/**
 * Claude Code. --strict-mcp-config and --disable-slash-commands keep out the
 * MCP servers and skills Claude Code syncs from the account, so requests do
 * not change when the account's extras change. A scenario that needs slash
 * commands (skills, plugins, /compact) turns the account's synced skills and
 * plugins off with settings instead.
 */
export function claudeCommand(scenario: Scenario, step: Step, gatewayUrl: string, config: IrisConfig, baseEnv: NodeJS.ProcessEnv): Command {
  const args = ["-p", step.prompt];
  if (step.continue) args.push("--continue");
  args.push("--model", MODELS.claude);
  if (scenario.effort) args.push("--effort", scenario.effort);
  args.push("--strict-mcp-config");
  if (scenario.mcp) args.push("--mcp-config", JSON.stringify({ mcpServers: { iris: mcpServer(config) } }));
  if (scenario.plugin) args.push("--plugin-dir", join(config.fixtures, "claude-plugin"));
  if (!scenario.slashCommands) args.push("--disable-slash-commands");
  if (scenario.slashCommands) args.push("--settings", JSON.stringify({ syncClaudeAiSkills: false, syncClaudeAiPlugins: false }));
  if (scenario.allowedTools?.length) args.push("--allowedTools", scenario.allowedTools.join(","));
  return {
    file: "claude",
    args,
    env: harnessEnv(baseEnv, {
      ANTHROPIC_BASE_URL: `${gatewayUrl}/claude`,
      CLAUDE_CONFIG_DIR: config.claudeConfigDir,
      DISABLE_AUTOUPDATER: "1", // stay on one version for the whole run
      // Prompt ID, request class, and compaction headers. Off by default for
      // a custom base URL (ADR 0008, 0009).
      CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1",
      ...scenario.env,
    }),
  };
}

/** Config overrides shared by codex exec and codex app-server: provider, sandbox, model, MCP. */
function codexOverrides(scenario: Scenario, gatewayUrl: string, config: IrisConfig): string[] {
  const server = mcpServer(config);
  return [
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
    ...(scenario.mcp
      ? [
          `mcp_servers.iris.command=${JSON.stringify(server.command)}`,
          `mcp_servers.iris.args=${JSON.stringify(server.args)}`,
          // Headless runs cannot answer an approval prompt.
          'mcp_servers.iris.default_tools_approval_mode="approve"',
        ]
      : []),
    ...(scenario.codexConfig ?? []),
  ];
}

/** Codex, with a custom provider that points at the gateway (as in the README). */
export function codexCommand(scenario: Scenario, step: Step, gatewayUrl: string, config: IrisConfig, baseEnv: NodeJS.ProcessEnv): Command {
  const args = ["exec"];
  if (step.continue) args.push("resume", "--last");
  // Codex only runs a project's hooks in a trusted project with trusted
  // hooks. --trust saves the trust in Iris's own CODEX_HOME; Iris writes the
  // hook itself, so skipping the hook-trust prompt is safe here.
  if (scenario.hook) args.push("--trust", "--dangerously-bypass-hook-trust");
  for (const c of codexOverrides(scenario, gatewayUrl, config)) args.push("-c", c);
  args.push(step.prompt);
  return { file: "codex", args, env: codexEnv(config, baseEnv, scenario.env) };
}

/**
 * Codex's app server (JSON-RPC over stdio), for what codex exec cannot do,
 * such as a manual compaction (see drivers/app-server.ts).
 */
export function codexAppServerCommand(scenario: Scenario, gatewayUrl: string, config: IrisConfig, baseEnv: NodeJS.ProcessEnv): Command {
  const args = ["app-server"];
  for (const c of codexOverrides(scenario, gatewayUrl, config)) args.push("-c", c);
  return { file: "codex", args, env: codexEnv(config, baseEnv, scenario.env) };
}

/**
 * Install the Iris plugin (fixtures/codex-marketplace) into Iris's own
 * CODEX_HOME, and remove it again. Installed plugins stay in CODEX_HOME, so
 * Iris removes it after the scenario and before every run.
 */
export function codexPluginCommands(config: IrisConfig, baseEnv: NodeJS.ProcessEnv): { install: Command[]; remove: Command[] } {
  const env = codexEnv(config, baseEnv);
  const codex = (...args: string[]): Command => ({ file: "codex", args, env });
  return {
    install: [codex("plugin", "marketplace", "add", join(config.fixtures, "codex-marketplace")), codex("plugin", "add", "iris-plugin@iris")],
    remove: [codex("plugin", "remove", "iris-plugin@iris"), codex("plugin", "marketplace", "remove", "iris")],
  };
}

// An empty HOME keeps skills in the user's ~/.agents/skills out of the
// requests; the login is a file in CODEX_HOME (see config.ts).
function codexEnv(config: IrisConfig, baseEnv: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return harnessEnv(baseEnv, { CODEX_HOME: config.codexHome, HOME: config.codexUserHome, ...extra });
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
