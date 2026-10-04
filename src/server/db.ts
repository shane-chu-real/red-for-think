import { MIGRATIONS } from "./migrations";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  kind: "postgres" | "pglite";
}

// searchPath: 시험용 임시 스키마에서 돌릴 때만 쓴다(직접 연결 전용 — 세션 설정이 연결마다 유지되어야 한다).
export async function createPgDb(connectionString: string, opts: { searchPath?: string; max?: number } = {}): Promise<Db & { close: () => Promise<void> }> {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 5, idleTimeoutMillis: 10_000 });
  if (opts.searchPath && !/^[a-z_][a-z0-9_]*$/.test(opts.searchPath)) throw new Error("잘못된 스키마 이름입니다.");
  if (process.env.VERCEL) {
    const { attachDatabasePool } = await import("@vercel/functions");
    attachDatabasePool(pool);
  }
  // 임시 스키마를 쓸 때는 연결을 꺼낼 때마다 search_path를 맞춘 뒤 쓴다.
  const acquire = async () => {
    const client = await pool.connect();
    if (opts.searchPath) await client.query(`set search_path to ${opts.searchPath}`);
    return client;
  };
  return {
    close: () => pool.end(),
    kind: "postgres",
    query: opts.searchPath
      ? async (sql, params) => {
          const client = await acquire();
          try {
            return (await client.query(sql, params as any[])) as any;
          } finally {
            client.release();
          }
        }
      : (sql, params) => pool.query(sql, params as any[]) as any,
    async tx(fn) {
      const client = await acquire();
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
      const production = process.env.NODE_ENV === "production";
      // 로컬 개발에서는 .env.local에 운영 DB 주소가 있어도 기본으로 쓰지 않는다(운영 데이터에 실수로 쓰지 않게).
      // 로컬에서 원격 DB를 꼭 써야 하면 RFT_USE_REMOTE_DB=1을 명시한다.
      if (url && (production || process.env.RFT_USE_REMOTE_DB === "1")) return createPgDb(url);
      if (production) {
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
