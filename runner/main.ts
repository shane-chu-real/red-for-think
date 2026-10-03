// 로컬 AI 실행기 CLI — npm run runner -- <pair|login|logout|status|models|test|start> [--mock]
import readline from "node:readline/promises";
import { AppClient, AppError, loadConnection, pair } from "./app-client";
import { RUNNER_VERSION, runLoop } from "./loop";
import { AuthError, getAccessToken, loadCredentials, login, logout, planUsageEnabled } from "./oauth";
import { ChatGPTSubscriptionProvider, MockProvider, ProviderError, type Provider } from "./provider";
import { dataDir, hostId, loadPlain, savePlain } from "./secure-store";

const log = (line: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${line}`);

interface RunnerPrefs {
  structured_output?: "unknown" | "supported" | "unsupported";
  daily_cap?: number;
  usage?: { day: string; count: number };
}

function prefs(): RunnerPrefs {
  return loadPlain<RunnerPrefs>("prefs") ?? {};
}

function today(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function chatgptProvider(): ChatGPTSubscriptionProvider {
  return new ChatGPTSubscriptionProvider({
    getAccessToken: () => getAccessToken(),
    structured: prefs().structured_output ?? "unknown",
    onStructuredChange: (s) => {
      savePlain("prefs", { ...prefs(), structured_output: s });
      log(s === "supported" ? "구조화 출력(text.format)이 이 경로에서 동작합니다." : "구조화 출력(text.format)이 이 경로에서 거절되었습니다. JSON 텍스트 방식으로 받고 서버에서 검증합니다(호환성 차이로 기록).");
    },
  });
}

async function cmdPair(arg?: string) {
  let text = arg;
  if (!text) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    text = await rl.question("웹앱 설정 화면에서 발급한 연결 문자열을 붙여 넣고 Enter: ");
    rl.close();
  }
  const conn = await pair(text);
  log(`연결 완료: ${conn.url} (실행기 ID ${conn.runner_id.slice(0, 8)}). 연결 정보는 보호 저장소에 저장했습니다.`);
  log("다음: npm run runner -- login (ChatGPT 플랜) 또는 npm run runner -- start --mock (모의 모드)");
}

async function cmdLogin() {
  const creds = await login({ log });
  const t = creds.tokens!;
  log(`로그인 완료: ${creds.registration.email ?? "(이메일 없음)"} · 발급 client ID 저장됨 · host ID ${creds.ext_agent_host_id}`);
  log(`허가된 권한: ${t.scopes.join(" ")}`);
  if (planUsageEnabled(creds)) log("플랜 사용 권한이 확인되었습니다. npm run runner -- test 로 실요청 1건을 시험할 수 있습니다.");
  else log("로그인은 되었지만 플랜 사용 권한(chatgpt.tokens.use.direct)이 없습니다 → '로그인됨 / AI 플랜 사용 비활성'. 추론은 하지 않습니다.");
}

async function cmdLogout() {
  const r = await logout();
  log(`로컬: ${r.local === "deleted" ? "토큰 삭제됨" : "저장된 로그인 없음"} · 원격: ${{ revoked: "세션 철회됨", failed: "철회 확인 실패", skipped: "해당 없음" }[r.remote]}`);
  if (r.detail) log(r.detail);
}

function statusObject(provider: Provider, models: { slug: string; display_name: string }[]) {
  const creds = loadCredentials();
  return {
    mode: provider.mode,
    signed_in: Boolean(creds?.tokens),
    plan_usage_enabled: provider.mode === "mock" ? false : planUsageEnabled(creds),
    account_label: creds?.registration.email ?? null,
    models,
    structured_output: provider.structured,
    version: RUNNER_VERSION,
  };
}

function cmdStatus() {
  const conn = loadConnection();
  const creds = loadCredentials();
  log(`저장 위치: ${dataDir()}`);
  log(`host ID: ${hostId()}`);
  log(conn ? `웹앱 연결: ${conn.url} (배포 보호 우회 값 ${conn.bypass ? "있음" : "없음"}, 연결 ${conn.paired_at})` : "웹앱 연결: 없음 → runner pair");
  if (!creds) log("ChatGPT: 로그인 정보 없음 → runner login");
  else if (!creds.tokens) log(`ChatGPT: 재로그인 필요 (등록 계정 ${creds.registration.email ?? creds.registration.subject})`);
  else log(`ChatGPT: 로그인됨 (${creds.registration.email ?? "이메일 없음"}) · 플랜 사용 ${planUsageEnabled(creds) ? "가능" : "비활성"} · access token 만료 ${creds.tokens.expires_at}`);
  log(`구조화 출력 확인: ${prefs().structured_output ?? "unknown"}`);
  // 토큰 값은 어디에도 출력하지 않는다.
}

async function cmdModels() {
  const models = await chatgptProvider().listModels();
  if (!models.length) log("표시할 모델이 없습니다.");
  for (const m of models) log(`${m.slug}  —  ${m.display_name}`);
}

// 텍스트 실요청 1건 (인수시험 I01). 구독 사용량을 소비한다.
async function cmdTest() {
  const creds = loadCredentials();
  if (!planUsageEnabled(creds)) throw new AuthError("NOT_SIGNED_IN", "플랜 사용 권한이 있는 로그인이 필요합니다(runner login).");
  const provider = chatgptProvider();
  const schema = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"], additionalProperties: false };
  const r = await provider.generate({
    model_slug: null,
    payload: {
      task: "intake",
      role: null,
      prompt_version: "test",
      instructions: "지시에 따라 JSON 하나만 출력합니다.",
      input: [{ role: "user", content: `reply 필드에 OK라고만 넣은 JSON을 출력하십시오. 스키마: ${JSON.stringify(schema)}` }],
      schema_name: "connection_test",
      schema,
      context: {},
      allowed: { claim_ids: [], fact_ids: [], source_ids: [], issue_ids: [], candidate_keys: [], condition_ids: {}, slide_ids: [] },
      plan_version_id: null,
    },
  });
  log(`실요청 성공: terminal=${r.terminal_event} · 모델 ${r.model_slug} · 출력 방식 ${r.output_mode} · request ID ${r.provider_request_id ?? "(없음)"}`);
  log(`응답: ${r.text.slice(0, 200)}`);
}

async function cmdStart(mock: boolean) {
  const conn = loadConnection();
  if (!conn) throw new AppError("NOT_PAIRED", "웹앱과 연결되어 있지 않습니다. 먼저 npm run runner -- pair 를 실행해 주세요.");
  const provider: Provider = mock ? new MockProvider() : chatgptProvider();
  let models: { slug: string; display_name: string }[] = [];
  if (mock) {
    log("모의 모드로 시작합니다. 실제 AI 응답이 아니며 결과에 [모의] 표시가 붙습니다.");
    models = await provider.listModels();
  } else {
    const creds = loadCredentials();
    if (!creds?.tokens) log("ChatGPT에 로그인되어 있지 않습니다. 작업은 가져오지 않고 상태만 보고합니다 → runner login");
    else if (!planUsageEnabled(creds)) log("로그인됨 / AI 플랜 사용 비활성: 추론하지 않고 상태만 보고합니다.");
    else models = await provider.listModels().catch((e) => (log(`모델 목록 조회 실패: ${e.message}`), []));
  }
  const ready = mock || planUsageEnabled(loadCredentials());
  const ctrl = new AbortController();
  process.on("SIGINT", () => (log("종료합니다."), ctrl.abort()));
  process.on("SIGTERM", () => ctrl.abort());
  const app = new AppClient(conn);
  log(`실행기 시작 → ${conn.url} · 동시 실행 1건 · Ctrl+C로 종료`);
  if (!ready) {
    // 로그인 전: 화면에 상태만 알리고 작업은 가져가지 않는다.
    while (!ctrl.signal.aborted) {
      await app.heartbeat(statusObject(provider, models)).catch((e) => log(`상태 보고 실패: ${e.message}`));
      await new Promise((r) => setTimeout(r, 30_000));
    }
    return;
  }
  await runLoop({
    app,
    provider,
    status: () => statusObject(provider, models),
    log,
    signal: ctrl.signal,
    dailyCap: prefs().daily_cap ?? 200,
    usedToday: () => (prefs().usage?.day === today() ? prefs().usage!.count : 0),
    countRun: () => {
      const p = prefs();
      savePlain("prefs", { ...p, usage: { day: today(), count: p.usage?.day === today() ? p.usage.count + 1 : 1 } });
    },
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const mock = rest.includes("--mock");
  switch (cmd) {
    case "pair":
      return cmdPair(rest.find((a) => !a.startsWith("--")));
    case "login":
      return cmdLogin();
    case "logout":
      return cmdLogout();
    case "status":
      return cmdStatus();
    case "models":
      return cmdModels();
    case "test":
      return cmdTest();
    case "start":
      return cmdStart(mock);
    default:
      console.log("사용법: npm run runner -- <pair|login|logout|status|models|test|start> [--mock]");
  }
}

main().catch((e) => {
  const code = e instanceof AuthError || e instanceof AppError || e instanceof ProviderError ? e.code : "ERROR";
  console.error(`[${code}] ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
