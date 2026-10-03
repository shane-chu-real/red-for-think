import {
  FOCUS_ROLES,
  LIMITS,
  SCHEMA_VERSION,
  SEVERITY_RANK,
  UNRESOLVED_STATES,
  type Audience,
  type IssueState,
  type ProjectType,
  type Role,
} from "./constants";
import { DomainError, type Issue, type ProjectState, type ReduceContext } from "./types";

export function newProjectState(
  input: {
    project_id: string;
    title: string;
    type: ProjectType;
    idea: string;
    problem: string;
    requested_decision: string;
    audience: Audience;
  },
  ctx: ReduceContext,
): ProjectState {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: input.project_id,
    title: input.title,
    type: input.type,
    idea: input.idea,
    problem: input.problem,
    requested_decision: input.requested_decision,
    audience: input.audience,
    phase: "INTAKE",
    round: 0,
    settings: { intensity: 2, storyline_audience: input.audience },
    intake: { batches: 0, questions: [], info_items: [] },
    sources: [],
    outline_draft: null,
    plan: { current: null, history: [] },
    issues: [],
    decisions: [],
    judgments: [],
    candidates: [],
    revision: null,
    revisions: [],
    change_requests: [],
    pending_mapping: null,
    rounds: [],
    pending_runs: [],
    end: null,
    generation: null,
    outputs: [],
    timeline: [],
    counters: { issue: 0, claim: 0, fact: 0, source: 0, question: 0, item: 0 },
    created_at: ctx.now,
    updated_at: ctx.now,
  };
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}

export function note(state: ProjectState, ctx: ReduceContext, actor: string, text: string, kind: "message" | "note" | "error" = "message") {
  state.timeline.push({ at: ctx.now, actor, kind, text });
  if (state.timeline.length > LIMITS.timelineMax) state.timeline.splice(0, state.timeline.length - LIMITS.timelineMax);
}

export function pad(n: number, width = 3): string {
  return String(n).padStart(width, "0");
}

export function setIssueState(issue: Issue, to: IssueState, reason: string, actor: string, ctx: ReduceContext) {
  if (issue.state === to && reason === "") return;
  issue.history.push({ at: ctx.now, from: issue.state, to, reason, actor });
  issue.state = to;
}

export function findIssue(state: ProjectState, ref: string): Issue | undefined {
  return state.issues.find((i) => i.issue_id === ref || i.display_id === ref);
}

export function requireIssue(state: ProjectState, ref: string): Issue {
  const issue = findIssue(state, ref);
  if (!issue) throw new DomainError("INVALID_REFERENCE", `존재하지 않는 쟁점입니다: ${ref}`);
  return issue;
}

export function isUnresolved(issue: Issue): boolean {
  return UNRESOLVED_STATES.includes(issue.state);
}

export function unresolvedCritical(state: ProjectState): Issue[] {
  return state.issues.filter((i) => i.severity === "critical" && isUnresolved(i));
}

export function focusRoles(state: ProjectState): Role[] {
  return FOCUS_ROLES[state.type];
}

export function findingLimit(state: ProjectState, role: Role): number {
  return focusRoles(state).includes(role) ? LIMITS.focusRoleFindings : LIMITS.baseRoleFindings;
}

// 사용자에게 먼저 보여 줄 쟁점: 미해결 대표 쟁점을 치명 → 보완 → 사소, 그다음 ID 순으로
export function sortedOpenIssues(state: ProjectState): Issue[] {
  return state.issues
    .filter((i) => isUnresolved(i))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.display_id.localeCompare(b.display_id));
}

export function currentRound(state: ProjectState) {
  return state.rounds.find((r) => r.round === state.round) ?? null;
}

export function allMissingReviews(state: ProjectState): { round: number; roles: Role[] }[] {
  return state.rounds.filter((r) => r.missing_roles.length > 0).map((r) => ({ round: r.round, roles: [...r.missing_roles] }));
}

export function requirePhase(state: ProjectState, allowed: ProjectState["phase"][], action: string) {
  if (!allowed.includes(state.phase)) {
    throw new DomainError("INVALID_TRANSITION", `현재 단계(${state.phase})에서는 ${action}을(를) 할 수 없습니다.`);
  }
}

export function hasQueuedRuns(state: ProjectState): boolean {
  return state.pending_runs.some((r) => r.status === "queued");
}
