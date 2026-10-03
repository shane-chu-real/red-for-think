// 산출물: 논쟁 기록 조립(프로그램), 일관성 검사, Markdown 렌더링
import {
  AUDIENCE_LABELS,
  DECISION_TYPE_LABELS,
  END_REASON_LABELS,
  ISSUE_STATE_LABELS,
  OUTCOME_LABELS,
  ROLE_LABELS,
  SEVERITY_LABELS,
} from "./constants";
import { unresolvedCritical } from "./state";
import type {
  DebateLogContent,
  DecisionStatus,
  OutputRecord,
  PlanContent,
  PlanDocContent,
  ProjectState,
  QaContent,
  StorylineContent,
  ValidationResult,
} from "./types";

const RESPONSE_LABEL: Record<string, string> = {
  accept: "수용",
  rebut: "반박",
  hold: "보류",
  add_info: "정보 추가",
  recheck_request: "재검토 요청",
};

export function buildDebateLog(state: ProjectState, planDoc: PlanDocContent, storyline: StorylineContent): DebateLogContent {
  const byId = new Map(state.issues.map((i) => [i.issue_id, i]));
  return {
    rows: state.issues.map((issue) => {
      const decisions = state.decisions.filter((d) => d.issue_ids.includes(issue.issue_id));
      const judgment = state.judgments.find((j) => j.judgment_id === issue.last_judgment_id);
      const rep = issue.representative_id ? byId.get(issue.representative_id) : undefined;
      const reflected = [
        ...planDoc.sections.filter((s) => s.issue_refs.includes(issue.display_id)).map((s) => `기획서 '${s.title}'`),
        ...storyline.slides.filter((s) => s.issue_refs.includes(issue.display_id)).map((s) => `장표 ${s.slide_id}`),
      ];
      const unref = planDoc.unreflected.find((u) => u.issue_id === issue.display_id)?.reason ?? "";
      let notReflected = "";
      if (!reflected.length) {
        if (issue.state === "MERGED") notReflected = `${rep?.display_id ?? "대표 쟁점"}에 병합되어 대표 쟁점으로 다룸`;
        else notReflected = unref || "반영 위치 없음 (사유 미기재)";
      }
      return {
        display_id: issue.display_id,
        issue: issue.critique,
        role: issue.role,
        severity: issue.severity,
        user_response: decisions.length
          ? decisions.map((d) => `${RESPONSE_LABEL[d.response_type]}${d.quote ? `: ${d.quote}` : ""}`).join(" / ")
          : "미응답",
        state: issue.state,
        judgment_basis: judgment
          ? `${judgment.reason}${judgment.server_note ? ` (서버: ${judgment.server_note})` : ""}${judgment.relies_on_user_confirmation ? " (사용자 진술에 의존)" : ""}`
          : "판정 없음",
        reflected_in: reflected,
        not_reflected_reason: notReflected,
        representative: rep?.display_id ?? null,
      };
    }),
  };
}

// 단위가 붙은 숫자 추출: 사실 목록에 없는 숫자를 '확인 필요'로 표시하기 위함
const NUM_UNIT = /(\d[\d,]*(?:\.\d+)?)\s*(억원|천만원|백만원|만원|억|원|명|%|퍼센트|개월|주|일|년|시간|회|건|개|곳|팀)/g;

function numbersWithUnits(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NUM_UNIT)) out.push(`${m[1].replace(/,/g, "")}${m[2]}`);
  return out;
}

function factNumbers(plan: PlanContent): Set<string> {
  const set = new Set<string>();
  for (const f of plan.facts) {
    const blob = `${f.value}${f.unit} ${f.value} ${f.unit} ${f.label} ${f.note}`;
    for (const n of numbersWithUnits(blob)) set.add(n);
    for (const m of `${f.value}`.matchAll(/\d[\d,]*(?:\.\d+)?/g)) set.add(m[0].replace(/,/g, ""));
  }
  return set;
}

