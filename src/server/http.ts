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
  BYPASS_NOT_ALLOWED: 403,
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

// 자동화 우회 값(실행기용)으로 들어온 요청인지. 이 값은 실행기 전용 경로에만 쓰이게 하고, 화면용 경로에서는 거절한다.
// 우회 값이 새어도 그것만으로 프로젝트를 읽거나 바꾸지 못하게 하려는 것이다.
export function viaBypass(req: Request): boolean {
  if (req.headers.has("x-vercel-protection-bypass") || req.headers.has("x-vercel-set-bypass-cookie")) return true;
  try {
    const params = new URL(req.url).searchParams;
    return params.has("x-vercel-protection-bypass") || params.has("x-vercel-set-bypass-cookie");
  } catch {
    return false;
  }
}

const BYPASS_DENIED = () => error("BYPASS_NOT_ALLOWED", "이 경로는 로그인한 브라우저에서만 쓸 수 있습니다.");

// 화면용 변경 경로 공통 처리
export async function browserPost(req: Request, fn: (db: Db, body: Record<string, unknown>) => Promise<Envelope>) {
  if (viaBypass(req)) return BYPASS_DENIED();
  if (!sameOrigin(req)) return error("FORBIDDEN_ORIGIN", "허용되지 않은 출처의 요청입니다.");
  try {
    return respond(await fn(await getDb(), await readJson(req)));
  } catch (e) {
    return respond(toEnvelopeError(e));
  }
}

export async function browserGet(req: Request, fn: (db: Db) => Promise<Envelope>) {
  if (viaBypass(req)) return BYPASS_DENIED();
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
