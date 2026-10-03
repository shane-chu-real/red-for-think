// AI 공급자. ChatGPTSubscriptionProvider는 프로젝트 내부 이름이며, 공식 Responses 경로만 호출한다.
// 유료 API 대체 호출·다른 공급자 전환·자동 구매 경로는 없다.
import OpenAI, { APIError } from "openai";
import { mockOutput } from "../src/core/mock";
import { payloadInput, type RunPayload } from "../src/core/prompts";
import { RESOURCE } from "./oauth";

export interface ProviderJob {
  payload: RunPayload;
  model_slug: string | null;
}

export interface ProviderResult {
  text: string;
  terminal_event: "response.completed";
  output_mode: "json_schema" | "text_json" | "mock";
  model_slug: string;
  provider_request_id: string | null;
  usage: unknown;
}

export type ProviderErrorCode =
  | "PLAN_NOT_ELIGIBLE"
  | "USAGE_LIMIT"
  | "AI_TEMPORARY"
  | "UNSUPPORTED_CAPABILITY"
  | "ROUTE_NOT_SUPPORTED"
  | "REAUTH_REQUIRED"
  | "SCOPE_NOT_AUTHORIZED"
  | "AI_INCOMPLETE"
  | "MODEL_UNAVAILABLE"
  | "AI_ERROR";

export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    message: string,
    public detail: { httpStatus?: number; providerCode?: string; param?: string; requestId?: string | null; retryable?: boolean; streamStarted?: boolean } = {},
  ) {
    super(message);
  }
}

export interface Provider {
  mode: "chatgpt" | "mock";
  listModels(): Promise<{ slug: string; display_name: string }[]>;
  generate(job: ProviderJob): Promise<ProviderResult>;
  structured: "unknown" | "supported" | "unsupported";
}

// 공식 오류 코드 → 앱 오류 코드 (developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
export function mapProviderError(providerCode: string | undefined, status: number | undefined): { code: ProviderErrorCode; message: string; retryable: boolean } {
  switch (providerCode) {
    case "subscription_sharing_user_not_eligible":
      return { code: "PLAN_NOT_ELIGIBLE", message: "이 ChatGPT 계정·플랜으로는 플랜 사용 기능을 쓸 수 없습니다. 반복 로그인으로 해결되지 않습니다.", retryable: false };
    case "subscription_sharing_usage_limit_exceeded":
      return { code: "USAGE_LIMIT", message: "ChatGPT 플랜 사용 한도에 도달했습니다. ChatGPT 설정의 Usage를 확인해 주세요.", retryable: false };
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return { code: "AI_TEMPORARY", message: "사용량 확인이 일시적으로 불가능합니다. 잠시 뒤 다시 시도해 주세요.", retryable: true };
    case "subscription_sharing_unsupported_capability":
      return { code: "UNSUPPORTED_CAPABILITY", message: "이 경로에서 지원하지 않는 기능이 요청에 들어 있습니다.", retryable: false };
    case "subscription_sharing_route_not_supported":
      return { code: "ROUTE_NOT_SUPPORTED", message: "이 경로에서 지원하지 않는 엔드포인트·메서드입니다.", retryable: false };
    case "subscription_sharing_invalid_user":
      return { code: "REAUTH_REQUIRED", message: "로그인 정보가 유효하지 않습니다. 다시 로그인해 주세요.", retryable: false };
    case "chatpass_v2_scope_not_authorized":
      return { code: "SCOPE_NOT_AUTHORIZED", message: "플랜 사용 권한(scope)이 승인되지 않았습니다.", retryable: false };
  }
  if (status === 401) return { code: "REAUTH_REQUIRED", message: "인증이 거절되었습니다. 계정과 허가된 권한을 확인해 주세요.", retryable: false };
  if (status === 403) return { code: "SCOPE_NOT_AUTHORIZED", message: "정책 또는 권한 검사에서 거절되었습니다.", retryable: false };
  if (status === 429) return { code: "USAGE_LIMIT", message: "요청 한도에 도달했습니다. ChatGPT 설정의 Usage를 확인해 주세요.", retryable: false };
  if (status === 503 || (status !== undefined && status >= 500)) return { code: "AI_TEMPORARY", message: "AI 서버가 일시적으로 응답하지 않습니다.", retryable: true };
  return { code: "AI_ERROR", message: "AI 호출에 실패했습니다.", retryable: false };
}

export interface ChatGPTProviderOptions {
  getAccessToken: () => Promise<string>;
  baseURL?: string;
  structured?: Provider["structured"];
  onStructuredChange?: (s: "supported" | "unsupported") => void;
  timeoutMs?: number;
  retryDelaysMs?: number[];
}

