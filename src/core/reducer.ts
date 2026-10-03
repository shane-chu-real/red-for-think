// 사용자 동작 → 새 상태 + 부수효과(저장할 행, 대기열 작업). 순수 함수: DB·네트워크에 접근하지 않는다.
import { parseCommand } from "./commands";
import {
  ISSUE_STATE_LABELS,
  LIMITS,
  ROLES,
  ROLE_LABELS,
  type EndReason,
  type IssueState,
} from "./constants";
import { applyRevision, targetsChangedSince } from "./plan";
import { displayedIssueIds } from "./prompts";
import type { Action, ActionPayload } from "./schemas";
import {
  allMissingReviews,
  clone,
  currentRound,
  hasQueuedRuns,
  newProjectState,
  note,
  pad,
  requireIssue,
  requirePhase,
  setIssueState,
  sortedOpenIssues,
  unresolvedCritical,
} from "./state";
import {
  DomainError,
  type Candidate,
  type Effect,
  type Issue,
  type PlanVersionState,
  type ProjectState,
  type ReduceContext,
  type ReduceResult,
  type ResponseType,
  type RoundRecord,
  type RunParams,
} from "./types";
import type { Task } from "./constants";

export interface ReducerContext extends ReduceContext {
  hash: (text: string) => string;
}

const RESPONSE_LABELS: Record<ResponseType, string> = {
  accept: "수용",
  rebut: "반박",
  hold: "보류",
  add_info: "정보 추가",
  recheck_request: "재검토 요청",
};

// ── 공통 도우미 ──────────────────────────────────────────

export function enqueue(state: ProjectState, effects: Effect[], task: Task, params: RunParams, ctx: ReduceContext): string {
  const run_id = ctx.newId();
  state.pending_runs.push({ run_id, task, role: params.role ?? null, status: "queued", error_code: null, error_message: null, params });
  effects.push({ type: "enqueue_run", run_id, task, params });
  return run_id;
}

export function versionMeta(version: PlanVersionState): Omit<PlanVersionState, "content"> {
  const { content: _content, ...meta } = version;
  return meta;
}

function noQueued(state: ProjectState) {
  if (hasQueuedRuns(state)) throw new DomainError("AI_BUSY", "AI 작업이 진행 중입니다. 끝난 뒤 다시 시도해 주세요.", true);
}

function deriveTitle(text: string): string {
  const line = text.trim().split(/\n/)[0] ?? "";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || "새 기획";
}

function addSource(state: ProjectState, effects: Effect[], title: string, text: string, ctx: ReducerContext) {
  const body = text.trim();
  if (!body) throw new DomainError("EMPTY_INPUT", "자료 내용이 비어 있습니다.");
  if (body.length > LIMITS.sourceMaxChars) {
    throw new DomainError("SOURCE_TOO_LONG", `자료 1건은 ${LIMITS.sourceMaxChars.toLocaleString()}자까지 붙일 수 있습니다(현재 ${body.length.toLocaleString()}자). 핵심 부분을 나눠 붙여 주세요.`);
  }
  const total = state.sources.reduce((a, s) => a + s.char_count, 0) + body.length;
  if (total > LIMITS.sourcesTotalMaxChars) {
    throw new DomainError("SOURCE_TOO_LONG", `프로젝트 자료는 합계 ${LIMITS.sourcesTotalMaxChars.toLocaleString()}자까지입니다(추가하면 ${total.toLocaleString()}자).`);
  }
  state.counters.source += 1;
  const source = {
    source_id: `SRC-${pad(state.counters.source)}`,
    title: title.trim(),
    char_count: body.length,
    content_hash: ctx.hash(body),
    created_at: ctx.now,
    revision_of: null,
  };
  state.sources.push(source);
  effects.push({ type: "insert_source", source: { ...source, body } });
  note(state, ctx, "system", `자료 등록: ${source.source_id} '${source.title}' (${body.length.toLocaleString()}자, 텍스트 그대로 저장). 이후 AI 작업에 외부 AI(ChatGPT)로 전송됩니다.`, "note");
}

function startOutline(state: ProjectState, effects: Effect[], ctx: ReduceContext, params: RunParams = {}) {
  state.phase = "OUTLINE_CONFIRM";
  enqueue(state, effects, "outline", params, ctx);
  note(state, ctx, "system", "작성자가 기획 뼈대를 작성합니다.", "note");
}

function startRound(state: ProjectState, effects: Effect[], ctx: ReduceContext) {
  const plan = state.plan.current!;
  state.round += 1;
  state.candidates = [];
  const record: RoundRecord = {
    round: state.round,
    plan_version_id: plan.plan_version_id,
    started_at: ctx.now,
    review_runs: [],
    extra_reviews: [],
    missing_roles: [],
  };
  for (const role of ROLES) {
    const run_id = enqueue(state, effects, "review", { role, round: state.round, extra: false }, ctx);
    record.review_runs.push({ role, run_id, status: "pending" });
  }
  state.rounds.push(record);
  state.phase = "REVIEWING";
  note(state, ctx, "moderator", `${state.round}라운드 검토를 시작합니다. 다섯 역할이 확정 기획 v${plan.version_no}을 각각 따로 검토합니다.`);
}

