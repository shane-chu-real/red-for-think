import type {
  Audience,
  DecisionType,
  EndReason,
  FactArea,
  InfoKind,
  IssueState,
  Outcome,
  Phase,
  PlanDocKey,
  ProjectType,
  Role,
  SectionKey,
  Severity,
  Task,
} from "./constants";

// ── 기획 내용 ────────────────────────────────────────────

export interface Claim {
  claim_id: string;
  text: string;
  kind: InfoKind;
  source_refs: string[];
  fact_refs: string[];
  updated_in_version: number; // 마지막으로 바뀐 기획 버전 번호 (전제 변경 판정용)
}

export interface Section {
  section_id: string;
  key: SectionKey;
  title: string;
  claims: Claim[];
}

export interface Fact {
  fact_id: string;
  label: string;
  value: string;
  unit: string;
  kind: InfoKind;
  area: FactArea;
  source_refs: string[];
  note: string;
  updated_in_version: number;
}

export interface PlanContent {
  core_message: string;
  requested_decision: string;
  sections: Section[];
  facts: Fact[];
}

export interface PlanVersionState {
  plan_version_id: string;
  parent_version_id: string | null;
  version_no: number;
  confirmed_at: string;
  change_summary: string;
  content: PlanContent;
}

// ── 인테이크 ─────────────────────────────────────────────

export interface IntakeQuestion {
  question_id: string;
  text: string;
  why: string;
  batch: number;
  answer: string | null;
}

export interface InfoItem {
  item_id: string;
  kind: InfoKind;
  text: string;
  origin: "user" | "ai";
}

// ── 쟁점·대응·판정 ───────────────────────────────────────

export interface ResolutionCondition {
  condition_id: string;
  text: string;
}

export interface IssueHistoryEntry {
  at: string;
  from: IssueState | null;
  to: IssueState;
  reason: string;
  actor: string;
}

export interface Issue {
  issue_id: string;
  display_id: string;
  role: Role;
  severity: Severity;
  target_claim_ids: string[];
  headline?: string; // 한 줄 의견. p3 이전에 만든 쟁점에는 없다.
  critique: string;
  reason: string;
  source_refs: string[];
  uncertainties: string;
  expected_question: string;
  resolution_conditions: ResolutionCondition[];
  state: IssueState;
  representative_id: string | null;
  round: number;
  extra: boolean;
  raised_on_version: number;
  created_at: string;
  history: IssueHistoryEntry[];
  follow_up: { question: string; asked_at: string; answer: string | null } | null;
  follow_ups_used: number;
  applied_revision_ids: string[];
  resolved_on_version: number | null;
  last_judgment_id: string | null;
  rebuttal: string | null;
  evidence_notes: string[];
}

export type ResponseType = "accept" | "rebut" | "hold" | "add_info" | "recheck_request";

export interface Decision {
  decision_id: string;
  issue_ids: string[];
  response_type: ResponseType;
  original_reply: string; // 사용자가 입력한 원문 전체 (보존)
  quote: string; // 이 쟁점에 해당하는 부분
  interpreted_action: string;
  user_confirmed: boolean;
  via: "button" | "text";
  plan_version_id: string | null;
  created_at: string;
}

export type ConditionResult = "met" | "unmet" | "unknown";

export interface Judgment {
  judgment_id: string;
  issue_id: string;
  plan_version_id: string;
  condition_results: { condition_id: string; result: ConditionResult; reason: string; refs: string[] }[];
  proposed_state: "RESOLVED" | "UNRESOLVED" | "WITHDRAWN";
  applied_state: IssueState;
  reason: string;
  server_note: string;
  relies_on_user_confirmation: boolean;
  ai_run_id: string;
  created_at: string;
}

export interface Candidate {
  key: string;
  run_id: string;
  role: Role;
  round: number;
  extra: boolean;
  severity: Severity;
  target_claim_ids: string[];
  headline: string;
  critique: string;
  reason: string;
  source_refs: string[];
  uncertainties: string;
  expected_question: string;
  resolution_conditions: string[];
  reopen_issue_id: string | null;
  reopen_reason: string;
}