export function validateOutputs(
  state: ProjectState,
  plan: PlanContent,
  planDoc: PlanDocContent,
  storyline: StorylineContent,
  qa: QaContent,
  debate: DebateLogContent,
  now: string,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const issueIds = new Set(state.issues.map((i) => i.display_id));
  const factIds = new Set(plan.facts.map((f) => f.fact_id));
  const sourceIds = new Set(state.sources.map((s) => s.source_id));
  const slideIds = new Set(storyline.slides.map((s) => s.slide_id));

  for (const s of planDoc.sections) {
    for (const r of s.issue_refs) if (!issueIds.has(r)) errors.push(`기획서 '${s.title}'이 없는 쟁점 ${r}을 참조합니다.`);
    for (const r of s.fact_refs) if (!factIds.has(r)) errors.push(`기획서 '${s.title}'이 없는 사실 ${r}을 참조합니다.`);
    for (const r of s.source_refs) if (!sourceIds.has(r)) errors.push(`기획서 '${s.title}'이 없는 출처 ${r}을 참조합니다.`);
  }
  for (const s of storyline.slides) for (const r of s.issue_refs) if (!issueIds.has(r)) errors.push(`장표 ${s.slide_id}이 없는 쟁점 ${r}을 참조합니다.`);
  qa.items.forEach((q, idx) => {
    for (const r of q.slide_ids) if (!slideIds.has(r)) errors.push(`질의응답 ${idx + 1}번이 존재하지 않는 장표 ${r}을 인용합니다.`);
    for (const r of q.evidence_refs) if (!issueIds.has(r) && !factIds.has(r) && !sourceIds.has(r)) errors.push(`질의응답 ${idx + 1}번의 근거 ${r}가 존재하지 않습니다.`);
  });

  const crit = unresolvedCritical(state).map((i) => i.display_id);
  const summary = planDoc.sections.find((s) => s.key === "summary");
  const decision = planDoc.sections.find((s) => s.key === "decision_request");
  for (const id of crit) {
    if (!summary?.issue_refs.includes(id)) errors.push(`미해결 치명 이슈 ${id}가 기획서 요약에 드러나지 않습니다.`);
    if (!decision?.issue_refs.includes(id)) errors.push(`미해결 치명 이슈 ${id}가 의사결정 요청에 드러나지 않습니다.`);
  }
  for (const row of debate.rows) {
    if (row.state !== "MERGED" && !row.reflected_in.length && row.not_reflected_reason.includes("사유 미기재")) {
      warnings.push(`쟁점 ${row.display_id}의 반영 위치나 미반영 이유가 없습니다.`);
    }
  }

  const known = factNumbers(plan);
  const texts = [
    ...planDoc.sections.flatMap((s) => [...s.paragraphs, ...s.bullets]),
    ...storyline.slides.flatMap((s) => [s.headline, ...s.key_points]),
    storyline.one_minute_summary,
    ...qa.items.map((q) => q.answer_30s),
  ];
  const unknownNums = new Set<string>();
  for (const t of texts) {
    for (const n of numbersWithUnits(t)) {
      const bare = n.match(/^[\d.]+/)?.[0] ?? n;
      if (!known.has(n) && !known.has(bare)) unknownNums.add(n);
    }
  }
  if (unknownNums.size) {
    warnings.push(`사실 목록(F)에 없는 숫자 ${unknownNums.size}개: ${[...unknownNums].slice(0, 15).join(", ")} — 출처를 확인해 주세요.`);
  }
  return { errors, warnings, checked_at: now };
}

