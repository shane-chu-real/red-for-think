// 실행기 루프: 상태 보고 → 작업 1건 가져오기 → AI 호출 → 결과 제출. 동시 실행은 1건이다.
import { AppError, type AppClient, type Job } from "./app-client";
import { ProviderError, type Provider } from "./provider";

export const RUNNER_VERSION = "0.1.0";
// 한도·자격·인증 문제는 사용자가 확인할 때까지 새 요청을 멈춘다. 다른 유료 경로로 넘어가지 않는다.
const STOP_CODES = new Set(["USAGE_LIMIT", "PLAN_NOT_ELIGIBLE", "REAUTH_REQUIRED", "SCOPE_NOT_AUTHORIZED"]);

export interface LoopDeps {
  app: Pick<AppClient, "heartbeat" | "claim" | "complete" | "fail">;
  provider: Provider;
  status: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  log: (line: string) => void;
  signal: AbortSignal;
  pollMs?: number;
  heartbeatMs?: number;
  dailyCap?: number;
  usedToday?: () => number;
  countRun?: () => void;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

async function submit<T>(fn: () => Promise<T>, log: (l: string) => void, signal: AbortSignal): Promise<T | null> {
  // 이미 AI 사용량을 쓴 결과를 잃지 않도록 제출은 몇 번 다시 시도한다(서버는 같은 결과를 한 번만 반영한다).
  for (let i = 0; i < 5; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AppError && e.code !== "NETWORK" && e.code !== "STORAGE_ERROR") throw e;
      log(`결과 제출 실패, 다시 시도합니다(${i + 1}/5).`);
      await sleep(3000 * (i + 1), signal);
    }
  }
  return null;
}

export async function handleJob(job: Job, deps: Pick<LoopDeps, "app" | "provider" | "log" | "signal">): Promise<{ stop: string | null }> {
  const { app, provider, log, signal } = deps;
  const label = `${job.task}${job.role ? `:${job.role}` : ""}`;
  log(`작업 시작: ${label}`);
  try {
    const result = await provider.generate({ payload: job.payload, model_slug: job.model_slug });
    const res = await submit(
      () =>
        app.complete(job.run_id, {
          request_key: job.request_key,
          terminal_event: result.terminal_event,
          text: result.text,
          output_mode: result.output_mode,
          model_slug: result.model_slug,
          provider_request_id: result.provider_request_id,
          usage: result.usage,
        }),
      log,
      signal,
    );
    log(`작업 완료: ${label} → ${res?.status ?? "제출 실패"}${res?.status === "invalid" ? ` (형식 오류: ${res.errors?.slice(0, 2).join(" / ")})` : ""}`);
    return { stop: null };
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError("AI_ERROR", e instanceof Error ? e.message : String(e));
    log(`작업 실패: ${label} → ${pe.code} ${pe.message}`);
    await submit(
      () =>
        app.fail(job.run_id, {
          request_key: job.request_key,
          error_code: pe.code,
          message: pe.message,
          http_status: pe.detail.httpStatus,
          provider_request_id: pe.detail.requestId ?? undefined,
          retryable: Boolean(pe.detail.retryable),
        }),
      log,
      signal,
    ).catch(() => null);
    return { stop: STOP_CODES.has(pe.code) ? pe.code : null };
  }
}

export async function runLoop(deps: LoopDeps): Promise<void> {
  const { app, log, signal } = deps;
  const poll = deps.pollMs ?? 4000;
  const beatEvery = deps.heartbeatMs ?? 30_000;
  let lastBeat = 0;
  let stopped: string | null = null;
  let lastNote = "";
  const say = (line: string) => {
    if (line !== lastNote) log(line);
    lastNote = line;
  };

  while (!signal.aborted) {
    try {
      if (Date.now() - lastBeat >= beatEvery) {
        const beat = await app.heartbeat({ ...(await deps.status()), message: stopped ? `일시정지: ${stopped}` : null });
        lastBeat = Date.now();
        // 사용자가 설정 화면에서 '다시 진행'을 누르면 서버의 일시정지가 풀린다.
        if (stopped && !beat.paused) {
          log("일시정지가 해제되어 다시 진행합니다.");
          stopped = null;
        }
      }
      if (stopped) {
        say(`AI 요청을 멈췄습니다(${stopped}). 원인을 확인한 뒤 웹앱 설정에서 '다시 진행'을 눌러 주세요.`);
        await sleep(beatEvery, signal);
        continue;
      }
      if (deps.dailyCap !== undefined && deps.usedToday && deps.usedToday() >= deps.dailyCap) {
        say(`실행기 하루 상한(${deps.dailyCap}회)에 도달했습니다. 내일 다시 진행합니다.`);
        await sleep(60_000, signal);
        continue;
      }
      const claim = await app.claim();
      if (claim.status === "claimed") {
        lastNote = "";
        deps.countRun?.();
        const r = await handleJob(claim.job, deps);
        if (r.stop) stopped = r.stop;
        lastBeat = 0; // 결과 직후 상태를 바로 보고한다
        continue;
      }
      if (claim.status === "paused") say(`서버가 AI 요청을 일시정지했습니다: ${claim.reason}`);
      else if (claim.status === "cap_reached") say(claim.message);
      else say("대기 중인 작업이 없습니다. 새 작업을 기다립니다.");
      await sleep(claim.status === "idle" ? poll : 30_000, signal);
    } catch (e) {
      if (e instanceof AppError && e.code === "UNAUTHORIZED") {
        log("실행기 등록이 해제되었거나 토큰이 유효하지 않습니다. 설정 화면에서 다시 연결(pair)해 주세요.");
        return;
      }
      say(`오류: ${e instanceof Error ? e.message : e} — 잠시 뒤 다시 시도합니다.`);
      await sleep(10_000, signal);
    }
  }
}