export class ChatGPTSubscriptionProvider implements Provider {
  mode = "chatgpt" as const;
  structured: Provider["structured"];
  private models: { slug: string; display_name: string }[] | null = null;
  private baseURL: string;

  constructor(private opts: ChatGPTProviderOptions) {
    this.structured = opts.structured ?? "unknown";
    this.baseURL = opts.baseURL ?? RESOURCE;
  }

  // 토큰을 얻지 못한 이유를 구분한다: 재로그인이 필요하면 멈추고, 일시 오류면 잠시 뒤 다시 시도한다.
  private async token(): Promise<string> {
    try {
      return await this.opts.getAccessToken();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "REAUTH_REQUIRED" || code === "NOT_SIGNED_IN") {
        throw new ProviderError("REAUTH_REQUIRED", "ChatGPT 로그인이 만료되었거나 해제되었습니다. npm run runner -- login 으로 다시 로그인해 주세요.", { retryable: false, streamStarted: false });
      }
      throw new ProviderError("AI_TEMPORARY", `로그인 정보를 갱신하지 못했습니다(일시 오류): ${e instanceof Error ? e.message : e}`, { retryable: true, streamStarted: false });
    }
  }

  // 계정 토큰으로 조회한 목록에서 visibility가 list인 모델만 쓴다. 모델 이름을 코드에 고정하지 않는다.
  async listModels(force = false) {
    if (this.models && !force) return this.models;
    const token = await this.token();
    // 리다이렉트를 따라가지 않는다(토큰이 다른 호스트로 넘어가지 않게).
    const res = await fetch(`${this.baseURL}/models`, { headers: { authorization: `Bearer ${token}` }, redirect: "error" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      const m = mapProviderError(body.error?.code, res.status);
      throw new ProviderError(m.code, m.message, { httpStatus: res.status, providerCode: body.error?.code, retryable: m.retryable });
    }
    const body = (await res.json()) as { models?: { slug: string; display_name?: string; visibility?: string }[] };
    this.models = (body.models ?? []).filter((m) => m.visibility === "list").map((m) => ({ slug: m.slug, display_name: m.display_name ?? m.slug }));
    return this.models;
  }

  private async pickModel(wanted: string | null): Promise<string> {
    let models = await this.listModels();
    if (wanted && !models.some((m) => m.slug === wanted)) models = await this.listModels(true);
    if (wanted) {
      if (!models.some((m) => m.slug === wanted)) throw new ProviderError("MODEL_UNAVAILABLE", `선택한 모델(${wanted})이 현재 계정의 모델 목록에 없습니다. 설정에서 다시 골라 주세요.`);
      return wanted;
    }
    if (!models.length) throw new ProviderError("MODEL_UNAVAILABLE", "현재 계정에서 쓸 수 있는 모델이 없습니다.");
    return models[0].slug;
  }

  async generate(job: ProviderJob): Promise<ProviderResult> {
    const delays = this.opts.retryDelaysMs ?? [5000, 15000];
    let retries = 0;
    // 원인 필드가 표시되지 않은 '미지원 기능' 오류를 받았을 때, text.format 없이 한 번 시도해 보기 위한 표시
    let withoutSchemaAfter: ProviderError | null = null;
    for (;;) {
      const useSchema = this.structured !== "unsupported" && !withoutSchemaAfter;
      try {
        const model = await this.pickModel(job.model_slug);
        const result = await this.once(job.payload, model, useSchema);
        if (useSchema && this.structured === "unknown") this.setStructured("supported");
        if (withoutSchemaAfter) this.setStructured("unsupported"); // text.format이 원인이었음이 확인됨
        return result;
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        // 아래 재전송은 모두 '요청이 거절되어 스트림이 시작되지 않은 경우'에만 한다(중복 사용 방지).
        if (e.code === "UNSUPPORTED_CAPABILITY" && !e.detail.streamStarted) {
          if (withoutSchemaAfter) throw withoutSchemaAfter; // text.format 탓이 아니었다: 처음 오류를 그대로 보고
          if (useSchema && e.detail.param?.startsWith("text")) {
            // 구조화 출력이 이 경로에서 거절됨: 기록을 남기고 'JSON 텍스트' 방식으로 다시 보낸다.
            this.setStructured("unsupported");
            continue;
          }
          if (useSchema && !e.detail.param && this.structured === "unknown") {
            withoutSchemaAfter = e;
            continue;
          }
        }
        if (e.code === "AI_TEMPORARY" && !e.detail.streamStarted && retries < delays.length) {
          await new Promise((r) => setTimeout(r, delays[retries++]));
          continue;
        }
        throw e;
      }
    }
  }

  private setStructured(s: "supported" | "unsupported") {
    this.structured = s;
    this.opts.onStructuredChange?.(s);
  }

  private async once(payload: RunPayload, model: string, useSchema: boolean): Promise<ProviderResult> {
    const token = await this.token();
    // SDK의 apiKey 자리에 OAuth bearer 토큰을 넣는다. 종량제 API 키가 아니다. 리다이렉트는 따라가지 않는다.
    const client = new OpenAI({
      apiKey: token,
      baseURL: this.baseURL,
      maxRetries: 0,
      timeout: this.opts.timeoutMs ?? 9 * 60_000,
      fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
    });
    const parts: string[] = [];
    let started = false;
    let completed = false;
    let usage: unknown = null;
    let requestId: string | null = null;
    try {
      // 이 경로의 필수 조건: store=false, stream=true. temperature·max_output_tokens 등 미지원 필드는 보내지 않는다.
      const { data: stream, request_id } = await client.responses
        .create({
          model,
          instructions: payload.instructions,
          input: payloadInput(payload),
          store: false,
          stream: true,
          ...(useSchema ? { text: { format: { type: "json_schema" as const, name: payload.schema_name, schema: payload.schema, strict: true } } } : {}),
        })
        .withResponse();
      // 서버가 요청을 받아들인 시점부터는 '시작된 요청'이다. 이후 끊겨도 자동으로 다시 보내지 않는다.
      started = true;
      requestId = request_id ?? null;
      for await (const ev of stream) {
        if (ev.type === "response.output_text.delta") parts.push(ev.delta);
        else if (ev.type === "response.completed") {
          completed = true;
          usage = ev.response.usage ?? null;
        } else if (ev.type === "response.failed") {
          const err = ev.response.error;
          const m = mapProviderError(err?.code, undefined);
          throw new ProviderError(m.code === "AI_ERROR" ? "AI_INCOMPLETE" : m.code, `${m.message} (response.failed${err?.code ? `: ${err.code}` : ""})`, { providerCode: err?.code, requestId, retryable: false, streamStarted: true });
        } else if (ev.type === "response.incomplete") {
          throw new ProviderError("AI_INCOMPLETE", "응답이 완료되지 않고 끝났습니다(response.incomplete).", { requestId, streamStarted: true });
        }
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (e instanceof APIError) {
        if (e.status === undefined && !started) {
          // 연결 자체가 되지 않았다(요청이 서버에 받아들여지기 전): 제한적으로 다시 시도할 수 있다.
          throw new ProviderError("AI_TEMPORARY", "AI 서버에 연결하지 못했습니다.", { requestId, retryable: true, streamStarted: false });
        }
        const m = mapProviderError(e.code ?? undefined, e.status);
        // 스트림이 시작된 뒤의 오류는 자동으로 다시 보내지 않는다(중복 사용 방지).
        throw new ProviderError(started && (m.code === "AI_TEMPORARY" || m.code === "AI_ERROR") ? "AI_INCOMPLETE" : m.code, started ? `${m.message} (스트림 도중 오류)` : m.message, {
          httpStatus: e.status,
          providerCode: e.code ?? undefined,
          param: e.param ?? undefined,
          requestId: e.requestID ?? requestId,
          retryable: m.retryable && !started,
          streamStarted: started,
        });
      }
      throw new ProviderError(started ? "AI_INCOMPLETE" : "AI_TEMPORARY", started ? "응답을 받는 도중 연결이 끊겼습니다." : "AI 서버에 연결하지 못했습니다.", { requestId, retryable: !started, streamStarted: started });
    }
    // 완료 이벤트가 없으면 부분 답변이 있어도 성공으로 보지 않는다.
    if (!completed) throw new ProviderError("AI_INCOMPLETE", "완료 이벤트(response.completed) 없이 스트림이 끝났습니다.", { requestId, streamStarted: started });
    const text = parts.join("");
    if (!text) throw new ProviderError("AI_INCOMPLETE", "완료되었지만 받은 텍스트가 없습니다.", { requestId, streamStarted: true });
    return { text, terminal_event: "response.completed", output_mode: useSchema ? "json_schema" : "text_json", model_slug: model, provider_request_id: requestId, usage };
  }
}

// 개발용 모의 공급자: 실제 AI가 아니다. 결과에 output_mode=mock을 남긴다.
export class MockProvider implements Provider {
  mode = "mock" as const;
  structured = "unknown" as const;
  async listModels() {
    return [{ slug: "mock", display_name: "모의 응답(실제 AI 아님)" }];
  }
  async generate(job: ProviderJob): Promise<ProviderResult> {
    await new Promise((r) => setTimeout(r, 400));
    return { text: mockOutput(job.payload), terminal_event: "response.completed", output_mode: "mock", model_slug: "mock", provider_request_id: null, usage: null };
  }
}