export function scopeNotes(ds: DecisionStatus): string[] {
  const notes: string[] = [];
  if (ds.end_reason !== "REVIEW_FINISHED") notes.push(`종료 사유: ${END_REASON_LABELS[ds.end_reason]} — 모든 검토를 마친 상태가 아닙니다.`);
  for (const m of ds.missing_reviews) notes.push(`${m.round}라운드 검토 누락: ${m.roles.map((r) => ROLE_LABELS[r]).join(", ")}`);
  if (ds.unapplied_revision) notes.push(`미적용 변경안: ${ds.unapplied_revision.change_summary}`);
  if (ds.unapplied_change_requests.length) notes.push(`반영되지 않은 변경 요청: ${ds.unapplied_change_requests.join(" / ")}`);
  if (ds.change_pending_issue_ids.length) notes.push(`수용했지만 아직 적용되지 않은 쟁점: ${ds.change_pending_issue_ids.join(", ")}`);
  if (ds.unresolved_critical_ids.length) notes.push(`미해결 치명 이슈: ${ds.unresolved_critical_ids.join(", ")}`);
  if (ds.outcome_adjusted_note) notes.push(ds.outcome_adjusted_note);
  return notes;
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(args: {
  title: string;
  record: OutputRecord;
  decisionStatus: DecisionStatus;
  planDoc: PlanDocContent;
  storyline: StorylineContent;
  qa: QaContent;
  debate: DebateLogContent;
}): string {
  const { title, record, decisionStatus: ds, planDoc, storyline, qa, debate } = args;
  const L: string[] = [];
  L.push(`# ${title} — 산출물`);
  L.push("");
  const created = new Date(record.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  L.push(`> 스냅샷 \`${record.output_snapshot_id}\` · 확정 기획 v${record.plan_version_no} · 생성 ${created} (KST) · 스토리라인 대상 ${AUDIENCE_LABELS[record.audience]}`);
  L.push(`> 종료 사유: ${END_REASON_LABELS[ds.end_reason]} · 결과: ${OUTCOME_LABELS[ds.outcome]} · 요청 결정: ${DECISION_TYPE_LABELS[ds.decision_type]}`);
  L.push("> 토론을 마쳤다는 것은 추진 승인이나 사실 검증 완료를 뜻하지 않습니다.");
  const notes = scopeNotes(ds);
  if (notes.length) {
    L.push("", "## 검토 범위와 한계", "", ...notes.map((n) => `- ${n}`));
  }
  L.push("", "## 1. 상세 기획서");
  for (const s of planDoc.sections) {
    L.push("", `### ${s.title}`);
    for (const p of s.paragraphs) L.push("", p);
    if (s.bullets.length) L.push("", ...s.bullets.map((b) => `- ${b}`));
    const refs = [...s.issue_refs, ...s.fact_refs, ...s.source_refs];
    if (refs.length) L.push("", `<sub>참조: ${refs.join(", ")}</sub>`);
  }
  L.push("", `## 2. PPT 스토리라인 (${AUDIENCE_LABELS[storyline.audience]})`, "", "| 장표 | 헤드라인 | 핵심 내용 | 시각화 제안 | 관련 쟁점 |", "|---|---|---|---|---|");
  for (const s of storyline.slides) {
    L.push(`| ${s.slide_id}${s.appendix ? " (부록)" : ""} | ${esc(s.headline)} | ${esc(s.key_points.join(" · "))} | ${esc(s.visual)} | ${s.issue_refs.join(", ")} |`);
  }
  L.push("", "### 헤드라인 테스트", "", ...storyline.slides.filter((s) => !s.appendix).map((s, i) => `${i + 1}. ${s.headline}`));
  L.push("", "### 임원용 1분 요약", "", storyline.one_minute_summary);
  L.push("", "## 3. 예상 질의응답", "", "| # | 질문 | 예상 질문자 | 30초 답변 | 근거 | 장표 |", "|---|---|---|---|---|---|");
  qa.items.forEach((q, i) => {
    L.push(`| ${i + 1} | ${esc(q.question)} | ${esc(q.asker_role)} | ${esc(q.answer_30s)} | ${q.evidence_refs.join(", ")} | ${q.slide_ids.join(", ")} |`);
  });
  L.push("", "## 4. 논쟁 기록", "", "| ID | 쟁점 | 역할 | 심각도 | 사용자 대응 | 상태 | 판정 근거 | 반영 위치 / 미반영 이유 |", "|---|---|---|---|---|---|---|---|");
  for (const r of debate.rows) {
    const where = r.reflected_in.length ? r.reflected_in.join(", ") : r.not_reflected_reason;
    L.push(`| ${r.display_id} | ${esc(r.issue)} | ${ROLE_LABELS[r.role]} | ${SEVERITY_LABELS[r.severity]} | ${esc(r.user_response)} | ${ISSUE_STATE_LABELS[r.state]}${r.representative ? `→${r.representative}` : ""} | ${esc(r.judgment_basis)} | ${esc(where)} |`);
  }
  L.push("", "## 산출물 검사 결과", "");
  if (!record.validation.errors.length && !record.validation.warnings.length) L.push("- 구조 검사 통과 (내용의 사실 여부를 보증하지 않습니다)");
  for (const e of record.validation.errors) L.push(`- 오류: ${e}`);
  for (const w of record.validation.warnings) L.push(`- 확인 필요: ${w}`);
  L.push("");
  return L.join("\n");
}
