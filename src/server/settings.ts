import type { Queryable } from "./db";

export async function getSetting<T>(q: Queryable, key: string): Promise<T | null> {
  const row = (await q.query("select value from app_settings where key = $1", [key])).rows[0];
  return row ? (row.value as T) : null;
}

export async function setSetting(q: Queryable, key: string, value: unknown) {
  await q.query(
    "insert into app_settings(key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()",
    [key, JSON.stringify(value)],
  );
}
