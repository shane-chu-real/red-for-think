import { NextResponse } from "next/server";
import { getDb, type Db } from "./db";
import { authenticateRunner, type Runner } from "./runnerAuth";
import { toEnvelopeError, type Envelope } from "./service";

const STATUS: Record<string, number> = {
  VERSION_CONFLICT: 409,
  AI_BUSY: 409,
  INVALID_TRANSITION: 409,
  NOT_FOUND: 404,
  STORAGE_ERROR: 500,
  FORBIDDEN_ORIGIN: 403,
  UNAUTHORIZED: 401,
};

export function respond(env: Envelope) {
  return NextResponse.json(env, { status: env.ok ? 200 : (STATUS[env.error?.code ?? ""] ?? 400), headers: { "cache-control": "no-store" } });
}

export function error(code: string, message: string, retryable = false) {
  return respond({ ok: false, error: { code, message, retryable } });
}

// 브라우저에서 온 변경 요청은 같은 출처에서 온 것만 받는다.
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// 화면용 변경 경로 공통 처리
export async function browserPost(req: Request, fn: (db: Db, body: Record<string, unknown>) => Promise<Envelope>) {
  if (!sameOrigin(req)) return error("FORBIDDEN_ORIGIN", "허용되지 않은 출처의 요청입니다.");
  try {
    return respond(await fn(await getDb(), await readJson(req)));
  } catch (e) {
    return respond(toEnvelopeError(e));
  }
}

export async function browserGet(fn: (db: Db) => Promise<Envelope>) {
  try {
    return respond(await fn(await getDb()));
  } catch (e) {
    return respond(toEnvelopeError(e));
  }
}

// 실행기 전용 경로: 실행기 토큰이 있어야 한다.
export async function runnerPost(req: Request, fn: (db: Db, runner: Runner, body: Record<string, unknown>) => Promise<unknown>) {
  try {
    const db = await getDb();
    const runner = await authenticateRunner(db, req.headers.get("authorization"));
    if (!runner) return error("UNAUTHORIZED", "등록되지 않았거나 해제된 실행기입니다.");
    const data = await fn(db, runner, await readJson(req));
    return NextResponse.json({ ok: true, data }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return respond(toEnvelopeError(e));
  }
}

export function origin(req: Request): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}
