// 개발용 모의 응답 — 실제 AI가 아니다. 화면·저장·상태 흐름 검증용이며 결과에 [모의] 표시를 붙인다.
import { PLAN_DOC_KEYS, PLAN_DOC_TITLES, ROLE_LABELS, type Role } from "./constants";
import type { RunPayload } from "./prompts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ctx = Record<string, any>;

const ROLE_SECTION: Record<Role, string> = {
  finance: "resources",
  risk: "execution",
  field: "execution",
  executive: "decision",
  it: "execution",
};

function intake(c: Ctx) {
  if (c.batch_no === 1) {
    return {
      questions: [
        { text: "[모의] 대상 인원·범위와 시기는 어떻게 되나요?", why: "자원과 일정을 산정하려면 필요합니다." },
        { text: "[모의] 이번 보고에서 받을 결정은 탐색·파일럿·확대 중 무엇인가요?", why: "결정에 따라 필요한 근거 수준이 다릅니다." },
      ],
      info_items: [{ kind: "user_statement", text: c.project.idea }],
      ready_for_outline: false,
      type_suggestion: null,
      note: "",
    };
  }
  return { questions: [], info_items: [], ready_for_outline: true, type_suggestion: null, note: "[모의] 뼈대를 쓸 만큼 정보가 모였습니다." };
}

function outline(c: Ctx) {
  const blob = [c.project.idea, c.project.problem, ...(c.intake_answers ?? []).map((a: any) => a.answer), c.feedback ?? ""].join(" ");
  const people = blob.match(/(\d[\d,]*)\s*명/);
  const facts: any[] = [];
  if (people) facts.push({ key: "f1", label: "대상 인원", value: people[1].replace(/,/g, ""), unit: "명", kind: "user_statement", area: "people", source_refs: [], note: "" });
  facts.push({ key: "f2", label: "예산", value: "미정", unit: "원", kind: "unknown", area: "budget", source_refs: [], note: "확인 필요" });
  const resourceText = people ? `[모의] 대상 인원 ${people[1].replace(/,/g, "")}명, 예산은 미정입니다.` : "[모의] 인원과 예산은 미정입니다.";
  const decision = c.project.requested_decision && c.project.requested_decision !== "(미입력)" ? c.project.requested_decision : "이번에 받을 결정은 미정입니다.";
  return {
    core_message: `[모의] ${String(c.project.idea).slice(0, 60)}${c.feedback ? " (수정 반영)" : ""}`,
    requested_decision: decision,
    sections: [
      { key: "problem", claims: [{ text: `[모의] ${c.project.problem !== "(미입력)" ? c.project.problem : c.project.idea}`, kind: "user_statement", source_refs: [], fact_keys: [] }] },
      { key: "decision", claims: [{ text: `[모의] ${decision}`, kind: "user_statement", source_refs: [], fact_keys: [] }] },
      { key: "alternatives", claims: [{ text: "[모의] 현상 유지와 축소안 대비 비교가 필요합니다.", kind: "assumption", source_refs: [], fact_keys: [] }] },
      { key: "execution", claims: [{ text: `[모의] ${String(c.project.idea).slice(0, 80)}`, kind: "user_statement", source_refs: [], fact_keys: [] }] },
      { key: "goals", claims: [{ text: "[모의] 성과 지표와 목표값은 미정입니다.", kind: "unknown", source_refs: [], fact_keys: [] }] },
      { key: "resources", claims: [{ text: resourceText, kind: people ? "user_statement" : "unknown", source_refs: [], fact_keys: people ? ["f1", "f2"] : ["f2"] }] },
      { key: "assumptions", claims: [{ text: "[모의] 현업 참여 시간이 확보된다고 가정합니다.", kind: "assumption", source_refs: [], fact_keys: [] }] },
      { key: "stop_conditions", claims: [{ text: "[모의] 중단·전환 기준은 미정입니다.", kind: "unknown", source_refs: [], fact_keys: [] }] },
    ],
    facts,
  };
}