// ── 변경안 ───────────────────────────────────────────────

export interface PlanChange {
  op: "modify" | "add" | "remove";
  claim_id: string | null;
  section_key: SectionKey | null;
  text: string;
  kind: InfoKind;
  fact_refs: string[];
  source_refs: string[];
}

export interface FactChange {
  op: "modify" | "add" | "remove";
  fact_id: string | null;
  label: string;
  value: string;
  unit: string;
  kind: InfoKind;
  area: FactArea;
  note: string;
  source_refs: string[];
}

export interface CascadeImpact {
  area: FactArea;
  before: string;
  after: string;
  note: string;
}

export interface RevisionProposal {
  revision_id: string;
  run_id: string;
  base_plan_version_id: string;
  change_summary: string;
  core_message: string | null;
  requested_decision: string | null;
  changes: PlanChange[];
  fact_changes: FactChange[];
  cascade_impacts: CascadeImpact[];
  addressed_issue_ids: string[];
  unaddressed: { issue_id: string; reason: string }[];
  change_request_ids: string[];
  status: "pending" | "applied" | "rejected";
  created_at: string;
}

export interface ChangeRequest {
  request_id: string;
  text: string;
  status: "pending" | "consumed" | "dropped"; // dropped: 변경안을 적용하지 않기로 해 함께 종료됨
  created_at: string;
}

export interface ReplyMapping {
  mapping_id: string;
  run_id: string;
  reply_text: string;
  items: { issue_id: string; response_type: Exclude<ResponseType, "recheck_request">; interpreted_action: string; quote: string }[];
  unanswered_issue_ids: string[];
  clarifications: { issue_ids: string[]; question: string }[];
  change_requests: string[];
  created_at: string;
}

// ── 라운드·작업 ──────────────────────────────────────────

export interface RoundRecord {
  round: number;
  plan_version_id: string;
  started_at: string;
  review_runs: { role: Role; run_id: string; status: "pending" | "succeeded" | "failed" | "missing" }[];
  extra_reviews: { role: Role; run_id: string; status: "pending" | "succeeded" | "failed"; at: string }[];
  missing_roles: Role[];
}

export interface PendingRun {
  run_id: string;
  task: Task;
  role: Role | null;
  status: "queued" | "failed";
  error_code: string | null;
  error_message: string | null;
  params: RunParams;
}

export interface RunParams {
  role?: Role;
  round?: number;
  extra?: boolean;
  feedback?: string;
  issue_ids?: string[];
  reply_text?: string;
  correction_of?: string;
  correction_errors?: string[];
  previous_output?: string;
}

// ── 종료·산출 ────────────────────────────────────────────

export interface DecisionStatus {
  end_reason: EndReason;
  outcome: Outcome;
  outcome_rationale: string;
  outcome_adjusted_note: string;
  decision_type: DecisionType;
  decision_text: string;
  conditions: string[];
  stop_switch_criteria: string[];
  missing_reviews: { round: number; roles: Role[] }[];
  unapplied_revision: { revision_id: string; change_summary: string } | null;
  unapplied_change_requests: string[];
  change_pending_issue_ids: string[];
  unresolved_critical_ids: string[];
  rounds_completed: number;
}

export interface PlanDocSection {
  key: PlanDocKey;
  title: string;
  paragraphs: string[];
  bullets: string[];
  issue_refs: string[];
  fact_refs: string[];
  source_refs: string[];
}

export interface PlanDocContent {
  sections: PlanDocSection[];
  unreflected: { issue_id: string; reason: string }[];
}

export interface Slide {
  slide_id: string;
  headline: string;
  key_points: string[];
  visual: string;
  issue_refs: string[];
  appendix: boolean;
}

export interface StorylineContent {
  audience: Audience;
  slides: Slide[];
  one_minute_summary: string;
}

export interface QaItem {
  question: string;
  asker_role: string;
  answer_30s: string;
  evidence_refs: string[];
  slide_ids: string[];
}

