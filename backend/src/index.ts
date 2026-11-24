import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { db } from "./db.js";
import { startIndexer } from "./workers/indexer.js";
import { startScheduler } from "./workers/scheduler.js";

async function main() {
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });

  // The indexer owns the chain cursor and the scheduler signs with the keeper
  // account; two processes doing either would race. RUN_WORKERS=false makes
  // this an API-only instance beside the one that runs them.
  const workers = env.RUN_WORKERS ? [startIndexer(), startScheduler()] : [];
  if (!env.RUN_WORKERS) app.log.info("RUN_WORKERS=false: serving the API only, no indexer or keeper");

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info(`${signal} received, shutting down`);
    for (const worker of workers) worker.stop();
    await app.close().catch((err) => app.log.error(err));
    await db.destroy().catch((err) => app.log.error(err));
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
