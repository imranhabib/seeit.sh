// The dummy repository the harnesses work in.
//
// Iris resets it before every scenario so each one starts from the same
// files. The folder itself is kept (only its contents are replaced), so
// Claude Code's "trust this folder" answer survives between runs.
//
// Safety: Iris deletes everything inside this folder. It only does that when
// the folder is empty or holds the MARKER file Iris created, so a wrong path
// can never wipe a real folder.

import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const MARKER = ".iris-sandbox";

const FILES: Record<string, string> = {
  [MARKER]: "Created by Iris (seeit.sh). Everything in this folder is reset before each scenario.\n",
  "README.md": "# Sandbox\n\nA tiny demo project.\n",
  "src/math.js": "// TODO: handle negative numbers\nexport function add(a, b) { return a + b; }\nexport function multiply(a, b) { return a * b; }\n",
  "src/strings.js": 'export function shout(s) { return s.toUpperCase() + "!"; }\n// TODO: trim whitespace first\nexport function words(s) { return s.split(" "); }\n',
  "src/dates.js": "export function isWeekend(d) { const day = d.getDay(); return day === 0 || day === 6; }\n",
};

/**
 * A UserPromptSubmit hook: its output is added to every prompt as context.
 * Claude Code reads it from .claude/settings.json, Codex from .codex/hooks.json
 * (same format; codex-rs/hooks/src/engine/discovery.rs).
 */
const HOOK_SETTINGS = {
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo 'Project note: this sandbox uses 2-space indentation.'" }] }],
  },
};

export async function resetSandbox(dir: string, options: { hook?: boolean } = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  if (entries.length > 0 && !entries.includes(MARKER)) {
    throw new Error(`refusing to clear ${dir}: it is not empty and has no ${MARKER} file`);
  }
  for (const entry of entries) await rm(join(dir, entry), { recursive: true, force: true });

  const files = { ...FILES };
  if (options.hook) {
    files[".claude/settings.json"] = JSON.stringify(HOOK_SETTINGS, null, 2) + "\n";
    files[".codex/hooks.json"] = JSON.stringify(HOOK_SETTINGS, null, 2) + "\n";
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }

  // A generic identity, and no signing or hooks from the user's global git
  // config, so the git status block the harness sends holds nothing personal.
  const git = (...args: string[]) => run("git", ["-C", dir, ...args]);
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Sandbox User");
  await git("config", "user.email", "sandbox@example.com");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.hooksPath", "/dev/null");
  await git("add", "-A");
  await git("commit", "-q", "-m", "Initial sandbox");
}
