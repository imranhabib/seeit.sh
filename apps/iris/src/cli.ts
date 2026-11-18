// Iris: records harness sessions through the real gateway.
//
//   pnpm iris run [--only <id>]... [--harness claude|codex]
//
// For each scenario: reset the sandbox, run the steps against a gateway whose
// upstream is the chaos proxy, collect the calls the gateway recorded, and
// check them against the scenario's expectations (check.ts). Exits with
// code 1 when a scenario fails. Output goes to data/iris/<run>/ (git-ignored).
// Iris never commits anything.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Harness } from "@seeit/core";
import { startChaosProxy, type ChaosProxy, type Observed } from "./chaos-proxy.ts";
import { checkScenario } from "./check.ts";
import { loadIrisConfig, type IrisConfig } from "./config.ts";
import { runAppServerSteps } from "./drivers/app-server.ts";
import { claudeCommand, codexAppServerCommand, codexCommand, codexPluginCommands, startCommand, type Command, type RunningCommand } from "./drivers/headless.ts";
import { startGateway, type RunningGateway } from "./gateway.ts";
import { waitForCalls, type CallRecord } from "./results.ts";
import { resetSandbox } from "./sandbox.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";

const PROVIDERS: Record<Harness, string> = {
  claude: "https://api.anthropic.com",
  codex: "https://chatgpt.com/backend-api/codex",
};

// Text to look for in request bodies. "leak-*" needles must never be found:
// they would mean the user's own setup reached a request (see check.ts).
// The others are fixed phrases from the Iris hook, skill, plugin, and MCP
// server: found in a request, they prove the feature's output reached the model.
const NEEDLES: Record<string, string | RegExp> = {
  "hook-note": "Project note: this sandbox uses 2-space indentation.",
  "skill-note": "Iris skill note: the answer is 47.",
  "plugin-note": "Iris plugin note: the answer is 83.",
  "mcp-echo": "Iris MCP echo:",
  // The user's own skills folder (the sandbox's .agents/skills is Iris's).
  "leak-home-skills": join(homedir(), ".agents", "skills"),
  // Any MCP tool except the Iris server's own.
  "leak-mcp-tools": /"name":"mcp__(?!iris__)/,
};

type ScenarioResult = {
  id: string;
  harness: Harness;
  about: string;
  startedAt: string;
  endedAt: string;
  steps: { prompt: string; exitCode: number | null; durationMs: number; log: string }[];
  /** What the chaos proxy saw, one entry per call. */
  observed: Observed[];
  faultHappened: boolean;
  callIds: string[];
  /** Empty when the scenario passed. */
  problems: string[];
};

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { only: { type: "string", multiple: true }, harness: { type: "string" } },
  });
  if (positionals[0] !== "run") {
    console.error("usage: pnpm iris run [--only <scenario-id>]... [--harness claude|codex]");
    process.exit(2);
  }

  const config = loadIrisConfig();
  const scenarios = SCENARIOS.filter(
    (s) => (!values.only || values.only.includes(s.id)) && (!values.harness || s.harness === values.harness),
  );
  if (scenarios.length === 0) throw new Error("no scenarios match the filters");
  checkPrerequisites(config, scenarios);

  const versions = {
    claude: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
    codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
  };
  const runDir = join(config.runsDir, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(join(runDir, "logs"), { recursive: true });
  console.log(`iris: ${scenarios.length} scenario(s); ${versions.claude}; ${versions.codex}`);
  console.log(`iris: run folder ${runDir}`);

  // An Iris plugin left in CODEX_HOME by an interrupted run would reach
  // every Codex request, so remove it first.
  if (scenarios.some((s) => s.harness === "codex")) await runQuietly(codexPluginCommands(config, process.env).remove, config.sandbox, join(runDir, "logs", "plugin-cleanup.log"));

  const proxy = await startChaosProxy(PROVIDERS, NEEDLES);
  const gateway = await startGateway({
    repo: config.repo,
    dataDir: runDir,
    upstreams: { claude: `${proxy.url}/claude`, codex: `${proxy.url}/codex` },
    logFile: join(runDir, "logs", "gateway.log"),
  });

  const results: ScenarioResult[] = [];
  const calls: CallRecord[] = [];
  try {
    for (const scenario of scenarios) {
      const { result, rows } = await runScenario(scenario, config, gateway, proxy, runDir);
      results.push(result);
      calls.push(...rows);
      printSummary(result, rows);
    }
  } finally {
    await gateway.stop();
    await proxy.close();
    await writeFile(join(runDir, "manifest.json"), JSON.stringify({ versions, scenarios: results }, null, 2) + "\n");
    await writeFile(join(runDir, "calls.json"), JSON.stringify(calls, null, 2) + "\n");
  }
  const failed = results.filter((r) => r.problems.length > 0);
  console.log(`\niris: ${results.length - failed.length}/${results.length} scenarios passed; manifest and calls in ${runDir}`);
  if (failed.length) {
    console.log(`iris: FAILED: ${failed.map((r) => r.id).join(", ")}`);
    process.exitCode = 1;
  }
}

