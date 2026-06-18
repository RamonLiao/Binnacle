// Centralized config from env. No secrets here (read-only indexer).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Minimal .env loader (avoid a dep). Only sets vars not already in process.env.
function loadDotEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "..", ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3001),
  graphqlUrl: env.SUI_GRAPHQL_URL ?? "https://sui-testnet.mystenlabs.com/graphql",
  packageId: (env.PACKAGE_ID ?? "").trim(),
  pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? 3000),
  pollPageSize: Number(env.POLL_PAGE_SIZE ?? 50),
  dbPath: env.DB_PATH ?? "./indexer.db",
  seed: (env.SEED ?? "false").toLowerCase() === "true",
} as const;

export const hasPackage = config.packageId.length > 0;
