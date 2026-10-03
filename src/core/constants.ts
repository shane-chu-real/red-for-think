// 도메인 상수 — 웹과 실행기가 함께 쓴다.

export const SCHEMA_VERSION = 1;
export const PROMPT_VERSION = "p1";

export const ROLES = ["finance", "risk", "field", "executive", "it"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  finance: "재무",
  risk: "리스크",
  field: "현업·사용자",
  executive: "경영진",
  it: "IT",
};

export const ACTOR_LABELS: Record<string, string> = {
  ...ROLE_LABELS,
  moderator: "진행자",
  writer: "작성자",
  user: "나",
  system: "시스템",
};

export const PROJECT_TYPES = ["ai_task", "education", "new_business"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  ai_task: "사내 AI 과제",
  education: "교육 과정",
  new_business: "신규 사업·서비스",
};

// 유형별 중점 검토 역할 (설계서 부록 A.5)
export const FOCUS_ROLES: Record<ProjectType, Role[]> = {
  ai_task: ["risk", "it"],
  education: ["field", "finance"],
  new_business: ["executive", "finance"],
};

export const AUDIENCES = ["executive", "department"] as const;
export type Audience = (typeof AUDIENCES)[number];
export const AUDIENCE_LABELS: Record<Audience, string> = {
  executive: "임원",
  department: "팀장·유관부서",
};

export const PHASES = [
  "INTAKE",
  "OUTLINE_CONFIRM",
  "REVIEWING",
  "WAITING_REPLY",
  "REVISION_CONFIRM",
  "VERIFYING",
  "ROUND_SUMMARY",
  "GENERATING",
  "OUTPUT_READY",
] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_LABELS: Record<Phase, string> = {
  INTAKE: "인터뷰",
  OUTLINE_CONFIRM: "뼈대 확인",
  REVIEWING: "역할별 검토",
  WAITING_REPLY: "대응 입력",
  REVISION_CONFIRM: "변경안 확인",
  VERIFYING: "재검증",
  ROUND_SUMMARY: "라운드 정리",
  GENERATING: "산출물 생성",
  OUTPUT_READY: "산출물 확인",
};

export const SEVERITIES = ["critical", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "치명",
  major: "보완",
  minor: "사소",
};
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, major: 1, minor: 2 };

export const ISSUE_STATES = [
  "OPEN",
  "CHANGE_PENDING",
  "EVIDENCE_PENDING",
  "REBUTTAL_PENDING",
  "RECHECK_PENDING",
  "RESOLVED",
  "WITHDRAWN",
  "MERGED",
] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

// 치명 미해결 집계에 포함되는 상태 (MERGED는 대표만 집계)
export const UNRESOLVED_STATES: IssueState[] = [
  "OPEN",
  "CHANGE_PENDING",
  "EVIDENCE_PENDING",
  "REBUTTAL_PENDING",
  "RECHECK_PENDING",
];

export const ISSUE_STATE_LABELS: Record<IssueState, string> = {
  OPEN: "미대응",
  CHANGE_PENDING: "수용·변경 대기",
  EVIDENCE_PENDING: "보류·근거 대기",
  REBUTTAL_PENDING: "반박 검토 대기",
  RECHECK_PENDING: "재검증 대기",
  RESOLVED: "해소",
  WITHDRAWN: "철회",
  MERGED: "병합됨",
};

export const INFO_KINDS = ["document", "user_statement", "goal", "assumption", "unknown", "calculation"] as const;
export type InfoKind = (typeof INFO_KINDS)[number];
export const INFO_KIND_LABELS: Record<InfoKind, string> = {
  document: "문서 근거",
  user_statement: "사용자 진술",
  goal: "목표",
  assumption: "가정",
  unknown: "미확인",
  calculation: "계산",
};

export const FACT_AREAS = ["people", "budget", "schedule", "kpi", "other"] as const;
export type FactArea = (typeof FACT_AREAS)[number];
export const FACT_AREA_LABELS: Record<FactArea, string> = {
  people: "인원",
  budget: "예산",
  schedule: "일정",
  kpi: "목표·KPI",
  other: "기타",
};

