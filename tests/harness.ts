// 시험 도우미: 내장 Postgres(PGlite) + 서버 함수 + 모의 실행기 루프
import { randomUUID } from "node:crypto";
import type { Task } from "@/core/constants";
import { mockOutput } from "@/core/mock";
import type { RunPayload } from "@/core/prompts";
import type { ProjectState } from "@/core/types";
import { createPgliteDb, migrate, type Db } from "@/server/db";
import { claimRun, completeRun, failRun, type ClaimResult } from "@/server/runs";
import { createPairing, pairRunner } from "@/server/runnerAuth";
import { dispatch, getProject, type Envelope } from "@/server/service";

export type Override = (payload: RunPayload) => unknown | "FAIL";

// existing을 주면 그 DB(이미 스키마가 적용된 것)를 쓰고, 없으면 메모리 PGlite를 새로 만든다.
export async function makeHarness(existing?: Db) {
  const db: Db = existing ?? (await createPgliteDb());
  if (!existing) await migrate(db);
  const pairing = await createPairing(db, "http://localhost:3000");
  const info = JSON.parse(Buffer.from(pairing.connection_string.slice(5), "base64url").toString("utf8"));
  const paired = await pairRunner(db, { code: info.code, label: "test-runner" });
  const runnerId = paired!.runner_id;
  const overrides = new Map<string, Override>();

  async function create(payload: Record<string, unknown>): Promise<string> {
    const res = await dispatch(db, { action: "CREATE_PROJECT", request_key: randomUUID(), payload });
    if (!res.ok) throw new Error(`create failed: ${res.error?.message}`);
    return (res.data as { project_id: string }).project_id;
  }

  async function state(projectId: string): Promise<ProjectState> {
    return (await getProject(db, projectId))!.state;
  }

  async function act(projectId: string, action: string, payload: unknown = {}, requestKey: string = randomUUID()): Promise<Envelope> {
    const p = await getProject(db, projectId);
    return dispatch(db, { project_id: projectId, action, expected_state_version: p!.state_version, request_key: requestKey, payload });
  }

  async function ok(projectId: string, action: string, payload: unknown = {}): Promise<Envelope> {
    const res = await act(projectId, action, payload);
    if (!res.ok) throw new Error(`${action} failed: ${res.error?.code} ${res.error?.message}`);
    return res;
  }

  // 작업별·역할별 응답 바꿔치기: key는 "task" 또는 "task:role"
  function override(key: string, fn: Override) {
    overrides.set(key, fn);
  }

  async function step(): Promise<ClaimResult> {
    const claim = await claimRun(db, runnerId);
    if (claim.status !== "claimed") return claim;
    const { job } = claim;
    const fn = overrides.get(`${job.task}:${job.role}`) ?? overrides.get(job.task);
    const out = fn ? fn(job.payload) : JSON.parse(mockOutput(job.payload));
    if (out === "FAIL") {
      await failRun(db, runnerId, job.run_id, { request_key: job.request_key, error_code: "AI_TEMPORARY", message: "모의 실패", retryable: true });
    } else {
      await completeRun(db, runnerId, job.run_id, {
        request_key: job.request_key,
        terminal_event: "response.completed",
        text: typeof out === "string" ? out : JSON.stringify(out),
        output_mode: "mock",
        model_slug: "mock",
      });
    }
    return claim;
  }

  // 대기열이 빌 때까지 실행기 역할을 한다.
  async function drain(max = 80): Promise<number> {
    let n = 0;
    for (; n < max; n++) {
      const r = await step();
      if (r.status !== "claimed") break;
    }
    return n;
  }

  async function runs(projectId: string, task?: Task) {
    const { rows } = await db.query("select run_id, task, role, status, error_code, result_text from ai_runs where project_id = $1 order by created_at", [projectId]);
    return task ? rows.filter((r) => r.task === task) : rows;
  }

  // 뼈대 확인까지 진행 (1라운드 검토 대기열 생성 상태)
  async function toReview(extra: Record<string, unknown> = {}): Promise<string> {
    const id = await create({ type: "education", idea: "신입사원 300명 대상 AI 에이전트 만들기 2일 교육", problem: "신입의 AI 활용 격차", requested_decision: "교육 과정 승인", audience: "executive", ...extra });
    await drain(); // intake 1
    await ok(id, "ANSWER_INTAKE", { text: "연 300명, 예산은 모름, 임원 보고" });
    await drain(); // intake 2 → outline
    const s = await state(id);
    await ok(id, "CONFIRM_OUTLINE", { draft_id: s.outline_draft!.draft_id });
    return id;
  }

  // 1라운드 검토·정리까지 진행 (WAITING_REPLY)
  async function toReply(extra: Record<string, unknown> = {}): Promise<string> {
    const id = await toReview(extra);
    await drain();
    return id;
  }

  return { db, runnerId, create, state, act, ok, override, step, drain, runs, toReview, toReply };
}
