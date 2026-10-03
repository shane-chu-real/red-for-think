// 웹앱(Vercel)과의 통신. 실행기는 아웃바운드 HTTPS만 쓰고, 연결 정보는 보호 저장소에 둔다.
import os from "node:os";
import type { RunPayload } from "../src/core/prompts";
import { hostId, loadSecret, saveSecret } from "./secure-store";

export interface Connection {
  url: string;
  bypass: string | null; // Vercel 자동화 우회 비밀값 (x-vercel-protection-bypass)
  token: string; // 실행기 토큰 (서버에는 해시만 저장됨)
  runner_id: string;
  paired_at: string;
}

export interface Job {
  run_id: string;
  request_key: string;
  project_id: string;
  task: string;
  role: string | null;
  model_slug: string | null;
  lease_expires_at: string;
  payload: RunPayload;
}

export type Claim = { status: "idle" } | { status: "paused"; reason: string } | { status: "cap_reached"; message: string } | { status: "claimed"; job: Job };

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
  }
}

export function loadConnection(): Connection | null {
  return loadSecret<Connection>("connection");
}

export function decodeConnectionString(text: string): { url: string; bypass: string | null; code: string } {
  const t = text.trim();
  if (!t.startsWith("rft1.")) throw new AppError("PAIRING_INVALID", "연결 문자열 형식이 아닙니다. 설정 화면에서 발급한 문자열 전체를 붙여 주세요.");
  try {
    const info = JSON.parse(Buffer.from(t.slice(5), "base64url").toString("utf8"));
    if (!info.url || !info.code) throw new Error("missing");
    return { url: String(info.url).replace(/\/$/, ""), bypass: info.bypass ? String(info.bypass) : null, code: String(info.code) };
  } catch {
    throw new AppError("PAIRING_INVALID", "연결 문자열을 해석할 수 없습니다.");
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
  } catch (e) {
    throw new AppError("NETWORK", `웹앱에 연결하지 못했습니다: ${e instanceof Error ? e.message : e}`);
  }
  const text = await res.text();
  let json: { ok?: boolean; data?: unknown; error?: { code: string; message: string } } | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!json) {
    // Vercel 보호 화면(HTML)이 돌아오는 경우: 우회 비밀값이 없거나 틀렸다.
    throw new AppError(res.status === 401 || res.status === 403 ? "PROTECTION_BLOCKED" : "BAD_RESPONSE", `웹앱이 JSON이 아닌 응답을 보냈습니다(HTTP ${res.status}). 배포 보호 우회 값이나 주소를 확인해 주세요.`, res.status);
  }
  if (!json.ok) throw new AppError(json.error?.code ?? "APP_ERROR", json.error?.message ?? "웹앱 요청이 거절되었습니다.", res.status);
  return json.data;
}

export async function pair(connectionString: string): Promise<Connection> {
  const info = decodeConnectionString(connectionString);
  const headers: Record<string, string> = info.bypass ? { "x-vercel-protection-bypass": info.bypass } : {};
  const data = (await post(`${info.url}/api/runner/pair`, headers, { code: info.code, label: os.hostname(), host_id: hostId() })) as { runner_id: string; token: string };
  const conn: Connection = { url: info.url, bypass: info.bypass, token: data.token, runner_id: data.runner_id, paired_at: new Date().toISOString() };
  saveSecret("connection", conn);
  return conn;
}

export class AppClient {
  constructor(private conn: Connection) {}

  private call(path: string, body?: unknown) {
    const headers: Record<string, string> = { authorization: `Bearer ${this.conn.token}` };
    if (this.conn.bypass) headers["x-vercel-protection-bypass"] = this.conn.bypass;
    return post(`${this.conn.url}${path}`, headers, body);
  }

  heartbeat(status: unknown) {
    return this.call("/api/runner/heartbeat", { status }) as Promise<{ runner_id: string; model_slug: string | null; paused: string | null }>;
  }
  claim() {
    return this.call("/api/runner/claim") as Promise<Claim>;
  }
  complete(runId: string, body: unknown) {
    return this.call(`/api/runner/runs/${runId}/complete`, body) as Promise<{ status: string; errors?: string[]; message?: string }>;
  }
  fail(runId: string, body: unknown) {
    return this.call(`/api/runner/runs/${runId}/fail`, body) as Promise<{ status: string; message?: string }>;
  }
}
