import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();

serve({ fetch: createApp(config).fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`seeit gateway on http://${info.address}:${info.port}`);
  for (const [name, upstream] of Object.entries(config.upstreams)) {
    console.log(`  /${name}/* -> ${upstream}`);
  }
  console.log(`recording to ${config.recordDir}/`);
});