function review(c: Ctx, role: Role) {
  if ((c.round ?? 1) > 1) return { findings: [], no_findings_reason: "[모의] 이전 지적 외에 새 지적이 없습니다." };
  const sections = c.plan.sections as any[];
  const claim = sections.find((s) => s.key === ROLE_SECTION[role])?.claims[0] ?? sections.flatMap((s) => s.claims)[0];
  const severity = role === "finance" || role === "executive" ? "critical" : "major";
  return {
    findings: [
      {
        severity,
        target_claim_ids: [claim.claim_id],
        critique: `[모의] ${ROLE_LABELS[role]} 관점: '${String(claim.text).slice(0, 30)}'의 근거가 부족합니다.`,
        reason: "[모의] 결정을 판단할 근거 자료가 제시되지 않았습니다.",
        source_refs: [],
        uncertainties: "[모의] 관련 자료가 제공되지 않았습니다.",
        expected_question: `[모의] ${ROLE_LABELS[role]}: 이 판단의 근거는 무엇인가요?`,
        resolution_conditions: ["근거 자료나 수치를 기획에 명시", "확인 주체와 방법을 명시"],
        reopen_issue_id: null,
        reopen_reason: "",
      },
    ],
    no_findings_reason: "",
  };
}

const RESP: Record<string, string> = { 수용: "accept", 반박: "rebut", 보류: "hold", 추가: "add_info" };

function mapReply(c: Ctx) {
  const text: string = c.reply_text ?? "";
  const ids: string[] = (c.displayed_issues ?? []).map((i: any) => i.issue_id);
  const mappings: any[] = [];
  const unanswered: string[] = [];
  for (const id of ids) {
    const m = text.match(new RegExp(`${id}\\s*[:：]?\\s*(수용|반박|보류|추가)([^\\n;]*)`));
    if (m) mappings.push({ issue_id: id, response_type: RESP[m[1]], interpreted_action: `[모의] ${m[1]} 처리`, quote: m[0].trim() });
    else unanswered.push(id);
  }
  if (/모두\s*수용/.test(text)) {
    for (const id of unanswered.splice(0)) mappings.push({ issue_id: id, response_type: "accept", interpreted_action: "[모의] 수용 처리", quote: "모두 수용" });
  }
  const change_requests = text
    .split(/[\n.;]/)
    .map((s) => s.trim())
    .filter((s) => s && !/I-\d{3}/.test(s) && /(바꿔|변경|줄여|늘려|명으로)/.test(s));
  return { mappings, unanswered_issue_ids: unanswered, clarifications: [], change_requests };
}

function revise(c: Ctx) {
  const claims = (c.plan.sections as any[]).flatMap((s) => s.claims);
  const changes = (c.issues_to_address as any[]).map((i) => {
    const claim = claims.find((x) => x.claim_id === i.target_claim_ids[0]) ?? claims[0];
    return {
      op: "modify",
      claim_id: claim.claim_id,
      section_key: null,
      text: `${claim.text} (보완: ${i.resolution_conditions[0] ?? "근거 명시"})`,
      kind: claim.kind,
      fact_refs: claim.fact_refs,
      source_refs: claim.source_refs,
    };
  });
  const fact_changes: any[] = [];
  const cascade: any[] = [];
  for (const cr of c.change_requests as string[]) {
    const m = cr.match(/(\d[\d,]*)\s*명/);
    const people = (c.plan.facts as any[]).find((f) => f.area === "people");
    if (m && people) {
      const after = m[1].replace(/,/g, "");
      fact_changes.push({ op: "modify", fact_id: people.fact_id, label: people.label, value: after, unit: "명", kind: "user_statement", area: "people", note: "사용자 변경 요청", source_refs: [] });
      cascade.push({ area: "people", before: `${people.value}${people.unit}`, after: `${after}명`, note: "" });
      const budget = (c.plan.facts as any[]).find((f) => f.area === "budget");
      if (budget) cascade.push({ area: "budget", before: `${budget.value}`, after: "미정", note: "인원 변경에 따라 재산정 필요" });
      cascade.push({ area: "schedule", before: "미정", after: "미정", note: "파일럿 일정 재확인 필요" });
    }
  }
  return {
    change_summary: `[모의] 수용 ${changes.length}건 반영${fact_changes.length ? ", 인원 변경 요청 반영" : ""}`,
    core_message: null,
    requested_decision: null,
    changes,
    fact_changes,
    cascade_impacts: cascade,
    addressed_issue_ids: (c.issues_to_address as any[]).map((i) => i.issue_id),
    unaddressed: [],
  };
}

