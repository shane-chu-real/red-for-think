// 실행기 인수시험 (지침서 10장): 인증 A01~A05, 추론 I01~I04, 세션 S01~S03, 비용 C01 — 가짜 서버 기준
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockOutput } from "@/core/mock";
import type { RunPayload } from "@/core/prompts";
import type { Job } from "../runner/app-client";
import { handleJob, runLoop } from "../runner/loop";
import { AuthError, getAccessToken, loadCredentials, login, logout, planUsageEnabled, refresh, type Credentials } from "../runner/oauth";
import { ChatGPTSubscriptionProvider, MockProvider, ProviderError } from "../runner/provider";
import { dataDir, hostId, loadSecret, saveSecret } from "../runner/secure-store";
import { startFakeAuth, startFakeResponses } from "./fakes";

let auth: Awaited<ReturnType<typeof startFakeAuth>>;
let ai: Awaited<ReturnType<typeof startFakeResponses>>;
let home: string;

beforeAll(async () => {
  auth = await startFakeAuth();
  ai = await startFakeResponses();
});
afterAll(async () => {
  await auth.close();
  await ai.close();
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rft-runner-"));
  process.env.RFT_RUNNER_HOME = home;
  Object.assign(auth.control, { tamperState: false, tamperNonce: false, wrongKey: false, wrongAudience: false, dropPlanScope: false, subject: "user-1", refreshError: null, refreshDelayMs: 0 });
  auth.seen.authorize.length = 0;
  auth.seen.token.length = 0;
  auth.seen.revoke.length = 0;
  Object.assign(ai.state, { scenario: "ok", text: '{"reply":"OK"}', calls: 0 });
  ai.state.bodies.length = 0;
  ai.state.auth.length = 0;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const doLogin = () => login({ issuer: auth.issuer, port: 0, openBrowser: auth.browser, timeoutMs: 10_000 });

const payload: RunPayload = {
  task: "intake",
  role: null,
  prompt_version: "t",
  instructions: "지시",
  input: [{ role: "developer", content: "출력 규칙" }],
  schema_name: "t_result",
  schema: { type: "object", properties: { reply: { type: "string" } }, required: ["reply"], additionalProperties: false },
  context: { note: "맥락" },
  allowed: { claim_ids: [], fact_ids: [], source_ids: [], issue_ids: [], candidate_keys: [], condition_ids: {}, slide_ids: [] },
  plan_version_id: null,
};

function provider(extra: Partial<ConstructorParameters<typeof ChatGPTSubscriptionProvider>[0]> = {}) {
  return new ChatGPTSubscriptionProvider({ getAccessToken: async () => "oauth-access-token", baseURL: ai.baseURL, retryDelaysMs: [10, 10], ...extra });
}

describe("인증", () => {
  it("A01 최초 로그인: 동적 등록으로 시작하고 발급받은 client ID를 저장한다", async () => {
    const creds = await doLogin();
    const req = auth.seen.authorize[0];
    expect(req.client_id).toBe("dynamic_agent_client");
    expect(req.agent_name_hint).toBeTruthy();
    expect(req.ext_agent_host_id).toMatch(/^urn:uuid:/);
    expect(req.response_type).toBe("code");
    expect(req.resource).toBe("https://api.openai.com/v1");
    expect(req.scope).toBe("openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
    expect(req.code_challenge_method).toBe("S256");
    expect(req.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/); // localhost로 바꾸지 않는다
    expect(creds.registration.client_id).toBe(auth.ISSUED);
    expect(creds.registration.client_id).not.toBe("dynamic_agent_client");
    // 코드 교환은 발급 ID로 하고 client secret을 보내지 않는다
    expect(auth.seen.token[0].client_id).toBe(auth.ISSUED);
    expect(auth.seen.token[0].client_secret).toBeUndefined();
    expect(planUsageEnabled(loadCredentials())).toBe(true);
  });

  it("A02 재로그인: 같은 host ID와 발급 client ID를 다시 쓴다", async () => {
    const first = await doLogin();
    const second = await doLogin();
    expect(auth.seen.authorize[1].client_id).toBe(auth.ISSUED);
    expect(auth.seen.authorize[1].agent_name_hint).toBeUndefined();
    expect(auth.seen.authorize[1].ext_agent_host_id).toBe(auth.seen.authorize[0].ext_agent_host_id);
    expect(auth.seen.authorize[1].id_token_hint).toBeTruthy();
    expect(second.ext_agent_host_id).toBe(first.ext_agent_host_id);
    expect(hostId()).toBe(first.ext_agent_host_id); // 재시작해도 유지되는 값
    expect(auth.seen.authorize[0].state).not.toBe(auth.seen.authorize[1].state); // 시도마다 새 state·nonce
    expect(auth.seen.authorize[0].nonce).not.toBe(auth.seen.authorize[1].nonce);
  });

  it("A03 state·nonce·서명·audience가 변조되면 거절하고 기존 정상 토큰을 덮어쓰지 않는다", async () => {
    const good = await doLogin();
    const cases: [keyof typeof auth.control, string][] = [
      ["tamperState", "STATE_MISMATCH"],
      ["tamperNonce", "ID_TOKEN_INVALID"],
      ["wrongKey", "ID_TOKEN_INVALID"],
      ["wrongAudience", "ID_TOKEN_INVALID"],
    ];
    for (const [flag, code] of cases) {
      Object.assign(auth.control, { tamperState: false, tamperNonce: false, wrongKey: false, wrongAudience: false, [flag]: true });
      await expect(doLogin()).rejects.toMatchObject({ code });
      expect(loadCredentials()!.tokens!.access_token).toBe(good.tokens!.access_token);
    }
  });

  it("A04 플랜 사용 권한이 없으면 '로그인됨 / AI 플랜 사용 비활성'으로 구분한다", async () => {
    auth.control.dropPlanScope = true;
    const creds = await doLogin();
    expect(creds.tokens).not.toBeNull();
    expect(planUsageEnabled(creds)).toBe(false);
  });

  it("A05 다른 계정으로 재로그인하면 기존 등록과 섞지 않는다", async () => {
    const good = await doLogin();
    auth.control.subject = "user-2";
    await expect(doLogin()).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    const kept = loadCredentials()!;
    expect(kept.registration.subject).toBe("user-1");
    expect(kept.tokens!.access_token).toBe(good.tokens!.access_token);
  });
});

function expire() {
  const c = loadSecret<Credentials>("credentials")!;
  saveSecret("credentials", { ...c, tokens: { ...c.tokens!, expires_at: new Date(Date.now() - 1000).toISOString() } });
}

describe("세션", () => {
  it("S01 갱신은 직렬화되고 회전된 refresh token을 함께 저장한다", async () => {
    const first = await doLogin();
    expire();
    auth.control.refreshDelayMs = 150;
    const [a, b] = await Promise.all([getAccessToken({ issuer: auth.issuer }), getAccessToken({ issuer: auth.issuer })]);
    expect(a).toBe(b);
    const refreshCalls = auth.seen.token.filter((t) => t.grant_type === "refresh_token");
    expect(refreshCalls.length).toBe(1); // 동시에 두 번 갱신하지 않는다
    expect(refreshCalls[0].scope).toBeUndefined(); // 갱신에는 scope를 보내지 않는다
    expect(refreshCalls[0].client_id).toBe(auth.ISSUED);
    expect(refreshCalls[0].resource).toBe("https://api.openai.com/v1");
    const now = loadCredentials()!;
    expect(now.tokens!.access_token).toBe(a);
    expect(now.tokens!.refresh_token).not.toBe(first.tokens!.refresh_token);
    expect(now.tokens!.scopes).toContain("chatgpt.tokens.use.direct"); // 권한 정보는 유지
  });

  it("S02 확정된 무효 토큰이면 토큰만 지우고 재로그인 상태로 전환한다. 일시 오류는 자격 증명을 지우지 않는다", async () => {
    await doLogin();
    expire();
    auth.control.refreshError = "server_error";
    await expect(refresh({ issuer: auth.issuer })).rejects.toMatchObject({ code: "REFRESH_TEMPORARY" });
    expect(loadCredentials()!.tokens).not.toBeNull();

    auth.control.refreshError = "invalid_grant";
    await expect(refresh({ issuer: auth.issuer })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    const after = loadCredentials()!;
    expect(after.tokens).toBeNull();
    expect(after.registration.client_id).toBe(auth.ISSUED); // 저장한 client ID로 재인증
    await expect(getAccessToken({ issuer: auth.issuer })).rejects.toBeInstanceOf(AuthError);
  });

  it("S02 로그아웃은 원격 철회와 로컬 삭제를 구분해 알려 준다", async () => {
    const creds = await doLogin();
    const r = await logout({ issuer: auth.issuer });
    expect(r).toMatchObject({ local: "deleted", remote: "revoked" });
    expect(auth.seen.revoke[0]).toEqual({ token: creds.tokens!.refresh_token, token_type_hint: "refresh_token", client_id: auth.ISSUED });
    expect(loadCredentials()).toBeNull();
  });

  it("S03 저장 파일과 로그에 토큰 원문이 없다", async () => {
    const lines: string[] = [];
    const creds = await login({ issuer: auth.issuer, port: 0, openBrowser: auth.browser, log: (l) => lines.push(l) });
    const secrets = [creds.tokens!.access_token, creds.tokens!.refresh_token, creds.tokens!.id_token];
    const files = fs.readdirSync(dataDir()).map((f) => fs.readFileSync(path.join(dataDir(), f), "utf8"));
    for (const s of secrets) {
      expect(files.some((f) => f.includes(s))).toBe(false);
      expect(lines.some((l) => l.includes(s))).toBe(false);
    }
    if (process.platform === "win32") expect(files.some((f) => f.includes('"scheme":"dpapi"'))).toBe(true);
  });
});

describe("추론", () => {
  it("I01 정상 요청: 완료 이벤트를 확인한 뒤에만 성공한다 (필수 조건·미지원 필드 확인)", async () => {
    const p = provider();
    const r = await p.generate({ payload, model_slug: null });
    expect(r).toMatchObject({ text: '{"reply":"OK"}', terminal_event: "response.completed", output_mode: "json_schema", model_slug: "gpt-test", provider_request_id: "req_test_123" });
    const body = ai.state.bodies[0];
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("지시");
    for (const k of ["temperature", "top_p", "max_output_tokens", "truncation", "metadata", "user", "background", "conversation", "previous_response_id"]) expect(body[k]).toBeUndefined();
    // system 역할 없이 developer(출력 규칙) + user(맥락)로 보낸다
    expect((body.input as { role: string }[]).map((m) => m.role)).toEqual(["developer", "user"]);
    expect((body.input as { content: string }[])[1].content).toContain("맥락");
    expect(ai.state.auth.every((a) => a === "Bearer oauth-access-token")).toBe(true);
    expect(p.structured).toBe("supported");
    // 목록에 보이는 모델만 쓴다
    expect((await p.listModels()).map((m) => m.slug)).toEqual(["gpt-test"]);
    await expect(p.generate({ payload, model_slug: "internal" })).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
  });

  it("I02 delta 뒤에 스트림이 끊기면 부분 답변을 성공으로 처리하지 않는다", async () => {
    ai.state.scenario = "cut_after_delta";
    await expect(provider().generate({ payload, model_slug: null })).rejects.toMatchObject({ code: "AI_INCOMPLETE" });
    ai.state.scenario = "incomplete";
    await expect(provider().generate({ payload, model_slug: null })).rejects.toMatchObject({ code: "AI_INCOMPLETE" });
    expect(ai.state.calls).toBe(2); // 스트림이 시작된 요청은 자동으로 다시 보내지 않는다
  });

  it("I03 스트림 도중 한도 오류가 오면 완료로 처리하지 않고 한도 오류로 보고한다", async () => {
    ai.state.scenario = "failed_limit";
    const err = await provider()
      .generate({ payload, model_slug: null })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("USAGE_LIMIT");
    expect(err.detail.streamStarted).toBe(true);
    expect(ai.state.calls).toBe(1);
  });

  it("I04 미지원 기능은 조용히 버리지 않는다: 구조화 출력이 거절되면 기록하고 JSON 텍스트 방식으로 바꾼다", async () => {
    ai.state.scenario = "reject_text_format";
    const changes: string[] = [];
    const p = provider({ onStructuredChange: (s) => changes.push(s) });
    const r = await p.generate({ payload, model_slug: null });
    expect(r.output_mode).toBe("text_json");
    expect(changes).toEqual(["unsupported"]);
    expect(ai.state.bodies[0].text).toBeTruthy();
    expect(ai.state.bodies[1].text).toBeUndefined();
    // 다음 요청부터는 거절된 필드를 보내지 않는다
    await p.generate({ payload, model_slug: null });
    expect(ai.state.bodies[2].text).toBeUndefined();
  });

  it("한도·자격 오류는 원인별로 구분하고, 일시 오류만 제한적으로 다시 시도한다", async () => {
    ai.state.scenario = "http_429";
    await expect(provider().generate({ payload, model_slug: null })).rejects.toMatchObject({ code: "USAGE_LIMIT" });
    expect(ai.state.calls).toBe(1);
    Object.assign(ai.state, { scenario: "http_403_not_eligible", calls: 0 });
    await expect(provider().generate({ payload, model_slug: null })).rejects.toMatchObject({ code: "PLAN_NOT_ELIGIBLE" });
    expect(ai.state.calls).toBe(1);
    Object.assign(ai.state, { scenario: "http_503_once", calls: 0 });
    const r = await provider().generate({ payload, model_slug: null });
    expect(r.terminal_event).toBe("response.completed");
    expect(ai.state.calls).toBe(2);
  });
});

describe("실행기 루프와 비용", () => {
  const job = (): Job => ({ run_id: "r1", request_key: "run:r1:1", project_id: "p1", task: "intake", role: null, model_slug: null, lease_expires_at: "", payload: { ...payload, context: { batch_no: 2, project: { idea: "x" } } } });

  it("C01 한도·인증 오류 때 다른 유료 경로를 호출하지 않고 멈춘다", async () => {
    ai.state.scenario = "http_429";
    const hosts = new Set<string>();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      hosts.add(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host);
      return realFetch(input, init);
    }) as typeof fetch;
    const calls = { complete: 0, fail: [] as Record<string, unknown>[], claim: 0 };
    const ctrl = new AbortController();
    const lines: string[] = [];
    // 멈춘 뒤에도 한동안 돌려 보고(작업을 더 가져가지 않는지 확인) 종료한다.
    setTimeout(() => ctrl.abort(), 400);
    try {
      await runLoop({
        app: {
          heartbeat: async () => ({ runner_id: "x", model_slug: null, paused: "USAGE_LIMIT" }),
          claim: async () => {
            calls.claim += 1;
            if (calls.claim > 1) ctrl.abort();
            return calls.claim === 1 ? { status: "claimed", job: job() } : { status: "idle" };
          },
          complete: async () => (calls.complete++, { status: "succeeded" }),
          fail: async (_id: string, body: unknown) => (calls.fail.push(body as Record<string, unknown>), { status: "recorded" }),
        },
        provider: provider(),
        status: () => ({}),
        log: (l) => lines.push(l),
        signal: ctrl.signal,
        pollMs: 5,
        heartbeatMs: 20,
      });
    } finally {
      globalThis.fetch = realFetch;
      ctrl.abort();
    }
    expect(calls.complete).toBe(0);
    expect(calls.fail[0]).toMatchObject({ error_code: "USAGE_LIMIT", request_key: "run:r1:1" });
    expect(calls.claim).toBe(1);
    expect([...hosts]).toEqual([new URL(ai.baseURL).host]); // 가짜 AI 서버 외의 호스트로 나간 요청이 0건
    expect(lines.some((l) => l.includes("AI 요청을 멈췄습니다"))).toBe(true);
  });

  it("모의 공급자는 결과에 mock 표시를 남긴다", async () => {
    const sent: Record<string, unknown>[] = [];
    await handleJob(job(), {
      app: { heartbeat: async () => ({ runner_id: "x", model_slug: null, paused: null }), claim: async () => ({ status: "idle" }), complete: async (_i: string, b: unknown) => (sent.push(b as Record<string, unknown>), { status: "succeeded" }), fail: async () => ({ status: "recorded" }) },
      provider: new MockProvider(),
      log: () => undefined,
      signal: new AbortController().signal,
    });
    expect(sent[0]).toMatchObject({ output_mode: "mock", terminal_event: "response.completed", request_key: "run:r1:1" });
    expect(sent[0].text).toBe(mockOutput(job().payload));
  });
});