export function judgeTargets(state: ProjectState): Issue[] {
  return state.issues.filter(
    (i) => i.state === "RECHECK_PENDING" || (i.state === "REBUTTAL_PENDING" && (!i.follow_up || i.follow_up.answer !== null)),
  );
}

export function roundSummaryText(state: ProjectState): string {
  const live = state.issues.filter((i) => i.state !== "MERGED");
  const count = (s: IssueState) => live.filter((i) => i.state === s).length;
  const crit = unresolvedCritical(state);
  const missing = allMissingReviews(state);
  const parts = [
    `${state.round}라운드 정리: 해소 ${count("RESOLVED")} · 철회 ${count("WITHDRAWN")} · 미대응 ${count("OPEN")} · 변경 대기 ${count("CHANGE_PENDING")} · 보류 ${count("EVIDENCE_PENDING")} · 반박 검토 ${count("REBUTTAL_PENDING")} · 재검증 ${count("RECHECK_PENDING")}.`,
    crit.length ? `미해결 치명 이슈 ${crit.length}건(${crit.map((i) => i.display_id).join(", ")}).` : "미해결 치명 이슈는 없습니다.",
  ];
  if (missing.length) parts.push(`검토 누락: ${missing.map((m) => `${m.round}라운드 ${m.roles.map((r) => ROLE_LABELS[r]).join("·")}`).join(", ")} — 누락이 있으면 '검토 완료'로 표시하지 않습니다.`);
  parts.push(state.round < LIMITS.maxRounds ? "다음 라운드 진행, 응답 계속, 또는 마무리를 선택해 주세요." : "최대 라운드에 도달했습니다. 응답을 계속하거나 마무리해 주세요.");
  return parts.join(" ");
}

export function proceedAfterReplies(state: ProjectState, effects: Effect[], ctx: ReduceContext) {
  const change = state.issues.filter((i) => i.state === "CHANGE_PENDING");
  const requests = state.change_requests.filter((c) => c.status === "pending");
  if (change.length || requests.length) {
    enqueue(state, effects, "revise", { issue_ids: change.map((i) => i.issue_id) }, ctx);
    state.phase = "REVISION_CONFIRM";
    note(state, ctx, "system", `작성자가 변경안을 만듭니다(수용 ${change.length}건, 변경 요청 ${requests.length}건).`, "note");
    return;
  }
  const targets = judgeTargets(state);
  if (targets.length) {
    enqueue(state, effects, "judge", { issue_ids: targets.map((i) => i.issue_id) }, ctx);
    state.phase = "VERIFYING";
    note(state, ctx, "system", `진행자가 ${targets.length}건의 해소 조건을 검증합니다.`, "note");
    return;
  }
  state.phase = "ROUND_SUMMARY";
  note(state, ctx, "moderator", roundSummaryText(state));
}

export function afterReviews(state: ProjectState, effects: Effect[], ctx: ReduceContext) {
  if (state.candidates.length) {
    enqueue(state, effects, "consolidate", {}, ctx);
    note(state, ctx, "system", `진행자가 지적 ${state.candidates.length}건을 정리합니다.`, "note");
    return;
  }
  state.phase = sortedOpenIssues(state).length ? "WAITING_REPLY" : "ROUND_SUMMARY";
  note(state, ctx, "moderator", "이번 검토에서 새 지적이 없습니다.");
  if (state.phase === "ROUND_SUMMARY") note(state, ctx, "moderator", roundSummaryText(state));
}

export function startGeneration(state: ProjectState, effects: Effect[], ctx: ReduceContext) {
  const plan = state.plan.current!;
  state.generation = {
    generation_id: ctx.newId(),
    plan_version_id: plan.plan_version_id,
    audience: state.settings.storyline_audience,
    status: "assessing",
    output_snapshot_id: null,
    decision_status: null,
    plan_doc: null,
    storyline: null,
    qa: null,
    started_at: ctx.now,
  };
  enqueue(state, effects, "assess", {}, ctx);
  state.phase = "GENERATING";
  note(state, ctx, "system", `확정 기획 v${plan.version_no}로 산출물을 만듭니다(결과 판단 → 기획서 → 스토리라인 → 질의응답 → 논쟁 기록).`, "note");
}

function computeEndReason(state: ProjectState, viaCommand: boolean): EndReason {
  const crit = unresolvedCritical(state);
  const missing = allMissingReviews(state).length > 0;
  if (viaCommand) return "USER_FINISHED";
  if (crit.length === 0 && !missing) return "REVIEW_FINISHED";
  if (crit.length > 0 && crit.every((i) => i.state === "EVIDENCE_PENDING")) return "PENDING_EXTERNAL_CHECK";
  if (state.round >= LIMITS.maxRounds) return "ROUND_LIMIT";
  return "USER_FINISHED";
}

