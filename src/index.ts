import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { log } from "./log.ts";
import { Notifier } from "./notifier.ts";

const config = await loadConfig();
const store = new Store(process.env.DATABASE_PATH ?? config.database.path);
const notifier = new Notifier(store, config);
const app = createApp({ config, store, notifier });

const server = Bun.serve({
  port: Number(process.env.PORT ?? config.server.port),
  hostname: config.server.host,
  fetch: app.fetch,
});
notifier.start();

log.info("nowepay started", {
  url: server.url.toString(),
  publicUrl: config.server.publicUrl,
  channels: config.channels.map((c) => ({ id: c.id, kind: c.kind, types: c.types, rate: c.rate })),
});

const shutdown = () => {
  log.info("shutting down");
  notifier.stop();
  void server.stop().then(() => {
    store.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