// 기획 뼈대 섹션 (작성자 지침: 핵심 메시지 + 8개 섹션)
export const SECTION_KEYS = [
  "problem",
  "decision",
  "alternatives",
  "execution",
  "goals",
  "resources",
  "assumptions",
  "stop_conditions",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export const SECTION_TITLES: Record<SectionKey, string> = {
  problem: "문제와 근거",
  decision: "요청 결정",
  alternatives: "대안 비교(현상 유지 포함)",
  execution: "실행 개요",
  goals: "목표와 측정",
  resources: "자원(인원·예산·일정)",
  assumptions: "주요 가정",
  stop_conditions: "중단·전환 조건",
};

// 상세 기획서 목차 (설계서 부록 A.4)
export const PLAN_DOC_KEYS = [
  "summary",
  "background",
  "current_problem",
  "goals_kpi",
  "approach_alternatives",
  "organization",
  "schedule",
  "budget_effect",
  "risks",
  "to_confirm",
  "decision_request",
] as const;
export type PlanDocKey = (typeof PLAN_DOC_KEYS)[number];
export const PLAN_DOC_TITLES: Record<PlanDocKey, string> = {
  summary: "요약",
  background: "추진 배경",
  current_problem: "현황과 문제",
  goals_kpi: "목표와 성공 지표",
  approach_alternatives: "추진 방안과 대안 비교",
  organization: "추진 체계",
  schedule: "일정",
  budget_effect: "예산과 기대효과",
  risks: "리스크와 대응",
  to_confirm: "확인 필요 사항",
  decision_request: "의사결정 요청",
};

export const TASKS = [
  "intake",
  "outline",
  "review",
  "consolidate",
  "map_reply",
  "revise",
  "judge",
  "assess",
  "plan_doc",
  "storyline",
  "qa",
] as const;
export type Task = (typeof TASKS)[number];
export const TASK_LABELS: Record<Task, string> = {
  intake: "인터뷰 질문",
  outline: "기획 뼈대 작성",
  review: "역할별 검토",
  consolidate: "지적 정리",
  map_reply: "답변 해석",
  revise: "변경안 작성",
  judge: "해소 판정",
  assess: "결과 판단",
  plan_doc: "상세 기획서",
  storyline: "PPT 스토리라인",
  qa: "예상 질의응답",
};

// 작업이 유효한 단계. 단계가 넘어가면 남은 작업(실패 포함)은 정리하고, 다른 단계에서는 재시도·반영하지 않는다.
export const TASK_PHASES: Record<Task, Phase[]> = {
  intake: ["INTAKE"],
  outline: ["OUTLINE_CONFIRM"],
  review: ["REVIEWING"],
  consolidate: ["REVIEWING"],
  map_reply: ["WAITING_REPLY"],
  revise: ["REVISION_CONFIRM"],
  judge: ["VERIFYING"],
  assess: ["GENERATING"],
  plan_doc: ["GENERATING"],
  storyline: ["GENERATING"],
  qa: ["GENERATING"],
};

export const END_REASONS =["REVIEW_FINISHED", "PENDING_EXTERNAL_CHECK", "ROUND_LIMIT", "USER_FINISHED"] as const;
export type EndReason = (typeof END_REASONS)[number];
export const END_REASON_LABELS: Record<EndReason, string> = {
  REVIEW_FINISHED: "검토 완료",
  PENDING_EXTERNAL_CHECK: "외부 확인 대기",
  ROUND_LIMIT: "라운드 상한 도달",
  USER_FINISHED: "사용자 마무리",
};

export const OUTCOMES = ["RESOLVED_CORE", "CONDITIONAL", "REDESIGN_OR_STOP"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_LABELS: Record<Outcome, string> = {
  RESOLVED_CORE: "핵심 쟁점 해소",
  CONDITIONAL: "조건부 진행 또는 확인 필요",
  REDESIGN_OR_STOP: "재설계 또는 중단 권고",
};

export const DECISION_TYPES = ["explore", "pilot", "scale", "stop", "other"] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];
export const DECISION_TYPE_LABELS: Record<DecisionType, string> = {
  explore: "탐색 승인",
  pilot: "파일럿 범위·예산 승인",
  scale: "확대 여부 판단",
  stop: "중단·전환 결정",
  other: "기타 결정",
};

export const LIMITS = {
  maxRounds: 3,
  maxIntakeQuestions: 5,
  maxIntakeBatches: 2,
  baseRoleFindings: 2,
  focusRoleFindings: 3,
  displayBatch: 5,
  maxFollowUps: 1,
  sourceMaxChars: 20000,
  sourcesTotalMaxChars: 60000,
  textMaxChars: 8000,
  execMainSlides: 7,
  deptMainSlides: 10,
  qaMaxItems: 12,
  timelineMax: 300,
} as const;
