// Entry point: starts the REST server and (if PACKAGE_ID set) the event poll loop.
import { config, hasPackage } from "./config.js";
import { buildServer } from "./api.js";
import { pollOnce } from "./source.js";
import { process as applyEvents } from "./processor.js";
import { seedIfRequested } from "./seed.js";

let stopping = false;

async function pollLoop() {
  while (!stopping) {
    try {
      const events = await pollOnce();
      if (events.length) {
        applyEvents(events);
        console.log(`[poll] applied ${events.length} event(s)`);
      }
    } catch (err) {
      // Fail loud but keep the loop alive — transient GraphQL/network errors are expected.
      console.error(`[poll] error: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

async function main() {
  seedIfRequested();

  const app = buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`[api] listening on http://localhost:${config.port}`);

  if (hasPackage) {
    console.log(`[poll] polling ${config.packageId}::events every ${config.pollIntervalMs}ms`);
    void pollLoop();
  } else {
    console.warn("[poll] PACKAGE_ID not set — serving stored/seed data only (no live polling).");
  }

  const shutdown = async () => {
    stopping = true;
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
