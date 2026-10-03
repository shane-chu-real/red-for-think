import { MIGRATIONS } from "./migrations";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  kind: "postgres" | "pglite";
}

async function createPgDb(connectionString: string): Promise<Db> {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 });
  if (process.env.VERCEL) {
    const { attachDatabasePool } = await import("@vercel/functions");
    attachDatabasePool(pool);
  }
  return {
    kind: "postgres",
    query: (sql, params) => pool.query(sql, params as any[]) as any,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({ query: (sql, params) => client.query(sql, params as any[]) as any });
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.mkdirSync(path.dirname(path.resolve(dataDir)), { recursive: true });
  }
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  await lite.waitReady;
  return {
    kind: "pglite",
    query: (sql, params) => lite.query(sql, params as any[]) as any,
    tx: (fn) => lite.transaction((t) => fn({ query: (sql, params) => t.query(sql, params as any[]) as any })),
  };
}

export async function migrate(db: Db): Promise<string[]> {
  await db.query("create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ version: string }>("select version from schema_migrations")).rows.map((r) => r.version));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    await db.tx(async (q) => {
      for (const stmt of splitSql(m.sql)) await q.query(stmt);
      await q.query("insert into schema_migrations(version) values ($1)", [m.version]);
    });
    applied.push(m.version);
  }
  return applied;
}

// $$ 블록을 깨지 않도록 세미콜론 기준으로 나눈다.
function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inDollar = false;
  for (const line of sql.split("\n")) {
    if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inDollar = !inDollar;
    buf += `${line}\n`;
    if (!inDollar && line.trim().endsWith(";")) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

let dbPromise: Promise<Db> | null = null;

export function setDbForTests(db: Db) {
  dbPromise = Promise.resolve(db);
}

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const url = process.env.DATABASE_URL;
      if (url) return createPgDb(url);
      if (process.env.NODE_ENV === "production") {
        throw new Error("DATABASE_URL이 설정되지 않았습니다. Vercel에 Neon을 연결해 주세요.");
      }
      // 로컬 개발: 파일 기반 내장 Postgres(PGlite)를 쓰고 스키마를 자동 적용한다.
      const db = await createPgliteDb(process.env.PGLITE_DIR ?? ".data/pglite");
      await migrate(db);
      return db;
    })().catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}
