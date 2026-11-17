import { describe, expect, it } from "vitest";
import type { IrisConfig } from "../src/config.ts";
import { claudeCommand, codexCommand } from "../src/drivers/headless.ts";
import type { Scenario } from "../src/scenarios.ts";

const config: IrisConfig = { repo: "/r", sandbox: "/i/sandbox", claudeConfigDir: "/i/claude-config", codexHome: "/i/codex-home", codexUserHome: "/i/codex-user-home", runsDir: "/r/data/iris" };
const shellEnv = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-test", OPENAI_API_KEY: "sk-test" };
const scenario = (extra: Partial<Scenario> = {}): Scenario => ({ id: "x", harness: "claude", about: "", steps: [], expect: {}, ...extra });

describe("claudeCommand", () => {
  it("points Claude Code at the gateway with the Iris login, and keeps account extras out", () => {
    const c = claudeCommand(scenario({ allowedTools: ["Read", "Bash(node:*)"] }), { prompt: "hi" }, "http://127.0.0.1:9", config, shellEnv);
    expect(c.args).toEqual(["-p", "hi", "--model", "claude-sonnet-5-5", "--strict-mcp-config", "--disable-slash-commands", "--allowedTools", "Read,Bash(node:*)"]);
    expect(c.env).toMatchObject({ ANTHROPIC_BASE_URL: "http://127.0.0.1:9/claude", CLAUDE_CONFIG_DIR: "/i/claude-config", DISABLE_AUTOUPDATER: "1" });
  });

  it("continues the session and keeps slash commands when the scenario needs /compact", () => {
    const c = claudeCommand(scenario({ slashCommands: true }), { prompt: "/compact", continue: true }, "http://g", config, shellEnv);
    expect(c.args).toEqual(["-p", "/compact", "--continue", "--model", "claude-sonnet-5-5", "--strict-mcp-config"]);
  });

  it("passes the scenario's effort level", () => {
    const c = claudeCommand(scenario({ effort: "high" }), { prompt: "hi" }, "http://g", config, shellEnv);
    expect(c.args).toContain("--effort");
    expect(c.args[c.args.indexOf("--effort") + 1]).toBe("high");
  });

  it("never passes an API key, so the subscription login is used", () => {
    const c = claudeCommand(scenario(), { prompt: "hi" }, "http://g", config, shellEnv);
    expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(c.env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("codexCommand", () => {
  it("uses a custom provider pointed at the gateway, with the Iris login", () => {
    const c = codexCommand(scenario({ harness: "codex" }), { prompt: "hi" }, "http://127.0.0.1:9", config, shellEnv);
    expect(c.args[0]).toBe("exec");
    expect(c.args).toContain('model_providers.seeit.base_url="http://127.0.0.1:9/codex"');
    expect(c.args.at(-1)).toBe("hi");
    // A lightweight model, to save quota.
    expect(c.args).toContain('model="gpt-6-luna"');
    // Its own empty HOME keeps the user's ~/.agents/skills out of the requests.
    expect(c.env).toMatchObject({ CODEX_HOME: "/i/codex-home", HOME: "/i/codex-user-home" });
    expect(c.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("trusts the sandbox and its hook only in hook scenarios", () => {
    const plain = codexCommand(scenario({ harness: "codex" }), { prompt: "hi" }, "http://g", config, shellEnv);
    expect(plain.args).not.toContain("--trust");
    const hook = codexCommand(scenario({ harness: "codex", hook: true }), { prompt: "hi", continue: true }, "http://g", config, shellEnv);
    expect(hook.args.slice(0, 5)).toEqual(["exec", "resume", "--last", "--trust", "--dangerously-bypass-hook-trust"]);
  });

  it("can keep the built-in provider and only change its base URL", () => {
    const c = codexCommand(scenario({ harness: "codex", codexBuiltinProvider: true }), { prompt: "hi" }, "http://127.0.0.1:9", config, shellEnv);
    expect(c.args).toContain('openai_base_url="http://127.0.0.1:9/codex"');
    expect(c.args).not.toContain("model_provider=seeit");
  });

  it("resumes the last session and passes the scenario's config overrides", () => {
    const c = codexCommand(scenario({ harness: "codex", codexConfig: ['web_search="live"'] }), { prompt: "continue", continue: true }, "http://g", config, shellEnv);
    expect(c.args.slice(0, 3)).toEqual(["exec", "resume", "--last"]);
    expect(c.args).toContain('web_search="live"');
  });
});