export function createIssueFromCandidate(
  state: ProjectState,
  c: Candidate,
  status: "OPEN" | "MERGED",
  representative: Issue | null,
  ctx: ReduceContext,
): Issue {
  state.counters.issue += 1;
  const display_id = `I-${pad(state.counters.issue)}`;
  const issue: Issue = {
    issue_id: ctx.newId(),
    display_id,
    role: c.role,
    severity: c.severity,
    target_claim_ids: c.target_claim_ids,
    critique: c.critique,
    reason: c.reason,
    source_refs: c.source_refs,
    uncertainties: c.uncertainties,
    expected_question: c.expected_question,
    resolution_conditions: c.resolution_conditions.map((text, idx) => ({ condition_id: `${display_id}-c${idx + 1}`, text })),
    state: status,
    representative_id: representative?.issue_id ?? null,
    round: c.round,
    extra: c.extra,
    raised_on_version: state.plan.current?.version_no ?? 0,
    created_at: ctx.now,
    history: [
      {
        at: ctx.now,
        from: null,
        to: status,
        reason: representative ? `${representative.display_id}에 병합` : "검토 지적 등록",
        actor: c.role,
      },
    ],
    follow_up: null,
    follow_ups_used: 0,
    applied_revision_ids: [],
    resolved_on_version: null,
    last_judgment_id: null,
    rebuttal: null,
    evidence_notes: [],
  };
  state.issues.push(issue);
  return issue;
}

// 사용자 대응 1건을 쟁점에 적용한다. strict=false면 허용되지 않는 전환을 건너뛴다.
function applyResponse(
  state: ProjectState,
  ctx: ReduceContext,
  ref: string,
  type: ResponseType,
  text: string,
  original: string,
  via: "button" | "text",
  interpreted: string,
  strict: boolean,
): boolean {
  const issue = requireIssue(state, ref);
  const fail = (msg: string) => {
    if (strict) throw new DomainError("INVALID_TRANSITION", msg);
    return false;
  };
  if (issue.state === "MERGED") {
    const rep = state.issues.find((i) => i.issue_id === issue.representative_id);
    return fail(`${issue.display_id}은(는) ${rep?.display_id ?? "대표 쟁점"}에 병합되었습니다. 대표 쟁점에 응답해 주세요.`);
  }
  const from = issue.state;
  let to: IssueState | null = null;
  let reason = "";
  switch (type) {
    case "accept":
      if (["OPEN", "EVIDENCE_PENDING", "REBUTTAL_PENDING", "RECHECK_PENDING"].includes(from)) {
        to = "CHANGE_PENDING";
        reason = "수용 — 변경안 반영 대기";
      }
      break;
    case "rebut":
      if (!text) return fail("반박에는 근거나 이유를 적어 주세요.");
      if (from === "REBUTTAL_PENDING" && issue.follow_up && issue.follow_up.answer === null) {
        issue.follow_up.answer = text;
        to = "REBUTTAL_PENDING";
        reason = "추가 질문에 답변";
      } else if (["OPEN", "CHANGE_PENDING", "EVIDENCE_PENDING", "RECHECK_PENDING", "REBUTTAL_PENDING"].includes(from)) {
        issue.rebuttal = text;
        to = "REBUTTAL_PENDING";
        reason = "반박 — 근거·논리 검토 대기";
      }
      break;
    case "hold":
      if (["OPEN", "CHANGE_PENDING", "REBUTTAL_PENDING", "RECHECK_PENDING"].includes(from)) {
        to = "EVIDENCE_PENDING";
        reason = "보류 — 외부 확인·근거 대기 (해소 아님)";
      }
      break;
    case "add_info":
      if (!text) return fail("추가할 정보나 근거를 적어 주세요.");
      if (from === "REBUTTAL_PENDING") {
        if (issue.follow_up && issue.follow_up.answer === null) issue.follow_up.answer = text;
        else issue.evidence_notes.push(text);
        to = "REBUTTAL_PENDING";
        reason = "정보 추가";
      } else if (from === "CHANGE_PENDING") {
        issue.evidence_notes.push(text);
        to = "CHANGE_PENDING";
        reason = "변경에 참고할 정보 추가";
      } else if (["OPEN", "EVIDENCE_PENDING", "RECHECK_PENDING"].includes(from)) {
        issue.evidence_notes.push(text);
        to = "RECHECK_PENDING";
        reason = "근거 추가 — 재검증 대기";
      }
      break;
    case "recheck_request":
      if (["RESOLVED", "WITHDRAWN"].includes(from)) {
        if (!text) return fail("재검토를 요청하는 이유를 적어 주세요.");
        issue.evidence_notes.push(`재검토 요청: ${text}`);
        to = "RECHECK_PENDING";
        reason = "사용자 재검토 요청";
      }
      break;
  }
  if (!to) return fail(`${issue.display_id}은(는) 현재 상태(${ISSUE_STATE_LABELS[from]})에서 '${RESPONSE_LABELS[type]}' 응답을 받을 수 없습니다.`);
  setIssueState(issue, to, reason, "user", ctx);
  state.decisions.push({
    decision_id: ctx.newId(),
    issue_ids: [issue.issue_id],
    response_type: type,
    original_reply: original || text,
    quote: text,
    interpreted_action: interpreted || RESPONSE_LABELS[type],
    user_confirmed: true,
    via,
    plan_version_id: state.plan.current?.plan_version_id ?? null,
    created_at: ctx.now,
  });
  return true;
}

