// AI 작업 대기열: 실행기가 가져가고(claim) 결과를 제출한다(complete/fail). AI 호출 자체는 서버가 하지 않는다.
import type { Task } from "@/core/constants";
import type { RunPayload } from "@/core/prompts";
import { applyRunCorrection, applyRunFailure, applyRunSuccess, validateRunOutput } from "@/core/results";
import type { ProjectState } from "@/core/types";
import type { Db, Queryable } from "./db";
import { iso, makeCtx, persist } from "./service";
import { getSetting, setSetting } from "./settings";

export const LEASE_MINUTES = 10;

export function caps() {
  return {
    perProject: Number(process.env.AI_CAP_PER_PROJECT ?? 100),
    perDay: Number(process.env.AI_CAP_PER_DAY ?? 200),
  };
}

// 한국 시간 기준 날짜
export function kstDay(now = new Date()): string {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function counter(q: Queryable, scope: string): Promise<number> {
  return (await q.query("select count from usage_counters where scope = $1", [scope])).rows[0]?.count ?? 0;
}

async function bump(q: Queryable, scope: string) {
  await q.query("insert into usage_counters(scope, count) values ($1, 1) on conflict (scope) do update set count = usage_counters.count + 1", [scope]);
}

// 임대 시간이 지난 작업은 실패로 표시한다. 이미 시작된 요청의 중복 사용을 피하려고 자동으로 다시 넣지 않는다.
export async function expireLeases(db: Db): Promise<number> {
  const { rows } = await db.query("select run_id from ai_runs where status = 'claimed' and lease_expires_at < now()");
  let n = 0;
  for (const r of rows) {
    const done = await db.tx(async (q) => {
      const run = (await q.query("select * from ai_runs where run_id = $1 for update", [r.run_id])).rows[0];
      if (!run || run.status !== "claimed" || new Date(run.lease_expires_at).getTime() > Date.now()) return false;
      await markFailed(q, run, "LEASE_EXPIRED", "실행기가 제한 시간 안에 결과를 보내지 않았습니다.", null);
      return true;
    });
    if (done) n += 1;
  }
  return n;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function markFailed(q: Queryable, run: any, code: string, message: string, body: { http_status?: number; provider_request_id?: string } | null) {
  const ctx = makeCtx();
  await q.query(
    "update ai_runs set status = 'failed', error_code = $2, error_message = $3, provider_request_id = coalesce($4, provider_request_id), finished_at = $5 where run_id = $1",
    [run.run_id, code, message.slice(0, 500), body?.provider_request_id ?? null, ctx.now],
  );
  const proj = (await q.query("select state, state_version from projects where project_id = $1 for update", [run.project_id])).rows[0];
  if (!proj) return;
  const res = applyRunFailure(proj.state as ProjectState, run.run_id, code, message, ctx);
  if (res.state === proj.state) return;
  await persist(q, { beforeVersion: proj.state_version, res, action: `RUN_FAILED:${run.task}`, requestKey: `${run.request_key}:fail:${code}`, actor: "runner", reason: code, now: ctx.now });
}

export type ClaimResult =
  | { status: "idle" }
  | { status: "paused"; reason: string }
  | { status: "cap_reached"; message: string }
  | {
      status: "claimed";
      job: {
        run_id: string;
        request_key: string;
        project_id: string;
        task: Task;
        role: string | null;
        model_slug: string | null;
        lease_expires_at: string;
        payload: RunPayload;
      };
    };

export async function claimRun(db: Db, runnerId: string): Promise<ClaimResult> {
  await expireLeases(db);
  const paused = await getSetting<{ paused: boolean; reason: string }>(db, "ai_paused");
  if (paused?.paused) return { status: "paused", reason: paused.reason };

  for (let i = 0; i < 20; i++) {
    const out = await db.tx(async (q): Promise<ClaimResult | "again"> => {
      const run = (await q.query("select * from ai_runs where status = 'queued' order by created_at limit 1 for update skip locked")).rows[0];
      if (!run) return { status: "idle" };
      const proj = (await q.query("select state from projects where project_id = $1", [run.project_id])).rows[0];
      const state = proj?.state as ProjectState | undefined;
      const pending = state?.pending_runs.find((r) => r.run_id === run.run_id && r.status === "queued");
      const planMoved = run.plan_version_id && run.plan_version_id !== state?.plan.current?.plan_version_id;
      if (!state || !pending || planMoved) {
        // 기준 기획이 이미 바뀐 작업은 AI를 호출하지 않고 넘긴다.
        await q.query("update ai_runs set status = 'superseded', finished_at = now(), error_code = 'SUPERSEDED' where run_id = $1", [run.run_id]);
        return "again";
      }
      const limit = caps();
      const day = `day:${kstDay()}`;
      const proj_scope = `project:${run.project_id}`;
      if ((await counter(q, day)) >= limit.perDay) return { status: "cap_reached", message: `오늘 AI 호출 상한(${limit.perDay}회)에 도달했습니다.` };
      if ((await counter(q, proj_scope)) >= limit.perProject) {
        return { status: "cap_reached", message: `이 프로젝트의 AI 호출 상한(${limit.perProject}회)에 도달했습니다.` };
      }
      await bump(q, day);
      await bump(q, proj_scope);
      const attempts = run.attempts + 1;
      const requestKey = `run:${run.run_id}:${attempts}`;
      const upd = (
        await q.query(
          `update ai_runs set status = 'claimed', attempts = $2, request_key = $3, runner_id = $4, claimed_at = now(),
           lease_expires_at = now() + interval '${LEASE_MINUTES} minutes' where run_id = $1 returning lease_expires_at`,
          [run.run_id, attempts, requestKey, runnerId],
        )
      ).rows[0];
      const model = await getSetting<string>(q, "model_slug");
      return {
        status: "claimed",
        job: {
          run_id: run.run_id,
          request_key: requestKey,
          project_id: run.project_id,
          task: run.task,
          role: run.role,
          model_slug: model ?? null,
          lease_expires_at: iso(upd.lease_expires_at),
          payload: run.payload as RunPayload,
        },
      };
    });
    if (out !== "again") return out;
  }
  return { status: "idle" };
}

export interface CompleteBody {
  request_key: string;
  terminal_event: string;
  text: string;
  output_mode: string;
  model_slug?: string | null;
  provider_request_id?: string | null;
  usage?: unknown;
}

export type CompleteResult = { status: "succeeded" | "superseded" | "invalid" | "duplicate" | "rejected"; errors?: string[]; message?: string };

export async function completeRun(db: Db, runnerId: string, runId: string, body: CompleteBody): Promise<CompleteResult> {
  return db.tx(async (q) => {
    const run = (await q.query("select * from ai_runs where run_id = $1 for update", [runId])).rows[0];
    if (!run) return { status: "rejected", message: "없는 작업입니다." };
    if (run.runner_id !== runnerId) return { status: "rejected", message: "이 실행기가 가져간 작업이 아닙니다." };
    // 호출 도중 사용자가 마무리 등으로 작업을 취소했다: 늦게 온 응답은 보존만 하고 적용하지 않는다.
    if (run.status === "cancelled" && body.request_key === run.request_key && !run.result_text) {
      await q.query(
        "update ai_runs set status = 'superseded', result_text = $2, output_mode = $3, model_slug = $4, provider_request_id = $5, error_code = 'SUPERSEDED' where run_id = $1",
        [runId, body.text, body.output_mode, body.model_slug ?? null, body.provider_request_id ?? null],
      );
      return { status: "superseded" };
    }
    // 이미 끝난 작업에 같은 결과가 다시 와도 한 번만 반영한다.
    if (run.status !== "claimed") return { status: "duplicate", message: `이미 처리된 작업입니다(${run.status}).` };
    if (body.request_key !== run.request_key) return { status: "rejected", message: "오래된 시도의 결과입니다." };
    // 완료 이벤트가 없는 응답은 성공으로 받지 않는다.
    if (body.terminal_event !== "response.completed" && body.output_mode !== "mock") {
      return { status: "rejected", message: "완료 이벤트(response.completed)가 확인되지 않은 결과입니다." };
    }
    const ctx = makeCtx();
    const proj = (await q.query("select state, state_version from projects where project_id = $1 for update", [run.project_id])).rows[0];
    const state = proj.state as ProjectState;
    const meta = [body.text, body.output_mode, body.model_slug ?? null, body.provider_request_id ?? null, body.usage ? JSON.stringify(body.usage) : null, ctx.now];
    const pending = state.pending_runs.find((r) => r.run_id === run.run_id);
    const planMoved = run.plan_version_id && run.plan_version_id !== state.plan.current?.plan_version_id;
    if (!pending || planMoved) {
      // 그사이 기획이 바뀌었다: 결과는 보존하되 현재 상태에 적용하지 않는다.
      await q.query(
        "update ai_runs set status = 'superseded', result_text = $2, output_mode = $3, model_slug = $4, provider_request_id = $5, usage = $6, finished_at = $7, error_code = 'SUPERSEDED' where run_id = $1",
        [runId, ...meta],
      );
      return { status: "superseded" };
    }
    const payload = run.payload as RunPayload;
    const checked = validateRunOutput(run.task as Task, body.text, payload, state);
    if (!checked.ok) {
      await q.query(
        "update ai_runs set status = 'failed', result_text = $2, output_mode = $3, model_slug = $4, provider_request_id = $5, usage = $6, finished_at = $7, error_code = 'AI_SCHEMA_ERROR', error_message = $8 where run_id = $1",
        [runId, ...meta, checked.errors.slice(0, 5).join(" / ").slice(0, 500)],
      );
      const res = applyRunCorrection(state, runId, checked.errors, body.text, ctx);
      await persist(q, { beforeVersion: proj.state_version, res, action: `RUN_INVALID:${run.task}`, requestKey: `${run.request_key}:invalid`, actor: "runner", reason: "AI_SCHEMA_ERROR", now: ctx.now });
      return { status: "invalid", errors: checked.errors };
    }
    const res = applyRunSuccess(state, runId, run.task as Task, checked.value, ctx);
    await persist(q, { beforeVersion: proj.state_version, res, action: `RUN_RESULT:${run.task}`, requestKey: run.request_key, actor: "runner", now: ctx.now });
    await q.query(
      "update ai_runs set status = 'succeeded', result_text = $2, output_mode = $3, model_slug = $4, provider_request_id = $5, usage = $6, finished_at = $7, result_json = $8 where run_id = $1",
      [runId, ...meta, JSON.stringify(checked.value)],
    );
    return { status: "succeeded" };
  });
}

export interface FailBody {
  request_key: string;
  error_code: string;
  message: string;
  http_status?: number;
  provider_request_id?: string;
  retryable?: boolean;
}

export async function failRun(db: Db, runnerId: string, runId: string, body: FailBody): Promise<{ status: "recorded" | "duplicate" | "rejected"; message?: string }> {
  return db.tx(async (q) => {
    const run = (await q.query("select * from ai_runs where run_id = $1 for update", [runId])).rows[0];
    if (!run) return { status: "rejected", message: "없는 작업입니다." };
    if (run.runner_id !== runnerId) return { status: "rejected", message: "이 실행기가 가져간 작업이 아닙니다." };
    if (run.status !== "claimed") return { status: "duplicate" };
    if (body.request_key !== run.request_key) return { status: "rejected", message: "오래된 시도의 결과입니다." };
    const code = String(body.error_code || "AI_ERROR").slice(0, 60);
    await markFailed(q, run, code, String(body.message || "AI 호출에 실패했습니다."), body);
    if (["USAGE_LIMIT", "PLAN_NOT_ELIGIBLE", "REAUTH_REQUIRED", "SCOPE_NOT_AUTHORIZED"].includes(code)) {
      // 한도·자격·인증 문제는 새 요청을 멈춘다. 유료 경로로 넘어가지 않는다.
      await setSetting(q, "ai_paused", { paused: true, reason: `${code}: ${body.message}`.slice(0, 300), at: new Date().toISOString() });
    }
    return { status: "recorded" };
  });
}
