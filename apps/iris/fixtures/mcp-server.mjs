// A minimal MCP server for Iris scenarios: one read-only tool, "echo".
//
// MCP over stdio is JSON-RPC 2.0, one message per line
// (https://modelcontextprotocol.io/specification). Written by hand so Iris
// needs no MCP dependency. The reply text starts with a fixed phrase, so the
// chaos proxy can see the tool result in the harness's next request.

import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

const TOOLS = [
  {
    name: "echo",
    description: "Returns the text it is given.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    // Read-only, so harnesses may run it without asking.
    annotations: { readOnlyHint: true },
  },
];

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return; // a notification (for example notifications/initialized)
  if (method === "initialize") {
    send({
      id,
      result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "iris", version: "1.0.0" } },
    });
  } else if (method === "tools/list") {
    send({ id, result: { tools: TOOLS } });
  } else if (method === "tools/call" && params?.name === "echo") {
    send({ id, result: { content: [{ type: "text", text: `Iris MCP echo: ${params.arguments?.text ?? ""}` }] } });
  } else if (method === "ping") {
    send({ id, result: {} });
  } else {
    send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