// ── 프로젝트 생성 ────────────────────────────────────────

export function createProject(payload: ActionPayload<"CREATE_PROJECT">, ctx: ReducerContext): ReduceResult {
  const effects: Effect[] = [];
  const command = parseCommand(payload.idea);
  const idea = command ? "" : payload.idea.trim();
  const state = newProjectState(
    {
      project_id: ctx.newId(),
      title: payload.title?.trim() || deriveTitle(idea),
      type: payload.type,
      idea,
      problem: payload.problem.trim(),
      requested_decision: payload.requested_decision.trim(),
      audience: payload.audience,
    },
    ctx,
  );
  if (command?.type === "SET_INTENSITY") state.settings.intensity = command.payload.intensity;
  if (command?.type === "SET_AUDIENCE") state.settings.storyline_audience = command.payload.audience;
  for (const s of payload.sources) addSource(state, effects, s.title, s.text, ctx);

  if (!idea) {
    if (command) note(state, ctx, "system", `명령을 반영했습니다(${payload.idea.trim()}).`, "note");
    note(state, ctx, "moderator", "기획 아이디어를 입력해 주세요. 아이디어 없이 기획 내용을 만들어내지 않습니다.");
    return { state, effects, data: { project_id: state.project_id } };
  }
  note(state, ctx, "user", [idea, state.problem && `해결할 문제: ${state.problem}`, state.requested_decision && `받을 결정: ${state.requested_decision}`].filter(Boolean).join("\n"));
  state.intake.batches = 0;
  enqueue(state, effects, "intake", {}, ctx);
  return { state, effects, data: { project_id: state.project_id } };
}

// ── 동작 처리 ────────────────────────────────────────────

