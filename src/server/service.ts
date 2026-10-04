// 프로젝트 상태 변경의 단일 경로. 한 트랜잭션에서 중복 요청·버전 충돌을 검사하고 상태·스냅샷·이벤트를 함께 저장한다.
import { createHash, randomUUID } from "node:crypto";
import { PROMPT_VERSION } from "@/core/constants";
import { buildRunPayload } from "@/core/prompts";
import { createProject, reduce, type ReducerContext } from "@/core/reducer";
import { parseAction } from "@/core/schemas";
import { unresolvedCritical } from "@/core/state";
import { DomainError, type Effect, type Fact, type PlanContent, type ProjectState, type ReduceResult, type SourceDoc } from "@/core/types";
import type { Db, Queryable } from "./db";

export interface ActionRequest {
  project_id?: string;
  action: string;
  expected_state_version?: number;
  request_key: string;
  payload?: unknown;
}

export interface Envelope {
  ok: boolean;
  state_version?: number;
  data?: unknown;
  duplicate?: boolean;
  error?: { code: string; message: string; retryable: boolean };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function makeCtx(): ReducerContext {
  return { now: new Date().toISOString(), newId: () => randomUUID(), hash: sha256 };
}

export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  }
  return String(v);
}

async function loadSources(q: Queryable, projectId: string): Promise<SourceDoc[]> {
  const { rows } = await q.query("select source_id, title, body, content_hash, char_count, created_at, revision_of from sources where project_id = $1 order by source_id", [projectId]);
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at) }));
}

// 리듀서가 낸 부수효과를 같은 트랜잭션에서 실행한다.
export async function executeEffects(q: Queryable, state: ProjectState, effects: Effect[], now: string) {
  const projectId = state.project_id;
  let sources: SourceDoc[] | null = null;
  for (const e of effects) {
    switch (e.type) {
      case "insert_source":
        await q.query(
          "insert into sources(project_id, source_id, revision_of, title, body, content_hash, char_count, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)",
          [projectId, e.source.source_id, e.source.revision_of, e.source.title, e.source.body, e.source.content_hash, e.source.char_count, e.source.created_at],
        );
        sources = null;
        break;
      case "insert_plan_version":
        await q.query(
          "insert into plan_versions(plan_version_id, project_id, parent_version_id, version_no, content, change_summary, confirmed_at) values ($1,$2,$3,$4,$5,$6,$7)",
          [e.version.plan_version_id, projectId, e.version.parent_version_id, e.version.version_no, JSON.stringify(e.version.content), e.version.change_summary, e.version.confirmed_at],
        );
        break;
      case "enqueue_run": {
        sources ??= await loadSources(q, projectId);
        const payload = buildRunPayload(e.task, e.params, state, sources);
        const inputHash = sha256(JSON.stringify({ instructions: payload.instructions, input: payload.input, context: payload.context }));
        await q.query(
          `insert into ai_runs(run_id, project_id, task, role, status, attempts, request_key, plan_version_id, input_hash, prompt_version, payload, created_at)
           values ($1,$2,$3,$4,'queued',0,$5,$6,$7,$8,$9,$10)`,
          [e.run_id, projectId, e.task, e.params.role ?? null, `run:${e.run_id}:0`, payload.plan_version_id, inputHash, PROMPT_VERSION, JSON.stringify(payload), now],
        );
        break;
      }
      case "cancel_runs":
        await q.query("update ai_runs set status = 'cancelled', finished_at = $2 where run_id = any($1::uuid[]) and status in ('queued','claimed')", [e.run_ids, now]);
        break;
      case "insert_output_snapshot":
        await q.query(
          "insert into output_snapshots(output_snapshot_id, project_id, plan_version_id, source_set, issue_states, decision_status, created_at) values ($1,$2,$3,$4,$5,$6,$7)",
          [e.output_snapshot_id, projectId, e.plan_version_id, JSON.stringify(e.source_set), JSON.stringify(e.issue_states), JSON.stringify(e.decision_status), now],
        );
        break;
      case "insert_artifact":
        await q.query(
          "insert into artifacts(artifact_id, output_snapshot_id, project_id, type, content, validation, unresolved_critical_ids, generated_at) values ($1,$2,$3,$4,$5,$6,$7,$8)",
          [e.artifact_id, e.output_snapshot_id, projectId, e.artifact_type, JSON.stringify(e.content), JSON.stringify(e.validation), JSON.stringify(e.unresolved_critical_ids), now],
        );
        break;
    }
  }
}

