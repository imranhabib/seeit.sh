import { describe, expect, it } from "vitest";
import type { IrisConfig } from "../src/config.ts";
import { claudeCommand, codexAppServerCommand, codexCommand, codexPluginCommands } from "../src/drivers/headless.ts";
import type { Scenario } from "../src/scenarios.ts";

const config: IrisConfig = { repo: "/r", sandbox: "/i/sandbox", claudeConfigDir: "/i/claude-config", codexHome: "/i/codex-home", codexUserHome: "/i/codex-user-home", runsDir: "/r/data/iris", fixtures: "/r/apps/iris/fixtures" };
const shellEnv = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-test", OPENAI_API_KEY: "sk-test" };
const scenario = (extra: Partial<Scenario> = {}): Scenario => ({ id: "x", harness: "claude", about: "", steps: [], expect: {}, ...extra });

describe("claudeCommand", () => {
  it("points Claude Code at the gateway with the Iris login, and keeps account extras out", () => {
    const c = claudeCommand(scenario({ allowedTools: ["Read", "Bash(node:*)"] }), { prompt: "hi" }, "http://127.0.0.1:9", config, shellEnv);
    expect(c.args).toEqual(["-p", "hi", "--model", "claude-sonnet-5-5", "--strict-mcp-config", "--disable-slash-commands", "--allowedTools", "Read,Bash(node:*)"]);
    expect(c.env).toMatchObject({ ANTHROPIC_BASE_URL: "http://127.0.0.1:9/claude", CLAUDE_CONFIG_DIR: "/i/claude-config", DISABLE_AUTOUPDATER: "1" });
    // Prompt ID, request class, and compaction headers (ADR 0008, 0009).
    expect(c.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS).toBe("1");
  });

  it("continues the session and keeps slash commands when the scenario needs /compact, without account-synced skills and plugins", () => {
    const c = claudeCommand(scenario({ slashCommands: true }), { prompt: "/compact", continue: true }, "http://g", config, shellEnv);
    expect(c.args).toEqual(["-p", "/compact", "--continue", "--model", "claude-sonnet-5-5", "--strict-mcp-config", "--settings", '{"syncClaudeAiSkills":false,"syncClaudeAiPlugins":false}']);
  });

  it("passes the Iris MCP server and the Iris plugin", () => {
    const c = claudeCommand(scenario({ mcp: true, plugin: true }), { prompt: "hi" }, "http://g", config, shellEnv);
    const mcp = JSON.parse(c.args[c.args.indexOf("--mcp-config") + 1]!);
    expect(mcp).toEqual({ mcpServers: { iris: { command: "node", args: ["/r/apps/iris/fixtures/mcp-server.mjs"] } } });
    expect(c.args[c.args.indexOf("--plugin-dir") + 1]).toBe("/r/apps/iris/fixtures/claude-plugin");
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

  it("adds the Iris MCP server and lets it run without asking", () => {
    const c = codexCommand(scenario({ harness: "codex", mcp: true }), { prompt: "hi" }, "http://g", config, shellEnv);
    expect(c.args).toContain('mcp_servers.iris.command="node"');
    expect(c.args).toContain('mcp_servers.iris.args=["/r/apps/iris/fixtures/mcp-server.mjs"]');
    expect(c.args).toContain('mcp_servers.iris.default_tools_approval_mode="approve"');
  });
});

describe("codexAppServerCommand", () => {
  it("starts the app server with the same provider, model, and login as codex exec", () => {
    const c = codexAppServerCommand(scenario({ harness: "codex" }), "http://127.0.0.1:9", config, shellEnv);
    expect(c.file).toBe("codex");
    expect(c.args[0]).toBe("app-server");
    expect(c.args).toContain('model_providers.seeit.base_url="http://127.0.0.1:9/codex"');
    expect(c.args).toContain('model="gpt-6-luna"');
    expect(c.env).toMatchObject({ CODEX_HOME: "/i/codex-home", HOME: "/i/codex-user-home" });
    expect(c.env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("codexPluginCommands", () => {
  it("installs the Iris plugin from its local marketplace, and removes both again", () => {
    const { install, remove } = codexPluginCommands(config, shellEnv);
    expect(install.map((c) => c.args)).toEqual([
      ["plugin", "marketplace", "add", "/r/apps/iris/fixtures/codex-marketplace"],
      ["plugin", "add", "iris-plugin@iris"],
    ]);
    expect(remove.map((c) => c.args)).toEqual([
      ["plugin", "remove", "iris-plugin@iris"],
      ["plugin", "marketplace", "remove", "iris"],
    ]);
    // Only in Iris's own CODEX_HOME, never the user's.
    expect(install[0]!.env).toMatchObject({ CODEX_HOME: "/i/codex-home" });
  });
});