export function reduce(prev: ProjectState, action: Action, ctx: ReducerContext): ReduceResult {
  const state = clone(prev);
  state.updated_at = ctx.now;
  const effects: Effect[] = [];
  const done = (data?: unknown): ReduceResult => ({ state, effects, data });

  switch (action.type) {
    case "CREATE_PROJECT":
      throw new DomainError("INVALID_TRANSITION", "프로젝트 생성은 별도 경로로 처리합니다.");

    case "ANSWER_INTAKE": {
      requirePhase(state, ["INTAKE"], "인터뷰 답변");
      noQueued(state);
      const { answers, text } = action.payload;
      if (!state.idea) {
        if (!text) throw new DomainError("MINIMUM_INPUT_REQUIRED", "기획 아이디어를 입력해 주세요.");
        state.idea = text;
        if (state.title === "새 기획") state.title = deriveTitle(text);
        note(state, ctx, "user", text);
        enqueue(state, effects, "intake", {}, ctx);
        return done();
      }
      let answered = 0;
      for (const a of answers) {
        const q = state.intake.questions.find((x) => x.question_id === a.question_id);
        if (!q) throw new DomainError("INVALID_REFERENCE", `존재하지 않는 질문입니다: ${a.question_id}`);
        if (!a.text) continue;
        q.answer = a.text;
        answered += 1;
        note(state, ctx, "user", `${q.question_id} ${q.text}\n→ ${a.text}`);
      }
      if (text) {
        state.counters.item += 1;
        state.intake.info_items.push({ item_id: `N-${pad(state.counters.item)}`, kind: "user_statement", text, origin: "user" });
        note(state, ctx, "user", text);
        answered += 1;
      }
      if (!answered) throw new DomainError("EMPTY_INPUT", '답변을 입력해 주세요. 모르는 항목은 "모름"이라고 적으면 미확인으로 남깁니다.');
      if (state.intake.batches >= LIMITS.maxIntakeBatches) startOutline(state, effects, ctx);
      else enqueue(state, effects, "intake", {}, ctx);
      return done();
    }

    case "REQUEST_OUTLINE": {
      requirePhase(state, ["INTAKE"], "뼈대 작성 요청");
      noQueued(state);
      if (!state.idea) throw new DomainError("MINIMUM_INPUT_REQUIRED", "기획 아이디어를 먼저 입력해 주세요.");
      note(state, ctx, "user", "남은 질문은 미확인으로 두고 뼈대를 만들어 주세요.");
      startOutline(state, effects, ctx);
      return done();
    }

    case "REVISE_OUTLINE": {
      requirePhase(state, ["OUTLINE_CONFIRM"], "뼈대 수정 요청");
      noQueued(state);
      if (!state.outline_draft) throw new DomainError("INVALID_TRANSITION", "수정할 뼈대 초안이 없습니다.");
      note(state, ctx, "user", `뼈대 수정 요청: ${action.payload.feedback}`);
      enqueue(state, effects, "outline", { feedback: action.payload.feedback }, ctx);
      return done();
    }

    case "CONFIRM_OUTLINE": {
      requirePhase(state, ["OUTLINE_CONFIRM"], "뼈대 확인");
      noQueued(state);
      const draft = state.outline_draft;
      if (!draft || draft.draft_id !== action.payload.draft_id) throw new DomainError("VERSION_CONFLICT", "확인하려는 뼈대가 최신 초안이 아닙니다. 새로고침해 주세요.");
      const version: PlanVersionState = {
        plan_version_id: ctx.newId(),
        parent_version_id: null,
        version_no: 1,
        confirmed_at: ctx.now,
        change_summary: "기획 뼈대 최초 확정",
        content: draft.content,
      };
      state.plan.current = version;
      state.plan.history.push(versionMeta(version));
      effects.push({ type: "insert_plan_version", version });
      state.outline_draft = null;
      note(state, ctx, "user", "기획 뼈대를 확인했습니다(확정 v1).");
      startRound(state, effects, ctx);
      return done();
    }

    case "RESPOND_ISSUES": {
      requirePhase(state, ["WAITING_REPLY", "ROUND_SUMMARY"], "쟁점 대응");
      noQueued(state);
      if (state.pending_mapping) throw new DomainError("INVALID_TRANSITION", "확인 대기 중인 답변 해석을 먼저 확인하거나 취소해 주세요.");
      for (const r of action.payload.responses) {
        applyResponse(state, ctx, r.issue_id, r.response_type, r.text, r.text, "button", "", true);
        const issue = requireIssue(state, r.issue_id);
        note(state, ctx, "user", `${issue.display_id} ${RESPONSE_LABELS[r.response_type]}${r.text ? `: ${r.text}` : ""}`);
      }
      state.phase = "WAITING_REPLY";
      return done();
    }

    case "SUBMIT_REPLY": {
      requirePhase(state, ["WAITING_REPLY", "ROUND_SUMMARY"], "자연어 답변");
      noQueued(state);
      if (state.pending_mapping) throw new DomainError("INVALID_TRANSITION", "이전 답변 해석을 먼저 확인하거나 취소해 주세요.");
      note(state, ctx, "user", action.payload.text);
      enqueue(state, effects, "map_reply", { reply_text: action.payload.text, issue_ids: displayedIssueIds(state) }, ctx);
      state.phase = "WAITING_REPLY";
      return done();
    }

    case "CONFIRM_REPLY_MAPPING": {
      requirePhase(state, ["WAITING_REPLY"], "답변 해석 확인");
      const m = state.pending_mapping;
      if (!m || m.mapping_id !== action.payload.mapping_id) throw new DomainError("VERSION_CONFLICT", "확인하려는 해석이 최신이 아닙니다. 새로고침해 주세요.");
      const excluded = new Set(action.payload.excluded_issue_ids);
      let applied = 0;
      for (const item of m.items) {
        if (excluded.has(item.issue_id)) continue;
        const ok = applyResponse(state, ctx, item.issue_id, item.response_type, item.quote || m.reply_text, m.reply_text, "text", item.interpreted_action, false);
        if (ok) applied += 1;
        else note(state, ctx, "system", `${item.issue_id}: 현재 상태에서 적용할 수 없어 건너뛰었습니다.`, "note");
      }
      for (const text of m.change_requests) {
        state.change_requests.push({ request_id: ctx.newId(), text, status: "pending", created_at: ctx.now });
      }
      for (const c of m.clarifications) note(state, ctx, "moderator", `확인 질문(${c.issue_ids.join(", ")}): ${c.question}`);
      state.pending_mapping = null;
      note(state, ctx, "system", `답변 해석을 확인했습니다: 반영 ${applied}건, 변경 요청 ${m.change_requests.length}건. 답하지 않은 쟁점은 미응답 상태로 남습니다.`, "note");
      return done();
    }

    case "DISCARD_REPLY_MAPPING": {
      requirePhase(state, ["WAITING_REPLY"], "답변 해석 취소");
      const m = state.pending_mapping;
      if (!m || m.mapping_id !== action.payload.mapping_id) throw new DomainError("VERSION_CONFLICT", "취소하려는 해석이 최신이 아닙니다.");
      state.pending_mapping = null;
      note(state, ctx, "system", "답변 해석을 적용하지 않고 취소했습니다.", "note");
      return done();
    }

    case "PROCEED": {
      requirePhase(state, ["WAITING_REPLY"], "다음 단계 진행(/스킵)");
      noQueued(state);
      if (state.pending_mapping) throw new DomainError("INVALID_TRANSITION", "답변 해석을 먼저 확인하거나 취소해 주세요.");
      const unanswered = sortedOpenIssues(state).filter((i) => i.state === "OPEN").length;
      note(state, ctx, "user", `응답 수집을 마칩니다${unanswered ? ` (미응답 ${unanswered}건은 해소되지 않은 채 남습니다)` : ""}.`);
      proceedAfterReplies(state, effects, ctx);
      return done();
    }

    case "CONFIRM_REVISION": {
      requirePhase(state, ["REVISION_CONFIRM"], "변경안 적용");
      noQueued(state);
      const rev = state.revision;
      if (!rev || rev.status !== "pending" || rev.revision_id !== action.payload.revision_id) {
        throw new DomainError("VERSION_CONFLICT", "적용하려는 변경안이 최신이 아닙니다. 새로고침해 주세요.");
      }
      const cur = state.plan.current!;
      if (rev.base_plan_version_id !== cur.plan_version_id) throw new DomainError("VERSION_CONFLICT", "변경안의 기준 기획 버전이 현재 버전과 다릅니다.");
      const versionNo = cur.version_no + 1;
      const content = applyRevision(state, cur.content, rev, versionNo);
      const version: PlanVersionState = {
        plan_version_id: ctx.newId(),
        parent_version_id: cur.plan_version_id,
        version_no: versionNo,
        confirmed_at: ctx.now,
        change_summary: rev.change_summary,
        content,
      };
      effects.push({ type: "insert_plan_version", version });
      state.plan.current = version;
      state.plan.history.push(versionMeta(version));
      rev.status = "applied";
      const { changes: _c, fact_changes: _f, ...summary } = rev;
      state.revisions.push(summary);
      state.revision = null;
      for (const id of rev.addressed_issue_ids) {
        const issue = state.issues.find((i) => i.issue_id === id);
        if (!issue || issue.state !== "CHANGE_PENDING") continue;
        issue.applied_revision_ids.push(rev.revision_id);
        setIssueState(issue, "RECHECK_PENDING", `변경 적용(v${versionNo}) — 재검증 대기`, "user", ctx);
      }
      for (const id of rev.change_request_ids) {
        const cr = state.change_requests.find((c) => c.request_id === id);
        if (cr) cr.status = "consumed";
      }
      for (const issue of state.issues) {
        if (issue.state === "RESOLVED" && targetsChangedSince(content, issue.target_claim_ids, issue.resolved_on_version ?? 0)) {
          setIssueState(issue, "RECHECK_PENDING", `전제 변경으로 재개(v${versionNo}에서 대상 항목 변경)`, "system", ctx);
        }
      }
      note(state, ctx, "user", `변경안을 적용했습니다 → 확정 기획 v${versionNo}. ${rev.change_summary}`);
      const targets = judgeTargets(state);
      if (targets.length) {
        enqueue(state, effects, "judge", { issue_ids: targets.map((i) => i.issue_id) }, ctx);
        state.phase = "VERIFYING";
      } else {
        state.phase = "ROUND_SUMMARY";
        note(state, ctx, "moderator", roundSummaryText(state));
      }
      return done();
    }

    case "REJECT_REVISION": {
      requirePhase(state, ["REVISION_CONFIRM"], "변경안 반려");
      noQueued(state);
      const rev = state.revision;
      if (!rev || rev.status !== "pending" || rev.revision_id !== action.payload.revision_id) {
        throw new DomainError("VERSION_CONFLICT", "반려하려는 변경안이 최신이 아닙니다.");
      }
      rev.status = "rejected";
      const { changes: _c, fact_changes: _f, ...summary } = rev;
      state.revisions.push(summary);
      state.revision = null;
      if (action.payload.feedback) {
        note(state, ctx, "user", `변경안 수정 요청: ${action.payload.feedback}`);
        const change = state.issues.filter((i) => i.state === "CHANGE_PENDING");
        enqueue(state, effects, "revise", { issue_ids: change.map((i) => i.issue_id), feedback: action.payload.feedback }, ctx);
      } else {
        note(state, ctx, "user", "변경안을 적용하지 않았습니다. 수용한 쟁점은 변경 대기로 남습니다.");
        state.phase = "WAITING_REPLY";
      }
      return done();
    }

    case "REQUEST_REVIEW": {
      requirePhase(state, ["ROUND_SUMMARY"], "다음 라운드 검토");
      noQueued(state);
      if (state.round >= LIMITS.maxRounds) throw new DomainError("INVALID_TRANSITION", `검토는 최대 ${LIMITS.maxRounds}라운드입니다. 마무리하거나 역할별 추가 검토를 이용해 주세요.`);
      if (state.round === LIMITS.maxRounds - 1) {
        const important = state.issues.filter((i) => ["critical", "major"].includes(i.severity) && ["OPEN", "CHANGE_PENDING", "EVIDENCE_PENDING", "REBUTTAL_PENDING", "RECHECK_PENDING"].includes(i.state));
        if (!important.length) throw new DomainError("INVALID_TRANSITION", "3라운드는 중요한 미해결 쟁점이 남았을 때만 진행합니다. 마무리를 권합니다.");
      }
      startRound(state, effects, ctx);
      return done();
    }

    case "EXTRA_REVIEW": {
      requirePhase(state, ["WAITING_REPLY", "ROUND_SUMMARY"], "역할 추가 검토");
      noQueued(state);
      if (!state.plan.current) throw new DomainError("MINIMUM_INPUT_REQUIRED", "확정된 기획이 있어야 추가 검토를 할 수 있습니다.");
      if (state.pending_mapping) throw new DomainError("INVALID_TRANSITION", "답변 해석을 먼저 확인하거나 취소해 주세요.");
      const rec = currentRound(state)!;
      const role = action.payload.role;
      const run_id = enqueue(state, effects, "review", { role, round: state.round, extra: true }, ctx);
      rec.extra_reviews.push({ role, run_id, status: "pending", at: ctx.now });
      state.candidates = [];
      state.phase = "REVIEWING";
      note(state, ctx, "user", `${ROLE_LABELS[role]} 추가 검토 요청 (기본 라운드 수와 별도로 기록됩니다).`);
      return done();
    }

    case "PROCEED_WITH_MISSING_REVIEW": {
      requirePhase(state, ["REVIEWING"], "누락 기록 후 진행");
      noQueued(state);
      const failed = state.pending_runs.filter((r) => r.task === "review" && r.status === "failed");
      if (!failed.length) throw new DomainError("INVALID_TRANSITION", "실패한 검토가 없습니다.");
      const rec = currentRound(state)!;
      for (const f of failed) {
        const base = rec.review_runs.find((r) => r.run_id === f.run_id);
        if (base) base.status = "missing";
        const extra = rec.extra_reviews.find((r) => r.run_id === f.run_id);
        if (extra) extra.status = "failed";
        if (f.role && !rec.missing_roles.includes(f.role)) rec.missing_roles.push(f.role);
      }
      state.pending_runs = state.pending_runs.filter((r) => !(r.task === "review" && r.status === "failed"));
      note(state, ctx, "user", `검토 누락을 기록하고 진행합니다: ${failed.map((f) => ROLE_LABELS[f.role!]).join(", ")}. 누락이 있으면 '검토 완료'로 표시하지 않습니다.`);
      afterReviews(state, effects, ctx);
      return done();
    }

    case "RETRY_RUN": {
      const pr = state.pending_runs.find((r) => r.run_id === action.payload.run_id);
      if (!pr || pr.status !== "failed") throw new DomainError("INVALID_TRANSITION", "재시도할 수 있는 실패 작업이 아닙니다.");
      const { correction_of: _a, correction_errors: _b, previous_output: _c, ...params } = pr.params;
      const run_id = ctx.newId();
      for (const rec of state.rounds) {
        for (const r of rec.review_runs) if (r.run_id === pr.run_id) Object.assign(r, { run_id, status: "pending" });
        for (const r of rec.extra_reviews) if (r.run_id === pr.run_id) Object.assign(r, { run_id, status: "pending" });
      }
      Object.assign(pr, { run_id, status: "queued", error_code: null, error_message: null, params });
      effects.push({ type: "enqueue_run", run_id, task: pr.task, params });
      note(state, ctx, "user", `실패한 작업을 다시 시도합니다(${pr.task}${pr.role ? ` · ${ROLE_LABELS[pr.role]}` : ""}).`, "note");
      return done();
    }

    case "SET_INTENSITY": {
      requirePhase(state, ["INTAKE", "OUTLINE_CONFIRM", "REVIEWING", "WAITING_REPLY", "REVISION_CONFIRM", "VERIFYING", "ROUND_SUMMARY", "OUTPUT_READY"], "검토 강도 설정");
      state.settings.intensity = action.payload.intensity;
      note(state, ctx, "system", `검토 강도를 ${action.payload.intensity}로 설정했습니다(이후 검토부터 적용, 심각도 기준과 예의는 그대로).`, "note");
      return done();
    }

    case "SET_AUDIENCE": {
      requirePhase(state, ["INTAKE", "OUTLINE_CONFIRM", "REVIEWING", "WAITING_REPLY", "REVISION_CONFIRM", "VERIFYING", "ROUND_SUMMARY", "OUTPUT_READY"], "스토리라인 대상 전환");
      state.settings.storyline_audience = action.payload.audience;
      note(state, ctx, "system", `스토리라인 대상을 ${action.payload.audience === "executive" ? "임원용(본문 7장 이내)" : "유관부서용(본문 10장 이내)"}으로 설정했습니다.${state.phase === "OUTPUT_READY" ? " 반영하려면 '다시 생성'을 눌러 주세요." : ""}`, "note");
      return done();
    }

    case "ADD_SOURCE": {
      requirePhase(state, ["INTAKE", "OUTLINE_CONFIRM", "REVIEWING", "WAITING_REPLY", "REVISION_CONFIRM", "VERIFYING", "ROUND_SUMMARY", "OUTPUT_READY"], "자료 추가");
      addSource(state, effects, action.payload.title, action.payload.text, ctx);
      return done();
    }

    case "FINISH": {
      if (!state.plan.current) {
        if (!state.idea) throw new DomainError("MINIMUM_INPUT_REQUIRED", "아직 기획 아이디어가 없습니다. 아이디어, 해결할 문제, 이번에 받을 결정을 먼저 입력해 주세요. 빈 프로젝트에서 기획 내용을 만들어내지 않습니다.");
        throw new DomainError("MINIMUM_INPUT_REQUIRED", "확정된 기획 뼈대가 없어 산출물을 만들 수 없습니다. 인터뷰에 답하고 기획 뼈대를 확인해 주세요. 없는 기획을 지어내지 않습니다.");
      }
      requirePhase(state, ["REVIEWING", "WAITING_REPLY", "REVISION_CONFIRM", "VERIFYING", "ROUND_SUMMARY"], "마무리");
      const cancel = state.pending_runs.map((r) => r.run_id);
      if (cancel.length) effects.push({ type: "cancel_runs", run_ids: cancel });
      const rec = currentRound(state);
      if (rec) {
        for (const r of rec.review_runs) {
          if (r.status === "pending" || r.status === "failed") {
            r.status = "missing";
            if (!rec.missing_roles.includes(r.role)) rec.missing_roles.push(r.role);
          }
        }
        for (const r of rec.extra_reviews) if (r.status === "pending") r.status = "failed";
      }
      if (state.candidates.length) {
        for (const c of state.candidates) createIssueFromCandidate(state, c, "OPEN", null, ctx);
        note(state, ctx, "system", `정리 전 마무리: 검토 지적 ${state.candidates.length}건을 병합 없이 쟁점으로 기록했습니다.`, "note");
        state.candidates = [];
      }
      if (state.pending_mapping) {
        state.pending_mapping = null;
        note(state, ctx, "system", "확인하지 않은 답변 해석은 적용하지 않았습니다.", "note");
      }
      state.pending_runs = [];
      const reason = computeEndReason(state, action.payload.via_command);
      state.end = { reason, finished_at: ctx.now, via_command: action.payload.via_command };
      note(state, ctx, "user", action.payload.via_command ? "/마무리" : "검토를 마치고 산출물을 만듭니다.");
      if (state.revision?.status === "pending") note(state, ctx, "system", "적용하지 않은 변경안이 있습니다. 산출물에 '미적용 변경안'으로 표시합니다.", "note");
      startGeneration(state, effects, ctx);
      return done();
    }

    case "GENERATE_OUTPUT": {
      requirePhase(state, ["OUTPUT_READY"], "산출물 다시 생성");
      noQueued(state);
      if (!state.end) throw new DomainError("INVALID_TRANSITION", "종료 기록이 없습니다.");
      startGeneration(state, effects, ctx);
      return done();
    }

    case "START_REWORK": {
      requirePhase(state, ["OUTPUT_READY", "GENERATING"], "재작업 시작");
      noQueued(state);
      const cancel = state.pending_runs.map((r) => r.run_id);
      if (cancel.length) effects.push({ type: "cancel_runs", run_ids: cancel });
      state.pending_runs = [];
      state.generation = null;
      state.end = null;
      state.phase = "WAITING_REPLY";
      note(state, ctx, "user", "재작업을 시작합니다. 이전 산출물은 원래 스냅샷 그대로 보존됩니다.");
      return done();
    }

    case "RESUME_REPLY": {
      // 라운드 정리에서 응답으로 돌아가거나, 변경안·판정 작업이 실패했을 때 빠져나오는 경로
      requirePhase(state, ["ROUND_SUMMARY", "REVISION_CONFIRM", "VERIFYING"], "응답 계속");
      noQueued(state);
      if (state.revision?.status === "pending") {
        throw new DomainError("INVALID_TRANSITION", "확인 대기 중인 변경안이 있습니다. 적용하거나 '적용하지 않음'을 선택해 주세요.");
      }
      if (state.pending_runs.length) {
        note(state, ctx, "user", "실패한 AI 작업을 정리하고 응답 단계로 돌아갑니다. 쟁점 상태는 그대로입니다.", "note");
        state.pending_runs = [];
      }
      state.phase = "WAITING_REPLY";
      return done();
    }
  }
}