// 상태·스냅샷·이벤트를 함께 기록한다(커밋 기준).
export async function persist(
  q: Queryable,
  args: { beforeVersion: number | null; res: ReduceResult; action: string; requestKey: string; actor: string; reason?: string; now: string },
): Promise<number> {
  const { res, now } = args;
  const state = res.state;
  const after = (args.beforeVersion ?? 0) + 1;
  const cols = [
    state.title,
    state.type,
    state.phase,
    state.round,
    after,
    JSON.stringify(state),
    state.plan.current?.plan_version_id ?? null,
    unresolvedCritical(state).length,
    state.end?.reason ?? null,
    now,
  ];
  if (args.beforeVersion === null) {
    await q.query(
      `insert into projects(project_id, title, type, phase, round, state_version, state, current_plan_version_id, unresolved_critical_count, end_reason, created_at, updated_at)
       values ($11,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [...cols, state.project_id],
    );
  } else {
    await q.query(
      `update projects set title=$1, type=$2, phase=$3, round=$4, state_version=$5, state=$6, current_plan_version_id=$7,
       unresolved_critical_count=$8, end_reason=$9, updated_at=$10 where project_id=$11`,
      [...cols, state.project_id],
    );
  }
  // 프로젝트 행이 먼저 있어야 자료·작업·기획 버전을 참조로 넣을 수 있다.
  await executeEffects(q, state, res.effects, now);
  await q.query("insert into state_snapshots(project_id, state_version, state, created_at) values ($1,$2,$3,$4)", [state.project_id, after, JSON.stringify(state), now]);
  await q.query(
    "insert into events(event_id, project_id, action, before_version, after_version, request_key, actor, reason, result, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [randomUUID(), state.project_id, args.action, args.beforeVersion, after, args.requestKey, args.actor, args.reason ?? null, JSON.stringify(res.data ?? null), now],
  );
  return after;
}

function fail(code: string, message: string, retryable = false): Envelope {
  return { ok: false, error: { code, message, retryable } };
}

export function toEnvelopeError(e: unknown): Envelope {
  if (e instanceof DomainError) return fail(e.code, e.message, e.retryable);
  const msg = e instanceof Error ? e.message : String(e);
  if (/허용되지 않은 동작|입력 형식/.test(msg)) return fail("INVALID_INPUT", msg);
  console.error("[storage]", msg);
  return fail("STORAGE_ERROR", "저장 중 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.", true);
}

export async function dispatch(db: Db, req: ActionRequest): Promise<Envelope> {
  if (!req.request_key || typeof req.request_key !== "string" || req.request_key.length > 200) return fail("INVALID_INPUT", "request_key가 필요합니다.");
  let action;
  try {
    action = parseAction(req.action, req.payload);
  } catch (e) {
    return toEnvelopeError(e);
  }
  try {
    return await db.tx(async (q) => {
      const ctx = makeCtx();
      // 1) 중복 요청이면 저장된 결과를 그대로 돌려준다(버전 검사보다 먼저).
      const dup = (await q.query("select project_id, after_version, result from events where request_key = $1", [req.request_key])).rows[0];
      if (dup) {
        const cur = (await q.query("select state_version from projects where project_id = $1", [dup.project_id])).rows[0];
        return { ok: true, state_version: cur?.state_version ?? dup.after_version, data: dup.result, duplicate: true };
      }

      if (action.type === "CREATE_PROJECT") {
        const res = createProject(action.payload, ctx);
        const v = await persist(q, { beforeVersion: null, res, action: action.type, requestKey: req.request_key, actor: "user", now: ctx.now });
        return { ok: true, state_version: v, data: res.data };
      }

      if (!req.project_id) return fail("INVALID_INPUT", "project_id가 필요합니다.");
      if (!/^[0-9a-f-]{36}$/i.test(req.project_id)) return fail("NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
      const row = (await q.query("select state, state_version from projects where project_id = $1 for update", [req.project_id])).rows[0];
      if (!row) return fail("NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
      // 잠금을 기다리는 사이 같은 요청이 먼저 반영되었을 수 있다. 잠금을 얻은 뒤 한 번 더 확인한다.
      const late = (await q.query("select after_version, result from events where request_key = $1", [req.request_key])).rows[0];
      if (late) return { ok: true, state_version: row.state_version, data: late.result, duplicate: true };
      // 2) 화면이 본 버전과 현재 버전이 다르면 갱신을 요청한다.
      if (req.expected_state_version !== row.state_version) {
        return { ...fail("VERSION_CONFLICT", "다른 변경이 먼저 반영되었습니다. 화면을 새로 불러온 뒤 다시 시도해 주세요.", true), state_version: row.state_version };
      }
      const res = reduce(row.state as ProjectState, action, ctx);
      const v = await persist(q, { beforeVersion: row.state_version, res, action: action.type, requestKey: req.request_key, actor: "user", now: ctx.now });
      return { ok: true, state_version: v, data: res.data };
    });
  } catch (e) {
    // 같은 request_key가 동시에 들어와 유니크 제약에 걸린 경우: 먼저 반영된 결과를 돌려준다.
    if (e instanceof Error && /events_request_key_key|duplicate key/.test(e.message)) {
      const dup = (await db.query("select project_id, after_version, result from events where request_key = $1", [req.request_key])).rows[0];
      if (dup) return { ok: true, state_version: dup.after_version, data: dup.result, duplicate: true };
    }
    return toEnvelopeError(e);
  }
}

export async function listProjects(db: Db) {
  const { rows } = await db.query(
    "select project_id, title, type, phase, round, state_version, unresolved_critical_count, end_reason, created_at, updated_at from projects order by updated_at desc limit 200",
  );
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at), updated_at: iso(r.updated_at) }));
}

export async function getProject(db: Db, projectId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return null;
  const row = (await db.query("select state, state_version, updated_at from projects where project_id = $1", [projectId])).rows[0];
  if (!row) return null;
  const runs = (
    await db.query(
      `select run_id, task, role, status, attempts, output_mode, model_slug, error_code, error_message, created_at, claimed_at, finished_at, lease_expires_at
       from ai_runs where project_id = $1 order by created_at desc limit 60`,
      [projectId],
    )
  ).rows.map((r) => ({
    ...r,
    created_at: iso(r.created_at),
    claimed_at: r.claimed_at ? iso(r.claimed_at) : null,
    finished_at: r.finished_at ? iso(r.finished_at) : null,
    lease_expires_at: r.lease_expires_at ? iso(r.lease_expires_at) : null,
  }));
  const sources = (await db.query("select source_id, title, body, char_count, created_at from sources where project_id = $1 order by source_id", [projectId])).rows.map((r) => ({
    ...r,
    created_at: iso(r.created_at),
  }));
  return { state: row.state as ProjectState, state_version: row.state_version as number, updated_at: iso(row.updated_at), runs, sources };
}

export async function getOutput(db: Db, projectId: string, snapshotId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(projectId) || !/^[0-9a-f-]{36}$/i.test(snapshotId)) return null;
  // 프로젝트 소속을 함께 확인한다: 다른 프로젝트의 스냅샷 ID로는 조회되지 않는다.
  const snap = (await db.query("select * from output_snapshots where output_snapshot_id = $1 and project_id = $2", [snapshotId, projectId])).rows[0];
  if (!snap) return null;
  const arts = (await db.query("select artifact_id, type, content, validation, unresolved_critical_ids, generated_at from artifacts where output_snapshot_id = $1 and project_id = $2", [snapshotId, projectId])).rows;
  const proj = (await db.query("select title, state from projects where project_id = $1", [projectId])).rows[0];
  const record = (proj.state as ProjectState).outputs.find((o) => o.output_snapshot_id === snapshotId) ?? null;
  // 산출물에 나오는 F·SRC 번호를 읽는 사람이 풀어 볼 수 있게, 스냅샷 시점의 사실 목록과 자료 제목을 함께 준다.
  const plan = (await db.query("select content from plan_versions where plan_version_id = $1 and project_id = $2", [snap.plan_version_id, projectId])).rows[0];
  const sourceSet = new Set(snap.source_set as string[]);
  const sources = (await db.query<{ source_id: string; title: string }>("select source_id, title from sources where project_id = $1 order by source_id", [projectId])).rows.filter((s) => sourceSet.has(s.source_id));
  return {
    title: proj.title as string,
    record,
    snapshot: { ...snap, created_at: iso(snap.created_at) },
    artifacts: Object.fromEntries(arts.map((a) => [a.type, a.content])),
    refs: { facts: ((plan?.content as PlanContent | undefined)?.facts ?? []) as Fact[], sources },
  };
}