function judge(c: Ctx) {
  return {
    judgments: (c.issues as any[]).map((i) => {
      const accepted = (i.decisions as any[]).some((d) => d.response_type === "accept") && i.revision_applied;
      let result: "met" | "unmet" | "unknown" = "unmet";
      let proposed: "RESOLVED" | "UNRESOLVED" | "WITHDRAWN" = "UNRESOLVED";
      let follow: string | null = null;
      let reason = "[모의] 해소 조건을 충족하는 근거가 없습니다.";
      if (accepted) {
        result = "met";
        proposed = "RESOLVED";
        reason = "[모의] 적용된 변경이 해소 조건을 충족합니다.";
      } else if (i.state === "REBUTTAL_PENDING") {
        if (i.follow_up_allowed && !i.follow_up) {
          follow = "[모의] 반박을 뒷받침할 자료나 사례가 있나요?";
          reason = "[모의] 반박의 근거 설명이 더 필요합니다.";
          result = "unknown";
        } else {
          proposed = "WITHDRAWN";
          result = "met";
          reason = "[모의] 반박이 타당하여 지적을 철회합니다.";
        }
      } else if ((i.evidence_notes as any[]).length) {
        result = "unknown";
        reason = "[모의] 추가 정보만으로는 판단할 수 없습니다.";
      }
      return {
        issue_id: i.issue_id,
        condition_results: (i.resolution_conditions as any[]).map((cond) => ({ condition_id: cond.condition_id, result, reason, refs: [] })),
        proposed_state: proposed,
        reason,
        follow_up_question: follow,
        relies_on_user_confirmation: !accepted,
      };
    }),
  };
}

function assess(c: Ctx) {
  const crit: string[] = c.unresolved_critical ?? [];
  const missing: any[] = c.missing_reviews ?? [];
  return {
    outcome: crit.length || missing.length ? "CONDITIONAL" : "RESOLVED_CORE",
    rationale: "[모의] 미해결 쟁점과 검토 범위를 기준으로 판단했습니다.",
    decision_type: "pilot",
    decision_text: "[모의] 파일럿 범위와 예산 승인",
    conditions: crit.map((id) => `${id} 확인 후 결정`),
    stop_switch_criteria: ["[모의] 파일럿 지표 미달 시 중단·전환"],
  };
}

function planDoc(c: Ctx) {
  const crit: string[] = c.unresolved_critical ?? [];
  const live = (c.issues as any[]).filter((i) => i.state !== "WITHDRAWN");
  return {
    sections: PLAN_DOC_KEYS.map((key) => ({
      key,
      paragraphs: [`[모의] ${PLAN_DOC_TITLES[key]}: ${c.plan.core_message}`],
      bullets: [],
      issue_refs: key === "summary" || key === "decision_request" ? crit : key === "risks" ? live.map((i) => i.issue_id) : [],
      fact_refs: key === "budget_effect" || key === "organization" ? (c.plan.facts as any[]).map((f) => f.fact_id) : [],
      source_refs: [],
    })),
    unreflected: (c.issues as any[]).filter((i) => i.state === "WITHDRAWN").map((i) => ({ issue_id: i.issue_id, reason: "[모의] 철회된 지적이라 본문에 넣지 않았습니다." })),
  };
}

function storyline(c: Ctx) {
  const crit: string[] = c.unresolved_critical ?? [];
  const heads = ["결론과 요청 결정", "왜 지금인가", "문제와 근거", "대안 비교와 실행 계획", "리스크와 확인 조건"];
  return {
    slides: [
      ...heads.map((h, idx) => ({ headline: `[모의] ${h}`, key_points: ["[모의] 핵심 내용"], visual: "[모의] 요약 카드", issue_refs: idx === 4 ? crit : [], appendix: false })),
      { headline: "[모의] 부록: 예상 질문별 백업", key_points: ["[모의] 백업 자료"], visual: "[모의] 표", issue_refs: [], appendix: true },
    ],
    one_minute_summary: "[모의] 1분 요약입니다. 실제 AI 응답이 아닙니다.",
  };
}

function qa(c: Ctx) {
  const slides = (c.slides as any[]).filter((s) => !s.appendix).slice(0, 3);
  return {
    items: slides.map((s, idx) => ({
      question: `[모의] 예상 질문 ${idx + 1}`,
      asker_role: "경영진",
      answer_30s: "[모의] 현재 확인된 범위와 다음 확인 행동으로 답합니다.",
      evidence_refs: [],
      slide_ids: [s.slide_id],
    })),
  };
}

export function mockOutput(payload: RunPayload): string {
  const c = payload.context as Ctx;
  const out = (() => {
    switch (payload.task) {
      case "intake":
        return intake(c);
      case "outline":
        return outline(c);
      case "review":
        return review(c, payload.role as Role);
      case "consolidate":
        return { groups: [], existing_links: [], order: (c.candidates as any[]).map((x) => x.key) };
      case "map_reply":
        return mapReply(c);
      case "revise":
        return revise(c);
      case "judge":
        return judge(c);
      case "assess":
        return assess(c);
      case "plan_doc":
        return planDoc(c);
      case "storyline":
        return storyline(c);
      case "qa":
        return qa(c);
    }
  })();
  return JSON.stringify(out);
}
