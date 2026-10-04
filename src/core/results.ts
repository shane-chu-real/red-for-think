// AI 작업 결과 → 검증 → 상태 반영. AI는 제안만 하고, ID·상태 전환·참조 무결성은 여기서 서버가 결정한다.
import {
  FACT_AREA_LABELS,
  ISSUE_STATE_LABELS,
  LIMITS,
  PLAN_DOC_KEYS,
  PLAN_DOC_TITLES,
  ROLE_LABELS,
  SECTION_KEYS,
  SEVERITY_LABELS,
  SEVERITY_RANK,
  type IssueState,
  type Task,
} from "./constants";
import { buildDebateLog, validateOutputs } from "./outputs";
import { buildPlanFromOutline, hasChanges, targetsChangedSince } from "./plan";
import type { RunPayload } from "./prompts";
import {
  afterReviews,
  createIssueFromCandidate,
  enqueue,
  judgeTargets,
  pruneStaleRuns,
  roundSummaryText,
  type ReducerContext,
} from "./reducer";
import { AI_OUTPUT_SCHEMAS, parseAiJson, type AiOutput } from "./schemas";
import {
  allMissingReviews,
  clone,
  currentRound,
  findIssue,
  findingLimit,
  isUnresolved,
  note,
  pad,
  requireIssue,
  setIssueState,
  unresolvedCritical,
} from "./state";
import {
  DomainError,
  type Candidate,
  type DecisionStatus,
  type Effect,
  type Issue,
  type PendingRun,
  type ProjectState,
  type ReduceResult,
} from "./types";

export type Validated<T extends Task> = { ok: true; value: AiOutput<T> } | { ok: false; errors: string[] };

function subset(errors: string[], label: string, refs: string[], allowed: Set<string>) {
  for (const r of refs) if (!allowed.has(r)) errors.push(`${label}: 허용되지 않은 참조 ${r}`);
}

