// 브라우저에서 쓰는 API 호출 도우미
export interface Env<T = unknown> {
  ok: boolean;
  state_version?: number;
  data?: T;
  duplicate?: boolean;
  error?: { code: string; message: string; retryable: boolean };
}

async function parse<T>(res: Response): Promise<Env<T>> {
  try {
    return (await res.json()) as Env<T>;
  } catch {
    return { ok: false, error: { code: "NETWORK", message: `서버 응답을 읽지 못했습니다(HTTP ${res.status}). 로그인 상태를 확인해 주세요.`, retryable: true } };
  }
}

export async function apiGet<T>(url: string): Promise<Env<T>> {
  try {
    return await parse<T>(await fetch(url, { cache: "no-store" }));
  } catch {
    return { ok: false, error: { code: "NETWORK", message: "서버에 연결하지 못했습니다.", retryable: true } };
  }
}

export async function apiPost<T>(url: string, body: unknown): Promise<Env<T>> {
  try {
    return await parse<T>(await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  } catch {
    return { ok: false, error: { code: "NETWORK", message: "서버에 연결하지 못했습니다. 저장되지 않았을 수 있습니다.", retryable: true } };
  }
}

export function newKey(): string {
  return crypto.randomUUID();
}

export function kst(isoText: string | null | undefined): string {
  if (!isoText) return "-";
  return new Date(isoText).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export interface RunnerStatusView {
  mode: "chatgpt" | "mock";
  signed_in: boolean;
  plan_usage_enabled: boolean;
  account_label: string | null;
  models: { slug: string; display_name: string }[];
  structured_output: "unknown" | "supported" | "unsupported";
  version: string;
  message: string | null;
}

export interface StatusView {
  badge: "online" | "offline" | "none" | "login_required" | "plan_disabled" | "paused" | "mock";
  runner: { runner_id: string; label: string; online: boolean; last_seen_at: string | null; status: RunnerStatusView | null } | null;
  runners: { runner_id: string; label: string; online: boolean; last_seen_at: string | null; created_at: string; status: RunnerStatusView | null }[];
  paused: { paused: boolean; reason: string; at: string } | null;
  model_slug: string | null;
  usage: { today: number; project: number | null; caps: { perProject: number; perDay: number } };
}

export interface RunView {
  run_id: string;
  task: string;
  role: string | null;
  status: "queued" | "claimed" | "succeeded" | "failed" | "superseded" | "cancelled";
  attempts: number;
  output_mode: string | null;
  model_slug: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  claimed_at: string | null;
  finished_at: string | null;
}
