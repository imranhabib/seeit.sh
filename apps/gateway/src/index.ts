import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openLedger } from "./db/ledger.ts";

const config = loadConfig();
const ledger = openLedger(config.dbPath);

// Drop request/response bodies older than the retention period, now and every 6 hours.
const prune = () => {
  const removed = ledger.pruneBodies();
  if (removed) console.log(`pruned ${removed} old bodies`);
};
prune();
setInterval(prune, 6 * 60 * 60 * 1000).unref();

serve({ fetch: createApp(config, ledger).fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`seeit gateway on http://${info.address}:${info.port}`);
  for (const [name, upstream] of Object.entries(config.upstreams)) {
    console.log(`  /${name}/* -> ${upstream}`);
  }
  console.log(`ledger: ${config.dbPath}`);
  console.log(`recording to ${config.recordDir}/`);
});
