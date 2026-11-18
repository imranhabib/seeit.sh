// Runs a Codex scenario through `codex app-server`: JSON-RPC 2.0 over stdio,
// one message per line. Iris uses it only for steps `codex exec` cannot do;
// a manual compaction (/compact in the TUI) is `thread/compact/start` here.
//
// Protocol: codex-rs/app-server-protocol/src/protocol/{common.rs,v2/}.
// Flow: initialize -> initialized -> thread/start, then per step either
// turn/start or thread/compact/start, each finished by a turn/completed
// notification.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Step } from "../scenarios.ts";
import type { Command } from "./headless.ts";

export type StepResult = { prompt: string; exitCode: number | null; durationMs: number };

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string } };

export async function runAppServerSteps(command: Command, steps: Step[], cwd: string, logFile: string, stepTimeoutMs = 10 * 60_000): Promise<StepResult[]> {
  const log = createWriteStream(logFile);
  const child = spawn(command.file, command.args, { cwd, env: command.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.pipe(log, { end: false });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));

  let nextId = 1;
  const pending = new Map<number, { resolve: (result: any) => void; reject: (err: Error) => void }>();
  let onNotification: (m: Message) => void = () => {};
  const send = (message: Message) => {
    const line = JSON.stringify({ jsonrpc: "2.0", ...message });
    log.write(`> ${line}\n`);
    child.stdin.write(line + "\n");
  };

  createInterface({ input: child.stdout }).on("line", (line) => {
    log.write(`< ${line}\n`);
    let m: Message;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && m.method) {
      // A request from the server (for example an approval). Iris answers
      // none: scenarios run with approvals off.
      send({ id: m.id, error: { message: "Iris does not answer server requests" } });
    } else if (m.id !== undefined) {
      const call = pending.get(Number(m.id));
      pending.delete(Number(m.id));
      if (m.error) call?.reject(new Error(m.error.message ?? "request failed"));
      else call?.resolve(m.result);
    } else if (m.method) {
      onNotification(m);
    }
  });
  child.once("close", () => {
    for (const call of pending.values()) call.reject(new Error("app server exited"));
  });

  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  /** Resolves with the next turn/completed notification's turn status. */
  const turnCompleted = () =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no turn/completed in time")), stepTimeoutMs);
      onNotification = (m) => {
        if (m.method !== "turn/completed") return;
        clearTimeout(timer);
        resolve(String(m.params?.turn?.status ?? "unknown"));
      };
    });

  const results: StepResult[] = [];
  try {
    await request("initialize", { clientInfo: { name: "iris", title: "Iris", version: "1.0.0" }, capabilities: {} });
    send({ method: "initialized" });
    // Approvals off: a headless run cannot answer them (as with codex exec).
    const started = await request("thread/start", { cwd, approvalPolicy: "never", sandbox: "workspace-write" });
    const threadId: string = started.thread.id;

    for (const step of steps) {
      const start = performance.now();
      let exitCode: number | null = 1;
      try {
        const done = turnCompleted();
        if (step.compact) await request("thread/compact/start", { threadId });
        else await request("turn/start", { threadId, input: [{ type: "text", text: step.prompt }] });
        exitCode = (await done) === "completed" ? 0 : 1;
      } catch (err) {
        log.write(`[iris] step failed: ${err instanceof Error ? err.message : err}\n`);
      }
      results.push({ prompt: step.compact ? "(compact the thread)" : step.prompt, exitCode, durationMs: Math.round(performance.now() - start) });
      if (exitCode !== 0) break;
    }
  } finally {
    child.kill("SIGTERM");
    await exited;
    log.end();
  }
  return results;
}