export interface QaContent {
  items: QaItem[];
}

export interface DebateLogRow {
  display_id: string;
  issue: string;
  role: Role;
  severity: Severity;
  user_response: string;
  state: IssueState;
  judgment_basis: string;
  reflected_in: string[];
  not_reflected_reason: string;
  representative: string | null;
}

export interface DebateLogContent {
  rows: DebateLogRow[];
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  checked_at: string;
}

export interface Generation {
  generation_id: string;
  plan_version_id: string;
  audience: Audience;
  status: "assessing" | "writing" | "ready" | "failed";
  output_snapshot_id: string | null;
  decision_status: DecisionStatus | null;
  plan_doc: PlanDocContent | null;
  storyline: StorylineContent | null;
  qa: QaContent | null;
  started_at: string;
}

export interface OutputRecord {
  output_snapshot_id: string;
  plan_version_id: string;
  plan_version_no: number;
  audience: Audience;
  created_at: string;
  artifact_ids: Record<"plan_doc" | "storyline" | "qa" | "debate_log", string>;
  validation: ValidationResult;
  end_reason: EndReason;
  outcome: Outcome;
}

export interface TimelineEntry {
  at: string;
  actor: string;
  kind: "message" | "note" | "error";
  text: string;
}

// ── 프로젝트 상태 (projects.state) ──────────────────────

export interface ProjectState {
  schema_version: number;
  project_id: string;
  title: string;
  type: ProjectType;
  idea: string;
  problem: string;
  requested_decision: string;
  audience: Audience;
  phase: Phase;
  round: number;
  settings: { intensity: 1 | 2 | 3; storyline_audience: Audience };
  intake: { batches: number; questions: IntakeQuestion[]; info_items: InfoItem[] };
  sources: SourceMeta[];
  outline_draft: { draft_id: string; run_id: string; content: PlanContent; created_at: string } | null;
  // removed_claims: 삭제된 항목 ID → 삭제된 기획 버전 번호 (전제 변경 판정용)
  plan: { current: PlanVersionState | null; history: Omit<PlanVersionState, "content">[]; removed_claims?: Record<string, number> };
  issues: Issue[];
  decisions: Decision[];
  judgments: Judgment[];
  candidates: Candidate[];
  revision: RevisionProposal | null;
  revisions: Omit<RevisionProposal, "changes" | "fact_changes">[];
  change_requests: ChangeRequest[];
  pending_mapping: ReplyMapping | null;
  rounds: RoundRecord[];
  pending_runs: PendingRun[];
  end: { reason: EndReason; finished_at: string; via_command: boolean } | null;
  generation: Generation | null;
  outputs: OutputRecord[];
  timeline: TimelineEntry[];
  counters: { issue: number; claim: number; fact: number; source: number; question: number; item: number };
  created_at: string;
  updated_at: string;
}

export interface SourceMeta {
  source_id: string;
  title: string;
  char_count: number;
  content_hash: string;
  created_at: string;
  revision_of: string | null;
}

export interface SourceDoc extends SourceMeta {
  body: string;
}

// ── 리듀서 입출력 ────────────────────────────────────────

export interface ReduceContext {
  now: string;
  newId: () => string;
}

export type Effect =
  | { type: "insert_source"; source: SourceDoc }
  | { type: "insert_plan_version"; version: PlanVersionState }
  | { type: "enqueue_run"; run_id: string; task: Task; params: RunParams }
  | { type: "cancel_runs"; run_ids: string[] }
  | { type: "insert_output_snapshot"; output_snapshot_id: string; plan_version_id: string; source_set: string[]; issue_states: unknown; decision_status: DecisionStatus }
  | { type: "insert_artifact"; artifact_id: string; output_snapshot_id: string; artifact_type: "plan_doc" | "storyline" | "qa" | "debate_log"; content: unknown; validation: ValidationResult; unresolved_critical_ids: string[] };

export interface ReduceResult {
  state: ProjectState;
  effects: Effect[];
  data?: unknown;
}

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
