import pg from "pg";

import { schemaSql } from "./schema.js";

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
}

export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(schemaSql);
}