async function runScenario(
  scenario: Scenario,
  config: IrisConfig,
  gateway: RunningGateway,
  proxy: ChaosProxy,
  runDir: string,
): Promise<{ result: ScenarioResult; rows: CallRecord[] }> {
  const result: ScenarioResult = {
    id: scenario.id,
    harness: scenario.harness,
    about: scenario.about,
    startedAt: new Date().toISOString(),
    endedAt: "",
    steps: [],
    observed: [],
    faultHappened: false,
    callIds: [],
    problems: [],
  };
  let started = 0;
  let running: RunningCommand | null = null;
  const fault = scenario.fault;
  const stopListening = proxy.onEvent((e) => {
    if (e.call.harness !== scenario.harness) return;
    if (e.type === "start") started++;
    if (e.type === "end" || e.type === "cut") result.observed.push(e.call);
    if (e.type === "cut") result.faultHappened = true;
    if (e.type === "threshold" && fault?.action === "interrupt") {
      result.faultHappened = true;
      running?.interrupt();
    }
  });

  let error: string | null = null;
  const plugin = scenario.plugin && scenario.harness === "codex" ? codexPluginCommands(config, process.env) : null;
  const pluginLog = join(runDir, "logs", `${scenario.id}-plugin.log`);
  // The manifest keeps the start of each prompt only (some are long filler).
  const short = (prompt: string) => (prompt.length > 200 ? `${prompt.slice(0, 200)}...` : prompt);
  try {
    await resetSandbox(config.sandbox, { hook: scenario.hook, skill: scenario.skill });
    if (plugin && !(await runQuietly(plugin.install, config.sandbox, pluginLog))) throw new Error(`plugin install failed; see ${pluginLog}`);
    if (fault) proxy.armNextTurn(scenario.harness, { afterTextDeltas: fault.afterTextDeltas, cut: fault.action === "cut" });
    if (scenario.driver === "app-server") {
      const log = join(runDir, "logs", `${scenario.id}.log`);
      const command = codexAppServerCommand(scenario, gateway.url, config, process.env);
      for (const r of await runAppServerSteps(command, scenario.steps, config.sandbox, log)) result.steps.push({ ...r, prompt: short(r.prompt), log });
    } else {
      for (const [i, step] of scenario.steps.entries()) {
        const build = scenario.harness === "claude" ? claudeCommand : codexCommand;
        const command = build(scenario, step, gateway.url, config, process.env);
        const log = join(runDir, "logs", `${scenario.id}-${i + 1}.log`);
        running = startCommand(command, config.sandbox, log);
        const { exitCode, durationMs } = await running.done;
        result.steps.push({ prompt: short(step.prompt), exitCode, durationMs, log });
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    if (plugin) await runQuietly(plugin.remove, config.sandbox, pluginLog);
  }

  // The gateway writes each row in the background after its response ends.
  const rows = await waitForCalls(gateway.dbPath, result.startedAt, started);
  stopListening();
  result.endedAt = new Date().toISOString();
  result.callIds = rows.map((r) => r.id);
  result.problems = checkScenario(scenario, { exitCodes: result.steps.map((s) => s.exitCode), rows, observed: result.observed, faultHappened: result.faultHappened });
  if (error) result.problems.unshift(`iris error: ${error}`);
  return { result, rows };
}

/** Run setup commands one after another; true when all succeeded. Output goes to `logFile`. */
async function runQuietly(commands: Command[], cwd: string, logFile: string): Promise<boolean> {
  let ok = true;
  for (const [i, command] of commands.entries()) {
    const { exitCode } = await startCommand(command, cwd, `${logFile}.${i + 1}`).done;
    if (exitCode !== 0) ok = false;
  }
  return ok;
}

function checkPrerequisites(config: IrisConfig, scenarios: Scenario[]) {
  const problems: string[] = [];
  const needs = new Set(scenarios.map((s) => s.harness));
  if (needs.has("claude") && !existsSync(config.claudeConfigDir)) problems.push(`no Claude Code login folder at ${config.claudeConfigDir}`);
  if (needs.has("codex") && !existsSync(join(config.codexHome, "auth.json"))) problems.push(`no Codex login at ${config.codexHome}`);
  for (const bin of needs) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
    } catch {
      problems.push(`${bin} is not on PATH`);
    }
  }
  if (problems.length) throw new Error("cannot run:\n  " + problems.join("\n  "));
}

/** One short block per scenario: pass or fail, and what happened in ledger terms. */
function printSummary(r: ScenarioResult, rows: CallRecord[]) {
  const count = (values: (string | null)[]) =>
    Object.entries(values.reduce<Record<string, number>>((acc, v) => ((acc[v ?? "-"] = (acc[v ?? "-"] ?? 0) + 1), acc), {}))
      .map(([k, n]) => `${k}×${n}`)
      .join(" ");
  const turns = new Set(rows.map((row) => row.turn_id).filter(Boolean)).size;
  console.log(`\n${r.problems.length ? "✗" : "✓"} ${r.id} (${r.about})`);
  console.log(`  calls=${rows.length}  turns=${turns}  kinds: ${count(rows.map((row) => row.kind))}  completion: ${count(rows.map((row) => row.completion))}`);
  for (const problem of r.problems) console.log(`  ✗ ${problem}`);
}

main().catch((err) => {
  console.error(`iris: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
