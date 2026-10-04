import pg from "pg";

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl });
}

export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
