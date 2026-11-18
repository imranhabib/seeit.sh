import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MARKER, resetSandbox } from "../src/sandbox.ts";

const tempDir = () => mkdtemp(join(tmpdir(), "iris-sandbox-"));

describe("resetSandbox", () => {
  it("fills an empty folder with the dummy repo, committed with a generic identity", async () => {
    const dir = await tempDir();
    await resetSandbox(dir);
    expect(existsSync(join(dir, MARKER))).toBe(true);
    expect(await readFile(join(dir, "src/math.js"), "utf8")).toContain("TODO");
    expect(execFileSync("git", ["-C", dir, "log", "--format=%an <%ae> %s"], { encoding: "utf8" }).trim()).toBe(
      "Sandbox User <sandbox@example.com> Initial sandbox",
    );
    expect(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });

  it("removes whatever a previous scenario left behind", async () => {
    const dir = await tempDir();
    await resetSandbox(dir);
    await writeFile(join(dir, "leftover.test.js"), "x");
    await resetSandbox(dir);
    expect(existsSync(join(dir, "leftover.test.js"))).toBe(false);
  });

  it("adds the prompt hook for both harnesses only when asked", async () => {
    const dir = await tempDir();
    await resetSandbox(dir);
    expect(existsSync(join(dir, ".claude/settings.json"))).toBe(false);
    expect(existsSync(join(dir, ".codex/hooks.json"))).toBe(false);
    await resetSandbox(dir, { hook: true });
    expect(await readFile(join(dir, ".claude/settings.json"), "utf8")).toContain("UserPromptSubmit");
    // Codex reads the same format from a project's .codex/hooks.json.
    expect(JSON.parse(await readFile(join(dir, ".codex/hooks.json"), "utf8"))).toEqual(JSON.parse(await readFile(join(dir, ".claude/settings.json"), "utf8")));
  });

  it("adds the Iris skill for both harnesses only when asked", async () => {
    const dir = await tempDir();
    await resetSandbox(dir);
    expect(existsSync(join(dir, ".claude/skills/iris-note/SKILL.md"))).toBe(false);
    await resetSandbox(dir, { skill: true });
    const claude = await readFile(join(dir, ".claude/skills/iris-note/SKILL.md"), "utf8");
    // Codex finds repository skills in .agents/skills (codex-rs/ext/skills/src/host_roots.rs).
    expect(await readFile(join(dir, ".agents/skills/iris-note/SKILL.md"), "utf8")).toBe(claude);
    expect(claude).toMatch(/^---\nname: iris-note\n/);
  });

  it("refuses to clear a folder it did not create", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "important.txt"), "keep me");
    await expect(resetSandbox(dir)).rejects.toThrow(/refusing to clear/);
    expect(await readFile(join(dir, "important.txt"), "utf8")).toBe("keep me");
  });
});
