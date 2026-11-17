// Where Iris finds its sandbox and the harness logins, and where it writes runs.
//
// By default everything lives in a folder next to this repository,
// `../seeit-iris/`, so no personal paths are written into the repo:
//
//   seeit-iris/sandbox        dummy repo the harnesses work in (reset per scenario)
//   seeit-iris/claude-config  Claude Code config with its own login (CLAUDE_CONFIG_DIR)
//   seeit-iris/codex-home     Codex config with its own login (CODEX_HOME)
//   seeit-iris/codex-user-home  empty HOME for the Codex process (see below)
//
// Codex also loads skills from ~/.agents/skills, outside CODEX_HOME. Giving it
// an empty HOME keeps the user's personal skills (and home paths) out of the
// requests. Claude Code keeps the real HOME: its login is in the macOS
// Keychain, which is found through HOME.
//
// The config folders hold login tokens: never place them inside a git repo.

import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

export type IrisConfig = {
  repo: string;
  sandbox: string;
  claudeConfigDir: string;
  codexHome: string;
  codexUserHome: string;
  /** Run folders: data/iris/<run>/ (git-ignored, like all of data/). */
  runsDir: string;
};

export function loadIrisConfig(env: NodeJS.ProcessEnv = process.env): IrisConfig {
  const home = env.IRIS_HOME ?? join(REPO, "..", "seeit-iris");
  return {
    repo: REPO,
    sandbox: join(home, "sandbox"),
    claudeConfigDir: join(home, "claude-config"),
    codexHome: join(home, "codex-home"),
    codexUserHome: join(home, "codex-user-home"),
    runsDir: join(REPO, "data", "iris"),
  };
}
