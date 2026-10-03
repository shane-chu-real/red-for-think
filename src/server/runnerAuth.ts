// 실행기 등록·인증. 실행기 토큰은 해시만 저장하고, 연결 코드는 10분·1회용이다.
import { randomBytes, randomUUID } from "node:crypto";
import type { Db, Queryable } from "./db";
import { iso, sha256 } from "./service";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_MINUTES = 10;

export interface Runner {
  runner_id: string;
  label: string;
}

function randomCode(len = 12): string {
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export function encodeConnection(info: { url: string; bypass: string | null; code: string }): string {
  return `rft1.${Buffer.from(JSON.stringify(info), "utf8").toString("base64url")}`;
}

export async function createPairing(db: Db, origin: string) {
  const code = randomCode();
  const expires = new Date(Date.now() + PAIRING_MINUTES * 60_000).toISOString();
  await db.query("insert into pairing_codes(code_hash, expires_at, created_at) values ($1, $2, now())", [sha256(code), expires]);
  return {
    connection_string: encodeConnection({ url: origin, bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? null, code }),
    expires_at: expires,
    bypass_included: Boolean(process.env.VERCEL_AUTOMATION_BYPASS_SECRET),
  };
}

export async function pairRunner(db: Db, input: { code: string; label: string; host_id?: string | null }) {
  return db.tx(async (q) => {
    const row = (await q.query("select * from pairing_codes where code_hash = $1 for update", [sha256(String(input.code ?? ""))])).rows[0];
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return null;
    await q.query("update pairing_codes set used_at = now() where code_hash = $1", [row.code_hash]);
    const token = randomBytes(32).toString("base64url");
    const runner_id = randomUUID();
    await q.query("insert into runners(runner_id, label, host_id, token_hash, created_at) values ($1, $2, $3, $4, now())", [
      runner_id,
      String(input.label || "내 PC").slice(0, 80),
      input.host_id ? String(input.host_id).slice(0, 120) : null,
      sha256(token),
    ]);
    return { runner_id, token };
  });
}

export async function authenticateRunner(q: Queryable, authorization: string | null): Promise<Runner | null> {
  const m = authorization?.match(/^Bearer\s+(\S+)$/);
  if (!m) return null;
  const row = (await q.query("select runner_id, label from runners where token_hash = $1 and revoked_at is null", [sha256(m[1])])).rows[0];
  if (!row) return null;
  await q.query("update runners set last_seen_at = now() where runner_id = $1", [row.runner_id]);
  return row as Runner;
}

export interface RunnerStatus {
  mode: "chatgpt" | "mock";
  signed_in: boolean;
  plan_usage_enabled: boolean;
  account_label: string | null;
  models: { slug: string; display_name: string }[];
  structured_output: "unknown" | "supported" | "unsupported";
  version: string;
  message: string | null;
}

export async function heartbeat(q: Queryable, runnerId: string, status: unknown) {
  const s = (status ?? {}) as Partial<RunnerStatus>;
  const clean: RunnerStatus = {
    mode: s.mode === "mock" ? "mock" : "chatgpt",
    signed_in: Boolean(s.signed_in),
    plan_usage_enabled: Boolean(s.plan_usage_enabled),
    account_label: s.account_label ? String(s.account_label).slice(0, 120) : null,
    models: Array.isArray(s.models) ? s.models.slice(0, 50).map((m) => ({ slug: String(m.slug).slice(0, 100), display_name: String(m.display_name ?? m.slug).slice(0, 100) })) : [],
    structured_output: s.structured_output === "supported" || s.structured_output === "unsupported" ? s.structured_output : "unknown",
    version: String(s.version ?? "").slice(0, 40),
    message: s.message ? String(s.message).slice(0, 300) : null,
  };
  await q.query("update runners set status = $2, last_seen_at = now() where runner_id = $1", [runnerId, JSON.stringify(clean)]);
}

export async function listRunners(q: Queryable) {
  const { rows } = await q.query("select runner_id, label, host_id, status, created_at, last_seen_at, revoked_at from runners order by created_at desc limit 20");
  return rows.map((r) => ({
    ...r,
    created_at: iso(r.created_at),
    last_seen_at: r.last_seen_at ? iso(r.last_seen_at) : null,
    revoked_at: r.revoked_at ? iso(r.revoked_at) : null,
    online: Boolean(r.last_seen_at) && !r.revoked_at && Date.now() - new Date(r.last_seen_at).getTime() < 90_000,
  }));
}

export async function revokeRunner(q: Queryable, runnerId: string) {
  await q.query("update runners set revoked_at = now() where runner_id = $1 and revoked_at is null", [runnerId]);
}
