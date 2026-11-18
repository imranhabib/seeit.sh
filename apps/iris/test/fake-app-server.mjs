// A fake `codex app-server` for app-server.test.ts: answers the requests the
// Iris driver sends and finishes every turn and compaction with
// turn/completed. Before finishing a turn it sends a server request (an
// approval), which the driver must answer.

import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let turn = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { userAgent: "fake" } });
  else if (method === "thread/start") send({ id, result: { thread: { id: "thread-1" } } });
  else if (method === "turn/start" || method === "thread/compact/start") {
    const turnId = `turn-${++turn}`;
    send({ id, result: method === "turn/start" ? { turn: { id: turnId } } : {} });
    send({ id: 900 + turn, method: "item/commandExecution/requestApproval", params: {} });
    const status = process.env.FAKE_FAIL_TURN === String(turn) ? "failed" : "completed";
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status } } });
  }
});
