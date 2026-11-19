import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { DEFAULT_DELIVERY, createDelivery } from "./delivery.ts";

const config = loadConfig();

// Calls are analyzed and stored by the ledger service (ADR 0007).
const delivery =
  config.ledgerUrl && config.ledgerWriteToken ? createDelivery({ ...DEFAULT_DELIVERY, url: config.ledgerUrl, token: config.ledgerWriteToken }) : undefined;

serve({ fetch: createApp(config, {}, delivery).fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`seeit gateway on http://${info.address}:${info.port}`);
  for (const [name, upstream] of Object.entries(config.upstreams)) {
    console.log(`  /${name}/* -> ${upstream}`);
  }
  if (delivery) console.log(`ledger service: ${config.ledgerUrl}`);
  else console.warn("SEEIT_LEDGER_URL and SEEIT_LEDGER_WRITE_TOKEN are not both set: calls are forwarded but not recorded");
  console.log(`recording to ${config.recordDir}/`);
});