// 1) 형식(JSON·스키마) 2) 참조 무결성·개수 제한 — 둘 다 통과해야 반영한다.
export function validateRunOutput<T extends Task>(task: T, text: string, payload: RunPayload, state: ProjectState): Validated<T> {
  let raw: unknown;
  try {
    raw = parseAiJson(text);
  } catch {
    return { ok: false, errors: ["JSON으로 해석할 수 없는 응답입니다."] };
  }
  const parsed = AI_OUTPUT_SCHEMAS[task].safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const value = parsed.data as AiOutput<T>;
  const a = payload.allowed;
  const claims = new Set(a.claim_ids);
  const facts = new Set(a.fact_ids);
  const sources = new Set(a.source_ids);
  const issues = new Set(a.issue_ids);
  const errors: string[] = [];

  switch (task) {
    case "intake": {
      const v = value as AiOutput<"intake">;
      if (v.questions.length > LIMITS.maxIntakeQuestions) errors.push(`질문은 최대 ${LIMITS.maxIntakeQuestions}개입니다.`);
      if (v.questions.some((q) => !q.text.trim())) errors.push("빈 질문이 있습니다.");
      break;
    }
    case "outline": {
      const v = value as AiOutput<"outline">;
      const keys = new Set(v.sections.map((s) => s.key));
      for (const k of SECTION_KEYS) if (!keys.has(k)) errors.push(`섹션 ${k}가 없습니다.`);
      const factKeys = new Set(v.facts.map((f) => f.key));
      if (factKeys.size !== v.facts.length) errors.push("facts의 key가 중복됩니다.");
      for (const s of v.sections) {
        for (const c of s.claims) {
          if (!c.text.trim()) errors.push(`${s.key}: 빈 항목이 있습니다.`);
          subset(errors, `${s.key} 출처`, c.source_refs, sources);
          subset(errors, `${s.key} 사실`, c.fact_keys, factKeys);
        }
      }
      for (const f of v.facts) subset(errors, `사실 ${f.key} 출처`, f.source_refs, sources);
      break;
    }
    case "review": {
      const v = value as AiOutput<"review">;
      const role = payload.role!;
      const limit = findingLimit(state, role);
      if (v.findings.length > limit) errors.push(`${ROLE_LABELS[role]} 지적은 최대 ${limit}개입니다(받은 수 ${v.findings.length}).`);
      v.findings.forEach((f, i) => {
        if (!f.target_claim_ids.length) errors.push(`지적 ${i + 1}: 대상 항목(target_claim_ids)이 없습니다.`);
        subset(errors, `지적 ${i + 1} 대상`, f.target_claim_ids, claims);
        subset(errors, `지적 ${i + 1} 출처`, f.source_refs, sources);
        if (!f.resolution_conditions.filter((c) => c.trim()).length) errors.push(`지적 ${i + 1}: 해소 조건이 없습니다.`);
        if (f.resolution_conditions.length > 3) errors.push(`지적 ${i + 1}: 해소 조건은 3개까지입니다.`);
        if (f.reopen_issue_id && !issues.has(f.reopen_issue_id)) errors.push(`지적 ${i + 1}: 없는 쟁점 ${f.reopen_issue_id}를 재개하려 합니다.`);
        if (!f.critique.trim()) errors.push(`지적 ${i + 1}: 지적 내용이 비었습니다.`);
      });
      break;
    }
    case "consolidate": {
      const v = value as AiOutput<"consolidate">;
      const keys = new Set(a.candidate_keys);
      const seen = new Set<string>();
      for (const g of v.groups) {
        for (const k of [g.representative_key, ...g.member_keys]) {
          if (!keys.has(k)) errors.push(`없는 후보 ${k}`);
          if (k !== g.representative_key && seen.has(k)) errors.push(`후보 ${k}가 여러 그룹에 있습니다.`);
          seen.add(k);
        }
      }
      for (const l of v.existing_links) {
        if (!keys.has(l.candidate_key)) errors.push(`없는 후보 ${l.candidate_key}`);
        if (!issues.has(l.issue_id)) errors.push(`없는 기존 쟁점 ${l.issue_id}`);
      }
      subset(errors, "order", v.order, keys);
      break;
    }
    case "map_reply": {
      const v = value as AiOutput<"map_reply">;
      const seen = new Set<string>();
      for (const m of v.mappings) {
        if (!issues.has(m.issue_id)) errors.push(`표시되지 않은 쟁점 ${m.issue_id}에 답변을 연결했습니다.`);
        if (seen.has(m.issue_id)) errors.push(`쟁점 ${m.issue_id}가 중복 연결되었습니다.`);
        seen.add(m.issue_id);
      }
      subset(errors, "미응답", v.unanswered_issue_ids, issues);
      for (const c of v.clarifications) subset(errors, "확인 질문", c.issue_ids, issues);
      break;
    }
    case "revise": {
      const v = value as AiOutput<"revise">;
      v.changes.forEach((c, i) => {
        if (c.op !== "add" && (!c.claim_id || !claims.has(c.claim_id))) errors.push(`변경 ${i + 1}: 대상 claim_id가 없거나 존재하지 않습니다.`);
        if (c.op === "add" && !c.section_key) errors.push(`변경 ${i + 1}: 추가할 섹션(section_key)이 없습니다.`);
        if (c.op !== "remove" && !c.text.trim()) errors.push(`변경 ${i + 1}: 내용이 비었습니다.`);
        subset(errors, `변경 ${i + 1} 사실`, c.fact_refs, facts);
        subset(errors, `변경 ${i + 1} 출처`, c.source_refs, sources);
      });
      v.fact_changes.forEach((f, i) => {
        if (f.op !== "add" && (!f.fact_id || !facts.has(f.fact_id))) errors.push(`사실 변경 ${i + 1}: 대상 fact_id가 없거나 존재하지 않습니다.`);
        subset(errors, `사실 변경 ${i + 1} 출처`, f.source_refs, sources);
      });
      subset(errors, "반영 쟁점", v.addressed_issue_ids, issues);
      subset(errors, "미반영 쟁점", v.unaddressed.map((u) => u.issue_id), issues);
      if (v.addressed_issue_ids.length && !hasChanges(v)) {
        errors.push("반영했다고 한 쟁점이 있는데 본문 항목이 바뀌지 않았습니다. changes에 관련 claim의 수정·추가·삭제를 넣거나, 반영하지 못한 쟁점은 unaddressed로 옮기십시오. 핵심 메시지·요청 결정·숫자 추가·연쇄 영향 설명만으로는 반영이 아닙니다.");
      }
      // 머리말(핵심 메시지·요청 결정)만 바뀌고 본문이 그대로면 기획이 서로 어긋난다.
      const cur = state.plan.current?.content;
      const headChanged = (v.core_message && v.core_message !== cur?.core_message) || (v.requested_decision && v.requested_decision !== cur?.requested_decision);
      if (headChanged && !v.changes.length) errors.push("핵심 메시지나 요청 결정을 바꾸면 본문의 관련 claim도 changes로 함께 고쳐야 합니다(예: 요청 결정을 바꾸면 decision 섹션).");
      break;
    }
    case "judge": {
      const v = value as AiOutput<"judge">;
      const judged = new Set<string>();
      for (const j of v.judgments) {
        if (!issues.has(j.issue_id)) {
          errors.push(`판정 대상이 아닌 쟁점 ${j.issue_id}`);
          continue;
        }
        if (judged.has(j.issue_id)) errors.push(`쟁점 ${j.issue_id}가 두 번 판정되었습니다.`);
        judged.add(j.issue_id);
        const conds = a.condition_ids[j.issue_id] ?? [];
        const got = new Set(j.condition_results.map((r) => r.condition_id));
        if (got.size !== j.condition_results.length) errors.push(`${j.issue_id}: 같은 조건을 두 번 판정했습니다.`);
        for (const c of conds) if (!got.has(c)) errors.push(`${j.issue_id}: 조건 ${c} 판정이 빠졌습니다.`);
        for (const c of got) if (!conds.includes(c)) errors.push(`${j.issue_id}: 없는 조건 ${c}`);
        const refOk = new Set([...claims, ...facts, ...sources, ...issues]);
        for (const r of j.condition_results) subset(errors, `${j.issue_id} 근거`, r.refs, refOk);
      }
      for (const id of a.issue_ids) if (!judged.has(id)) errors.push(`쟁점 ${id} 판정이 빠졌습니다.`);
      break;
    }
    case "assess":
      break;
    case "plan_doc": {
      const v = value as AiOutput<"plan_doc">;
      const keys = v.sections.map((s) => s.key);
      for (const k of PLAN_DOC_KEYS) if (!keys.includes(k)) errors.push(`기획서 '${PLAN_DOC_TITLES[k]}' 섹션이 없습니다.`);
      if (new Set(keys).size !== keys.length) errors.push("기획서 섹션이 중복됩니다.");
      for (const s of v.sections) {
        subset(errors, `${s.key} 쟁점`, s.issue_refs, issues);
        subset(errors, `${s.key} 사실`, s.fact_refs, facts);
        subset(errors, `${s.key} 출처`, s.source_refs, sources);
      }
      const crit = (payload.context.unresolved_critical as string[] | undefined) ?? [];
      const summary = v.sections.find((s) => s.key === "summary");
      const decision = v.sections.find((s) => s.key === "decision_request");
      for (const id of crit) {
        if (!summary?.issue_refs.includes(id)) errors.push(`미해결 치명 이슈 ${id}를 요약(summary.issue_refs)에 넣어야 합니다.`);
        if (!decision?.issue_refs.includes(id)) errors.push(`미해결 치명 이슈 ${id}를 의사결정 요청(decision_request.issue_refs)에 넣어야 합니다.`);
      }
      subset(errors, "미반영 쟁점", v.unreflected.map((u) => u.issue_id), issues);
      break;
    }
    case "storyline": {
      const v = value as AiOutput<"storyline">;
      const exec = state.generation?.audience === "executive";
      const main = v.slides.filter((s) => !s.appendix).length;
      const max = exec ? LIMITS.execMainSlides : LIMITS.deptMainSlides;
      if (main > max) errors.push(`본문 장표는 최대 ${max}장입니다(받은 수 ${main}).`);
      if (main < 3) errors.push("본문 장표가 너무 적습니다(3장 이상).");
      for (const s of v.slides) subset(errors, "장표 쟁점", s.issue_refs, issues);
      if (!v.one_minute_summary.trim()) errors.push("1분 요약이 없습니다.");
      break;
    }
    case "qa": {
      const v = value as AiOutput<"qa">;
      if (v.items.length > LIMITS.qaMaxItems) errors.push(`질의응답은 최대 ${LIMITS.qaMaxItems}개입니다.`);
      const slides = new Set(a.slide_ids);
      const refOk = new Set([...facts, ...sources, ...issues]);
      v.items.forEach((q, i) => {
        subset(errors, `질의응답 ${i + 1} 장표`, q.slide_ids, slides);
        subset(errors, `질의응답 ${i + 1} 근거`, q.evidence_refs, refOk);
      });
      break;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// ── 결과 반영 ────────────────────────────────────────────

function dropPending(state: ProjectState, run_id: string): PendingRun {
  const idx = state.pending_runs.findIndex((r) => r.run_id === run_id);
  if (idx < 0) throw new DomainError("SUPERSEDED", "이 작업은 더 이상 현재 단계에 필요하지 않습니다.");
  return state.pending_runs.splice(idx, 1)[0];
}

export function applyRunSuccess(prev: ProjectState, run_id: string, task: Task, output: unknown, ctx: ReducerContext): ReduceResult {
  const state = clone(prev);
  state.updated_at = ctx.now;
  const effects: Effect[] = [];
  const pending = dropPending(state, run_id);

  switch (task) {
    case "intake": {
      const v = output as AiOutput<"intake">;
      state.intake.batches += 1;
      const batch = state.intake.batches;
      for (const q of v.questions.slice(0, LIMITS.maxIntakeQuestions)) {
        state.counters.question += 1;
        state.intake.questions.push({ question_id: `Q-${pad(state.counters.question, 2)}`, text: q.text, why: q.why, batch, answer: null });
      }
      // 진행자는 매번 확인된 정보를 전부 다시 정리해 주므로, 이전 정리본은 새 것으로 바꾼다(사용자가 쓴 원문은 남긴다).
      if (v.info_items.length) state.intake.info_items = state.intake.info_items.filter((i) => i.origin !== "ai");
      for (const item of v.info_items) {
        state.counters.item += 1;
        state.intake.info_items.push({ item_id: `N-${pad(state.counters.item)}`, kind: item.kind, text: item.text, origin: "ai" });
      }
      if (v.type_suggestion && v.type_suggestion !== state.type) {
        note(state, ctx, "moderator", `기획 유형이 '${v.type_suggestion}'에 더 가까워 보입니다. 필요하면 새 프로젝트로 유형을 바꿔 주세요(현재 유형 유지).`);
      }
      if (v.ready_for_outline || v.questions.length === 0) {
        note(state, ctx, "moderator", v.note || "뼈대를 쓸 만큼 정보가 모였습니다.");
        state.phase = "OUTLINE_CONFIRM";
        enqueue(state, effects, "outline", {}, ctx);
        note(state, ctx, "system", "작성자가 기획 뼈대를 작성합니다.", "note");
      } else {
        const list = state.intake.questions.filter((q) => q.batch === batch).map((q) => `${q.question_id} ${q.text}`);
        note(state, ctx, "moderator", `확인이 필요한 질문입니다. 아는 것만 답해 주세요(모르면 "모름").\n${list.join("\n")}`);
        state.phase = "INTAKE";
      }
      break;
    }

    case "outline": {
      const v = output as AiOutput<"outline">;
      const content = buildPlanFromOutline(state, v, 1);
      state.outline_draft = { draft_id: ctx.newId(), run_id, content, created_at: ctx.now };
      state.phase = "OUTLINE_CONFIRM";
      note(state, ctx, "writer", `기획 뼈대를 제안합니다. 핵심 메시지: ${v.core_message}\n요청 결정: ${v.requested_decision}\n방향이 맞으면 확인해 주세요. 확인 전에는 검토를 시작하지 않습니다.`);
      break;
    }

    case "review": {
      const v = output as AiOutput<"review">;
      const role = pending.role!;
      const rec = currentRound(state)!;
      const extra = Boolean(pending.params.extra);
      const prefix = extra ? `X${state.round}` : `R${state.round}`;
      v.findings.forEach((f, i) => {
        const c: Candidate = {
          key: `${prefix}-${role}-${i + 1}`,
          run_id,
          role,
          round: state.round,
          extra,
          severity: f.severity,
          target_claim_ids: f.target_claim_ids,
          critique: f.critique,
          reason: f.reason,
          source_refs: f.source_refs,
          uncertainties: f.uncertainties,
          expected_question: f.expected_question,
          resolution_conditions: f.resolution_conditions.filter((x) => x.trim()),
          reopen_issue_id: f.reopen_issue_id,
          reopen_reason: f.reopen_reason,
        };
        state.candidates.push(c);
      });
      const base = rec.review_runs.find((r) => r.run_id === run_id);
      if (base) base.status = "succeeded";
      const ex = rec.extra_reviews.find((r) => r.run_id === run_id);
      if (ex) ex.status = "succeeded";
      note(state, ctx, role, v.findings.length ? `지적 ${v.findings.length}건을 냈습니다.` : `구체적인 지적이 없습니다. ${v.no_findings_reason}`);
      const reviewsLeft = state.pending_runs.some((r) => r.task === "review");
      if (!reviewsLeft) afterReviews(state, effects, ctx);
      break;
    }

    case "consolidate": {
      const v = output as AiOutput<"consolidate">;
      const byKey = new Map(state.candidates.map((c) => [c.key, c]));
      const order = [...new Set([...v.order.filter((k) => byKey.has(k)), ...state.candidates.map((c) => c.key)])];
      order.sort((x, y) => SEVERITY_RANK[byKey.get(x)!.severity] - SEVERITY_RANK[byKey.get(y)!.severity]);
      const memberOf = new Map<string, string>();
      for (const g of v.groups) for (const m of g.member_keys) if (m !== g.representative_key && !memberOf.has(m)) memberOf.set(m, g.representative_key);
      const links = new Map(v.existing_links.map((l) => [l.candidate_key, l] as const));
      for (const c of state.candidates) {
        if (!links.has(c.key) && c.reopen_issue_id) links.set(c.key, { candidate_key: c.key, issue_id: c.reopen_issue_id, relation: "reopen", reason: c.reopen_reason });
      }
      const target = new Map<string, Issue>();
      const plan = state.plan.current!.content;
      let merged = 0;
      // 병합된 지적이 더 심각하면 대표 쟁점의 심각도를 올린다(치명 지적이 병합으로 집계에서 빠지지 않게).
      const escalate = (rep: Issue, c: Candidate) => {
        if (SEVERITY_RANK[c.severity] >= SEVERITY_RANK[rep.severity]) return;
        rep.history.push({
          at: ctx.now,
          from: rep.state,
          to: rep.state,
          reason: `병합된 ${ROLE_LABELS[c.role]} 지적의 심각도 반영: ${SEVERITY_LABELS[rep.severity]} → ${SEVERITY_LABELS[c.severity]}`,
          actor: "system",
        });
        rep.severity = c.severity;
      };
      for (const key of order) {
        if (memberOf.has(key)) continue;
        const c = byKey.get(key)!;
        const link = links.get(key);
        if (link) {
          const existing = requireIssue(state, link.issue_id);
          const rep = existing.state === "MERGED" && existing.representative_id ? state.issues.find((i) => i.issue_id === existing.representative_id) ?? existing : existing;
          if (link.relation === "reopen" && (rep.state === "RESOLVED" || rep.state === "WITHDRAWN") && targetsChangedSince(plan, state.plan.removed_claims, rep.target_claim_ids, rep.resolved_on_version ?? 0)) {
            setIssueState(rep, "RECHECK_PENDING", `전제 변경으로 재개: ${c.reopen_reason || link.reason}`, c.role, ctx);
            note(state, ctx, "moderator", `${rep.display_id}을(를) 전제 변경으로 다시 엽니다: ${c.reopen_reason || link.reason}`);
          }
          if (!isUnresolved(rep)) {
            // 이미 끝난(해소·철회) 쟁점 뒤에 새 지적을 숨기지 않는다. 새 쟁점으로 등록해 사용자가 직접 판단하게 한다.
            target.set(key, createIssueFromCandidate(state, c, "OPEN", null, ctx));
            note(state, ctx, "system", `${rep.display_id}(${ISSUE_STATE_LABELS[rep.state]})와 같은 문제로 분류된 새 지적은 병합하지 않고 새 쟁점으로 등록했습니다. 이미 다룬 내용이면 반박으로 알려 주세요.`, "note");
            continue;
          }
          createIssueFromCandidate(state, c, "MERGED", rep, ctx);
          escalate(rep, c);
          target.set(key, rep);
          merged += 1;
          continue;
        }
        target.set(key, createIssueFromCandidate(state, c, "OPEN", null, ctx));
      }
      for (const key of order) {
        const repKey = memberOf.get(key);
        if (!repKey) continue;
        const rep = target.get(repKey);
        const c = byKey.get(key)!;
        if (rep && isUnresolved(rep)) {
          createIssueFromCandidate(state, c, "MERGED", rep, ctx);
          escalate(rep, c);
          merged += 1;
        } else {
          target.set(key, createIssueFromCandidate(state, c, "OPEN", null, ctx));
        }
      }
      const created = state.candidates.length;
      state.candidates = [];
      state.phase = "WAITING_REPLY";
      const crit = unresolvedCritical(state).length;
      note(state, ctx, "moderator", `지적 ${created}건을 쟁점으로 정리했습니다(병합 ${merged}건, 미해결 치명 ${crit}건). 치명 이슈와 먼저 풀어야 할 전제부터 3~5개씩 보여 드립니다. 수용·반박·보류 버튼이나 자유 입력으로 답해 주세요.`);
      break;
    }

    case "map_reply": {
      const v = output as AiOutput<"map_reply">;
      state.pending_mapping = {
        mapping_id: ctx.newId(),
        run_id,
        reply_text: pending.params.reply_text ?? "",
        items: v.mappings,
        unanswered_issue_ids: v.unanswered_issue_ids,
        clarifications: v.clarifications,
        change_requests: v.change_requests,
        created_at: ctx.now,
      };
      const parts = v.mappings.map((m) => `${m.issue_id} → ${({ accept: "수용", rebut: "반박", hold: "보류", add_info: "정보 추가" } as const)[m.response_type]}: ${m.interpreted_action}`);
      if (v.change_requests.length) parts.push(`변경 요청: ${v.change_requests.join(" / ")}`);
      if (v.clarifications.length) parts.push(`확인이 필요한 부분: ${v.clarifications.map((c) => c.question).join(" / ")}`);
      note(state, ctx, "moderator", `답변을 이렇게 이해했습니다. 맞으면 확인해 주세요(확인 전에는 반영하지 않습니다).\n${parts.join("\n") || "(연결된 쟁점이 없습니다)"}`);
      break;
    }

    case "revise": {
      const v = output as AiOutput<"revise">;
      const cur = state.plan.current!;
      const toUuid = (display: string) => findIssue(state, display)?.issue_id ?? display;
      state.revision = {
        revision_id: ctx.newId(),
        run_id,
        base_plan_version_id: cur.plan_version_id,
        change_summary: v.change_summary,
        core_message: v.core_message,
        requested_decision: v.requested_decision,
        changes: v.changes,
        fact_changes: v.fact_changes,
        cascade_impacts: v.cascade_impacts,
        addressed_issue_ids: v.addressed_issue_ids.map(toUuid),
        unaddressed: v.unaddressed,
        change_request_ids: state.change_requests.filter((c) => c.status === "pending").map((c) => c.request_id),
        status: "pending",
        created_at: ctx.now,
      };
      state.phase = "REVISION_CONFIRM";
      note(state, ctx, "writer", `변경안: ${v.change_summary}${v.cascade_impacts.length ? `\n연쇄 영향: ${v.cascade_impacts.map((c) => `${FACT_AREA_LABELS[c.area]} ${c.before}→${c.after}`).join(", ")}` : ""}${v.unaddressed.length ? `\n반영하지 못한 쟁점: ${v.unaddressed.map((u) => `${u.issue_id}(${u.reason})`).join(", ")}` : ""}\n적용 여부를 확인해 주세요.`);
      break;
    }

    case "judge": {
      const v = output as AiOutput<"judge">;
      const plan = state.plan.current!;
      const lines: string[] = [];
      for (const j of v.judgments) {
        const issue = requireIssue(state, j.issue_id);
        const prevState = issue.state;
        const allMet = issue.resolution_conditions.every((c) => j.condition_results.find((r) => r.condition_id === c.condition_id)?.result === "met");
        const decisions = state.decisions.filter((d) => d.issue_ids.includes(issue.issue_id));
        const last = decisions[decisions.length - 1];
        let applied: IssueState;
        let serverNote = "";
        if (j.proposed_state === "RESOLVED") {
          if (!allMet) {
            applied = "OPEN";
            serverNote = "충족되지 않았거나 판단할 수 없는 조건이 있어 해소로 처리하지 않았습니다.";
          } else if (last?.response_type === "accept" && !issue.applied_revision_ids.length) {
            applied = "CHANGE_PENDING";
            serverNote = "수용했지만 실제로 적용된 변경이 없어 변경 대기로 둡니다.";
          } else if (last?.response_type === "hold") {
            applied = "EVIDENCE_PENDING";
            serverNote = "보류 중인 쟁점은 근거가 추가되기 전까지 해소로 처리하지 않습니다.";
          } else applied = "RESOLVED";
        } else if (j.proposed_state === "WITHDRAWN") {
          // 철회는 사용자의 반박이 있었거나 대상 항목이 실제로 바뀐 경우에만 받는다. AI 제안만으로 쟁점이 사라지지 않게 한다.
          const rebutted = prevState === "REBUTTAL_PENDING" || Boolean(issue.rebuttal);
          const premiseChanged = targetsChangedSince(plan.content, state.plan.removed_claims, issue.target_claim_ids, issue.raised_on_version);
          if (rebutted || premiseChanged) applied = "WITHDRAWN";
          else {
            applied = "OPEN";
            serverNote = "사용자의 반박이나 대상 항목의 변경 없이 지적을 철회할 수 없어 미해결로 둡니다.";
          }
        } else if (j.follow_up_question && prevState === "REBUTTAL_PENDING" && issue.follow_ups_used < LIMITS.maxFollowUps) {
          applied = "REBUTTAL_PENDING";
          issue.follow_up = { question: j.follow_up_question, asked_at: ctx.now, answer: null };
          issue.follow_ups_used += 1;
          serverNote = "추가 질문 1회";
        } else {
          applied = "OPEN";
          serverNote = "미해결 — 다시 대응이 필요합니다.";
        }
        const judgment_id = ctx.newId();
        state.judgments.push({
          judgment_id,
          issue_id: issue.issue_id,
          plan_version_id: plan.plan_version_id,
          condition_results: j.condition_results,
          proposed_state: j.proposed_state,
          applied_state: applied,
          reason: j.reason,
          server_note: serverNote,
          relies_on_user_confirmation: j.relies_on_user_confirmation,
          ai_run_id: run_id,
          created_at: ctx.now,
        });
        issue.last_judgment_id = judgment_id;
        if (applied === "RESOLVED" || applied === "WITHDRAWN") issue.resolved_on_version = plan.version_no;
        setIssueState(issue, applied, `판정(v${plan.version_no}): ${j.reason}${serverNote ? ` / ${serverNote}` : ""}`, "moderator", ctx);
        lines.push(`${issue.display_id}: ${ISSUE_STATE_LABELS[applied]} — ${j.reason}${issue.follow_up && applied === "REBUTTAL_PENDING" ? `\n  추가 질문: ${issue.follow_up.question}` : ""}`);
      }
      note(state, ctx, "moderator", `조건별 판정 결과입니다. 판정 사유를 보고 재검토를 요청할 수 있습니다.\n${lines.join("\n")}`);
      const waitingFollowUp = state.issues.some((i) => i.follow_up && i.follow_up.answer === null && i.state === "REBUTTAL_PENDING");
      if (waitingFollowUp) state.phase = "WAITING_REPLY";
      else {
        state.phase = "ROUND_SUMMARY";
        note(state, ctx, "moderator", roundSummaryText(state));
      }
      break;
    }

    case "assess": {
      const v = output as AiOutput<"assess">;
      const gen = state.generation!;
      const crit = unresolvedCritical(state);
      const missing = allMissingReviews(state);
      let outcome = v.outcome;
      let adjusted = "";
      if (outcome === "RESOLVED_CORE" && (crit.length || missing.length)) {
        outcome = "CONDITIONAL";
        adjusted = `서버 하한 규칙: ${crit.length ? `미해결 치명 ${crit.length}건` : ""}${crit.length && missing.length ? ", " : ""}${missing.length ? "검토 누락" : ""} 때문에 '핵심 쟁점 해소'로 분류하지 않았습니다.`;
      }
      const ds: DecisionStatus = {
        end_reason: state.end!.reason,
        outcome,
        outcome_rationale: v.rationale,
        outcome_adjusted_note: adjusted,
        decision_type: v.decision_type,
        decision_text: v.decision_text,
        conditions: v.conditions,
        stop_switch_criteria: v.stop_switch_criteria,
        missing_reviews: missing,
        unapplied_revision: state.revision?.status === "pending" ? { revision_id: state.revision.revision_id, change_summary: state.revision.change_summary } : null,
        unapplied_change_requests: state.change_requests.filter((c) => c.status === "pending").map((c) => c.text),
        change_pending_issue_ids: state.issues.filter((i) => i.state === "CHANGE_PENDING").map((i) => i.display_id),
        unresolved_critical_ids: crit.map((i) => i.display_id),
        rounds_completed: state.round,
      };
      gen.decision_status = ds;
      gen.output_snapshot_id = ctx.newId();
      gen.status = "writing";
      effects.push({
        type: "insert_output_snapshot",
        output_snapshot_id: gen.output_snapshot_id,
        plan_version_id: gen.plan_version_id,
        source_set: state.sources.map((s) => s.source_id),
        issue_states: state.issues.map((i) => ({ issue_id: i.issue_id, display_id: i.display_id, role: i.role, severity: i.severity, state: i.state, representative_id: i.representative_id })),
        decision_status: ds,
      });
      enqueue(state, effects, "plan_doc", {}, ctx);
      note(state, ctx, "moderator", `결과 판단: ${outcome}${adjusted ? ` (${adjusted})` : ""}. 요청 결정: ${v.decision_text}`);
      break;
    }

    case "plan_doc": {
      const v = output as AiOutput<"plan_doc">;
      const gen = state.generation!;
      gen.plan_doc = {
        sections: PLAN_DOC_KEYS.map((key) => {
          const s = v.sections.find((x) => x.key === key)!;
          return { key, title: PLAN_DOC_TITLES[key], paragraphs: s.paragraphs, bullets: s.bullets, issue_refs: s.issue_refs, fact_refs: s.fact_refs, source_refs: s.source_refs };
        }),
        unreflected: v.unreflected,
      };
      enqueue(state, effects, "storyline", {}, ctx);
      break;
    }

    case "storyline": {
      const v = output as AiOutput<"storyline">;
      const gen = state.generation!;
      let main = 0;
      let appx = 0;
      gen.storyline = {
        audience: gen.audience,
        slides: v.slides.map((s) => ({ slide_id: s.appendix ? `A${++appx}` : `S${++main}`, ...s })),
        one_minute_summary: v.one_minute_summary,
      };
      enqueue(state, effects, "qa", {}, ctx);
      break;
    }

    case "qa": {
      const v = output as AiOutput<"qa">;
      const gen = state.generation!;
      gen.qa = { items: v.items };
      finalizeOutputs(state, effects, ctx);
      break;
    }
  }
  pruneStaleRuns(state, effects);
  return { state, effects };
}

function finalizeOutputs(state: ProjectState, effects: Effect[], ctx: ReducerContext) {
  const gen = state.generation!;
  const plan = state.plan.current!;
  const debate = buildDebateLog(state, gen.plan_doc!, gen.storyline!);
  const validation = validateOutputs(state, plan.content, gen.plan_doc!, gen.storyline!, gen.qa!, debate, ctx.now);
  const crit = gen.decision_status!.unresolved_critical_ids;
  const ids = { plan_doc: ctx.newId(), storyline: ctx.newId(), qa: ctx.newId(), debate_log: ctx.newId() };
  const contents = { plan_doc: gen.plan_doc, storyline: gen.storyline, qa: gen.qa, debate_log: debate };
  for (const type of ["plan_doc", "storyline", "qa", "debate_log"] as const) {
    effects.push({
      type: "insert_artifact",
      artifact_id: ids[type],
      output_snapshot_id: gen.output_snapshot_id!,
      artifact_type: type,
      content: contents[type],
      validation,
      unresolved_critical_ids: crit,
    });
  }
  state.outputs.push({
    output_snapshot_id: gen.output_snapshot_id!,
    plan_version_id: plan.plan_version_id,
    plan_version_no: plan.version_no,
    audience: gen.audience,
    created_at: ctx.now,
    artifact_ids: ids,
    validation,
    end_reason: gen.decision_status!.end_reason,
    outcome: gen.decision_status!.outcome,
  });
  state.generation = null;
  state.phase = "OUTPUT_READY";
  note(
    state,
    ctx,
    "writer",
    `산출물 4종(기획서·스토리라인·질의응답·논쟁 기록)을 같은 스냅샷으로 만들었습니다. 검사: 오류 ${validation.errors.length}건, 확인 필요 ${validation.warnings.length}건.${validation.errors.length ? " 오류가 있으니 산출물 화면에서 확인해 주세요." : ""}`,
  );
}

// 실패 기록: 대기 목록에서 실패로 표시(재시도 가능). 사용 한도 등은 서버가 따로 일시정지 처리한다.
export function applyRunFailure(prev: ProjectState, run_id: string, code: string, message: string, ctx: ReducerContext): ReduceResult {
  const state = clone(prev);
  state.updated_at = ctx.now;
  const pr = state.pending_runs.find((r) => r.run_id === run_id);
  if (!pr) return { state: prev, effects: [] };
  pr.status = "failed";
  pr.error_code = code;
  pr.error_message = message;
  for (const rec of state.rounds) {
    for (const r of rec.review_runs) if (r.run_id === run_id) r.status = "failed";
    for (const r of rec.extra_reviews) if (r.run_id === run_id) r.status = "failed";
  }
  note(state, ctx, "system", `AI 작업 실패(${pr.task}${pr.role ? ` · ${ROLE_LABELS[pr.role]}` : ""}): ${message} — 실패한 작업만 다시 시도할 수 있습니다.`, "error");
  return { state, effects: [] };
}

// 형식 오류 → 같은 작업을 교정 요청과 함께 1회 다시 넣는다. 이미 교정 작업이면 실패로 남긴다.
export function applyRunCorrection(prev: ProjectState, run_id: string, errors: string[], previousOutput: string, ctx: ReducerContext): ReduceResult {
  const pr = prev.pending_runs.find((r) => r.run_id === run_id);
  if (!pr) return { state: prev, effects: [] };
  if (pr.params.correction_of) {
    return applyRunFailure(prev, run_id, "AI_SCHEMA_ERROR", `교정 후에도 형식이 맞지 않습니다: ${errors.slice(0, 3).join(" / ")}`, ctx);
  }
  const state = clone(prev);
  state.updated_at = ctx.now;
  const effects: Effect[] = [];
  const target = state.pending_runs.find((r) => r.run_id === run_id)!;
  const new_id = ctx.newId();
  const params = { ...target.params, correction_of: run_id, correction_errors: errors.slice(0, 10), previous_output: previousOutput.slice(0, 20000) };
  for (const rec of state.rounds) {
    for (const r of rec.review_runs) if (r.run_id === run_id) r.run_id = new_id;
    for (const r of rec.extra_reviews) if (r.run_id === run_id) r.run_id = new_id;
  }
  Object.assign(target, { run_id: new_id, status: "queued", params });
  effects.push({ type: "enqueue_run", run_id: new_id, task: target.task, params });
  note(state, ctx, "system", `AI 응답 형식이 맞지 않아 교정 요청을 1회 보냅니다(${target.task}).`, "note");
  return { state, effects };
}

export { judgeTargets };
