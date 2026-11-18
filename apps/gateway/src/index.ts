import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openLedger } from "./db/ledger.ts";
import { DEFAULT_DELIVERY, createDelivery } from "./delivery.ts";

const config = loadConfig();
const ledger = openLedger(config.dbPath);

// Drop request/response bodies older than the retention period, now and every 6 hours.
const prune = () => {
  const removed = ledger.pruneBodies();
  if (removed) console.log(`pruned ${removed} old bodies`);
};
prune();
setInterval(prune, 6 * 60 * 60 * 1000).unref();

// Send calls to the ledger service only when it is configured (ADR 0007).
const delivery =
  config.ledgerUrl && config.ledgerWriteToken ? createDelivery({ ...DEFAULT_DELIVERY, url: config.ledgerUrl, token: config.ledgerWriteToken }) : undefined;

serve({ fetch: createApp(config, ledger, {}, delivery).fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`seeit gateway on http://${info.address}:${info.port}`);
  for (const [name, upstream] of Object.entries(config.upstreams)) {
    console.log(`  /${name}/* -> ${upstream}`);
  }
  console.log(`ledger: ${config.dbPath}`);
  if (config.ledgerUrl && !delivery) console.warn("SEEIT_LEDGER_URL is set but SEEIT_LEDGER_WRITE_TOKEN is not: calls are not sent to the ledger service");
  if (delivery) console.log(`ledger service: ${config.ledgerUrl}`);
  console.log(`recording to ${config.recordDir}/`);
});
