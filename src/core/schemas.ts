import { z } from "zod";
import {
  AUDIENCES,
  DECISION_TYPES,
  FACT_AREAS,
  INFO_KINDS,
  LIMITS,
  OUTCOMES,
  PLAN_DOC_KEYS,
  PROJECT_TYPES,
  ROLES,
  SECTION_KEYS,
  SEVERITIES,
  type Task,
} from "./constants";

// ── 사용자 동작(action) 페이로드 ─────────────────────────

const shortText = z.string().trim().max(200);
const longText = z.string().trim().max(LIMITS.textMaxChars);

export const ACTION_SCHEMAS = {
  CREATE_PROJECT: z.object({
    title: shortText.optional().default(""),
    type: z.enum(PROJECT_TYPES),
    idea: longText,
    problem: longText.optional().default(""),
    requested_decision: longText.optional().default(""),
    audience: z.enum(AUDIENCES),
    sources: z
      .array(z.object({ title: shortText.min(1), text: z.string().min(1) }))
      .max(10)
      .optional()
      .default([]),
  }),
  ANSWER_INTAKE: z.object({
    answers: z.array(z.object({ question_id: z.string(), text: longText })).max(10).optional().default([]),
    text: longText.optional().default(""),
  }),
  REQUEST_OUTLINE: z.object({}),
  REVISE_OUTLINE: z.object({ feedback: longText.min(1) }),
  CONFIRM_OUTLINE: z.object({ draft_id: z.string() }),
  RESPOND_ISSUES: z.object({
    responses: z
      .array(
        z.object({
          issue_id: z.string(),
          response_type: z.enum(["accept", "rebut", "hold", "add_info", "recheck_request"]),
          text: longText.optional().default(""),
        }),
      )
      .min(1)
      .max(20),
  }),
  SUBMIT_REPLY: z.object({ text: longText.min(1) }),
  CONFIRM_REPLY_MAPPING: z.object({ mapping_id: z.string(), excluded_issue_ids: z.array(z.string()).optional().default([]) }),
  DISCARD_REPLY_MAPPING: z.object({ mapping_id: z.string() }),
  PROCEED: z.object({}),
  CONFIRM_REVISION: z.object({ revision_id: z.string() }),
  REJECT_REVISION: z.object({ revision_id: z.string(), feedback: longText.optional().default("") }),
  REQUEST_REVIEW: z.object({}),
  EXTRA_REVIEW: z.object({ role: z.enum(ROLES) }),
  PROCEED_WITH_MISSING_REVIEW: z.object({}),
  RETRY_RUN: z.object({ run_id: z.string() }),
  SET_INTENSITY: z.object({ intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
  SET_AUDIENCE: z.object({ audience: z.enum(AUDIENCES) }),
  ADD_SOURCE: z.object({ title: shortText.min(1), text: z.string().min(1) }),
  FINISH: z.object({ via_command: z.boolean().optional().default(false) }),
  GENERATE_OUTPUT: z.object({}),
  START_REWORK: z.object({}),
  RESUME_REPLY: z.object({}),
} as const;

export type ActionName = keyof typeof ACTION_SCHEMAS;
export const ACTION_NAMES = Object.keys(ACTION_SCHEMAS) as ActionName[];
export type ActionPayload<A extends ActionName> = z.output<(typeof ACTION_SCHEMAS)[A]>;
export type Action = { [A in ActionName]: { type: A; payload: ActionPayload<A> } }[ActionName];

export function parseAction(type: string, payload: unknown): Action {
  if (!(type in ACTION_SCHEMAS)) throw new Error(`허용되지 않은 동작입니다: ${type}`);
  const schema = ACTION_SCHEMAS[type as ActionName];
  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) {
    throw new Error(`입력 형식이 올바르지 않습니다: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  return { type, payload: parsed.data } as Action;
}

// ── AI 출력 스키마 (모든 필드 필수, 선택값은 nullable) ────

const str = z.string();
const strArr = z.array(z.string());

export const AI_OUTPUT_SCHEMAS = {
  intake: z.object({
    questions: z.array(z.object({ text: str, why: str })),
    info_items: z.array(z.object({ kind: z.enum(INFO_KINDS), text: str })),
    ready_for_outline: z.boolean(),
    type_suggestion: z.enum(PROJECT_TYPES).nullable(),
    note: str,
  }),
  outline: z.object({
    core_message: str,
    requested_decision: str,
    sections: z.array(
      z.object({
        key: z.enum(SECTION_KEYS),
        claims: z.array(z.object({ text: str, kind: z.enum(INFO_KINDS), source_refs: strArr, fact_keys: strArr })),
      }),
    ),
    facts: z.array(
      z.object({
        key: str,
        label: str,
        value: str,
        unit: str,
        kind: z.enum(INFO_KINDS),
        area: z.enum(FACT_AREAS),
        source_refs: strArr,
        note: str,
      }),
    ),
  }),
  review: z.object({
    findings: z.array(
      z.object({
        severity: z.enum(SEVERITIES),
        target_claim_ids: strArr,
        critique: str,
        reason: str,
        source_refs: strArr,
        uncertainties: str,
        expected_question: str,
        resolution_conditions: strArr,
        reopen_issue_id: str.nullable(),
        reopen_reason: str,
      }),
    ),
    no_findings_reason: str,
  }),
  consolidate: z.object({
    groups: z.array(z.object({ representative_key: str, member_keys: strArr, reason: str })),
    existing_links: z.array(
      z.object({ candidate_key: str, issue_id: str, relation: z.enum(["duplicate", "reopen"]), reason: str }),
    ),
    order: strArr,
  }),
  map_reply: z.object({
    mappings: z.array(
      z.object({
        issue_id: str,
        response_type: z.enum(["accept", "rebut", "hold", "add_info"]),
        interpreted_action: str,
        quote: str,
      }),
    ),
    unanswered_issue_ids: strArr,
    clarifications: z.array(z.object({ issue_ids: strArr, question: str })),
    change_requests: strArr,
  }),
  revise: z.object({
    change_summary: str,
    core_message: str.nullable(),
    requested_decision: str.nullable(),
    changes: z.array(
      z.object({
        op: z.enum(["modify", "add", "remove"]),
        claim_id: str.nullable(),
        section_key: z.enum(SECTION_KEYS).nullable(),
        text: str,
        kind: z.enum(INFO_KINDS),
        fact_refs: strArr,
        source_refs: strArr,
      }),
    ),
    fact_changes: z.array(
      z.object({
        op: z.enum(["modify", "add", "remove"]),
        fact_id: str.nullable(),
        label: str,
        value: str,
        unit: str,
        kind: z.enum(INFO_KINDS),
        area: z.enum(FACT_AREAS),
        note: str,
        source_refs: strArr,
      }),
    ),
    cascade_impacts: z.array(z.object({ area: z.enum(FACT_AREAS), before: str, after: str, note: str })),
    addressed_issue_ids: strArr,
    unaddressed: z.array(z.object({ issue_id: str, reason: str })),
  }),
  judge: z.object({
    judgments: z.array(
      z.object({
        issue_id: str,
        condition_results: z.array(
          z.object({ condition_id: str, result: z.enum(["met", "unmet", "unknown"]), reason: str, refs: strArr }),
        ),
        proposed_state: z.enum(["RESOLVED", "UNRESOLVED", "WITHDRAWN"]),
        reason: str,
        follow_up_question: str.nullable(),
        relies_on_user_confirmation: z.boolean(),
      }),
    ),
  }),
  assess: z.object({
    outcome: z.enum(OUTCOMES),
    rationale: str,
    decision_type: z.enum(DECISION_TYPES),
    decision_text: str,
    conditions: strArr,
    stop_switch_criteria: strArr,
  }),
  plan_doc: z.object({
    sections: z.array(
      z.object({
        key: z.enum(PLAN_DOC_KEYS),
        paragraphs: strArr,
        bullets: strArr,
        issue_refs: strArr,
        fact_refs: strArr,
        source_refs: strArr,
      }),
    ),
    unreflected: z.array(z.object({ issue_id: str, reason: str })),
  }),
  storyline: z.object({
    slides: z.array(
      z.object({ headline: str, key_points: strArr, visual: str, issue_refs: strArr, appendix: z.boolean() }),
    ),
    one_minute_summary: str,
  }),
  qa: z.object({
    items: z.array(
      z.object({ question: str, asker_role: str, answer_30s: str, evidence_refs: strArr, slide_ids: strArr }),
    ),
  }),
} satisfies Record<Task, z.ZodType>;

export type AiOutput<T extends Task> = z.output<(typeof AI_OUTPUT_SCHEMAS)[T]>;

// zod → OpenAI strict JSON Schema (모든 속성 required, additionalProperties false, 미지원 키워드 제거)
type JsonNode = Record<string, unknown>;
const DROP_KEYS = new Set(["$schema", "default", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format", "exclusiveMinimum", "exclusiveMaximum"]);

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== "object") return node;
  const out: JsonNode = {};
  for (const [k, v] of Object.entries(node as JsonNode)) {
    if (DROP_KEYS.has(k)) continue;
    out[k] = strictify(v);
  }
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.required = Object.keys(out.properties as JsonNode);
    out.additionalProperties = false;
  }
  return out;
}

export function strictJsonSchema(task: Task): JsonNode {
  return strictify(z.toJSONSchema(AI_OUTPUT_SCHEMAS[task])) as JsonNode;
}

// AI 응답 텍스트 → JSON. 앞뒤 코드펜스만 허용하고 그 밖의 설명 문구가 있으면 실패로 본다.
export function parseAiJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  return JSON.parse(t);
}
