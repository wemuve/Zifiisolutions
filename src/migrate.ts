import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPool, withTransaction, type Db } from "./db.js";

// Works from both src/ (tsx) and dist/src/ (compiled), by walking up to the folder holding migrations/.
async function migrationsDir(): Promise<string> {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, "migrations");
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new Error("migrations directory not found");
}

export async function migrate(db: Db): Promise<string[]> {
  await db.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const dir = await migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    (await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name),
  );
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    await withTransaction(db, async (client) => {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
    });
    ran.push(file);
  }
  return ran;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = createPool(url);
  const ran = await migrate(db);
  console.log(ran.length ? `Applied ${ran.join(", ")}` : "Database is up to date");
  await db.end();
}
