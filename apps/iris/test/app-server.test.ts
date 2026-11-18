import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAppServerSteps } from "../src/drivers/app-server.ts";

const FAKE = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

async function run(env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "iris-app-server-"));
  const logFile = join(dir, "app-server.log");
  const steps = [{ prompt: "first" }, { prompt: "/compact", compact: true }, { prompt: "second" }];
  const results = await runAppServerSteps({ file: "node", args: [FAKE], env: { ...process.env, ...env } }, steps, dir, logFile, 5000);
  const sent = (await readFile(logFile, "utf8"))
    .split("\n")
    .filter((l) => l.startsWith("> "))
    .map((l) => JSON.parse(l.slice(2)));
  return { results, sent };
}

describe("runAppServerSteps", () => {
  it("starts a thread, runs each prompt as a turn, and compacts the thread for a compact step", async () => {
    const { results, sent } = await run();
    expect(results.map((r) => [r.prompt, r.exitCode])).toEqual([
      ["first", 0],
      ["(compact the thread)", 0],
      ["second", 0],
    ]);
    const methods = sent.filter((m) => m.method).map((m) => m.method);
    expect(methods).toEqual(["initialize", "initialized", "thread/start", "turn/start", "thread/compact/start", "turn/start"]);
    expect(sent.find((m) => m.method === "thread/compact/start").params).toEqual({ threadId: "thread-1" });
    expect(sent.find((m) => m.method === "turn/start").params).toEqual({ threadId: "thread-1", input: [{ type: "text", text: "first" }] });
  });

  it("answers server requests (approvals) with an error, so a scenario never waits on them", async () => {
    const { sent } = await run();
    const answers = sent.filter((m) => m.id >= 900);
    expect(answers).toHaveLength(3);
    expect(answers.every((m) => m.error && !m.result)).toBe(true);
  });

  it("stops at the first step that does not complete", async () => {
    const { results } = await run({ FAKE_FAIL_TURN: "2" });
    expect(results.map((r) => r.exitCode)).toEqual([0, 1]);
  });
});
