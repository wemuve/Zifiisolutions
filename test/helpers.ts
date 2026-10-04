import { buildApp } from "../src/app.js";
import { createPool, type Db } from "../src/db.js";
import { migrate } from "../src/migrate.js";

export const ADMIN = { authorization: "Bearer test-admin" };
export const RADIUS = { authorization: "Bearer test-radius" };

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://zifii:zifii@localhost:5432/zifii_test";

export async function freshDb(): Promise<Db> {
  const db = createPool(TEST_DATABASE_URL);
  await db.query("drop schema public cascade; create schema public;");
  await migrate(db);
  return db;
}

export function testApp(db: Db, clock: { now: Date }) {
  return buildApp({
    db,
    adminApiToken: "test-admin",
    radiusApiToken: "test-radius",
    staleSessionMinutes: 15,
    now: () => clock.now,
  });
}

// The body shape FreeRADIUS rlm_rest posts with "body = json".
export function rlmRest(attrs: Record<string, string | number>) {
  return Object.fromEntries(
    Object.entries(attrs).map(([name, value]) => [
      name,
      { type: typeof value === "number" ? "integer" : "string", value: [value] },
    ]),
  );
}
