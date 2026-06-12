import "dotenv/config";
import { env } from "./env.js";
import { createApp } from "./app.js";
import { boss } from "./lib/queue.js";
import { registerEventWorkers } from "./jobs/process-events.js";
import { registerDunningWorkers } from "./jobs/dunning.js";
import { registerExpiryWorkers } from "./jobs/expiry.js";

async function main() {
  await boss.start();
  await registerEventWorkers();
  await registerDunningWorkers();
  await registerExpiryWorkers();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`🚀 Dunly API listening on http://localhost:${env.PORT}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down…`);
    server.close();
    await boss.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
