import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = buildApp({
  db,
  adminApiToken: config.adminApiToken,
  radiusApiToken: config.radiusApiToken,
  staleSessionMinutes: config.staleSessionMinutes,
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await db.end();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.port, host: "0.0.0.0" });
