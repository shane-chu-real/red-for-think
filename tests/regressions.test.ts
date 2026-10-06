// 코드 점검에서 나온 결함의 재발 방지 시험
import { describe, expect, it } from "vitest";
import { mockOutput } from "@/core/mock";
import { targetsChangedSince } from "@/core/plan";
import type { RunPayload } from "@/core/prompts";
import { unresolvedCritical } from "@/core/state";
import type { DecisionStatus, PlanContent } from "@/core/types";
import { viaBypass } from "@/server/http";
import { dispatch, getOutput } from "@/server/service";
import { makeHarness } from "./harness";

const mock = (p: RunPayload) => JSON.parse(mockOutput(p));

describe("단계가 넘어간 뒤의 작업 정리", () => {
  it("실패한 인터뷰 작업을 두고 다음 단계로 가면, 그 작업은 정리되고 나중에 재시도되지 않는다", async () => {
    const h = await makeHarness();
    h.override("intake", () => "FAIL");
    const id = await h.create({ type: "education", idea: "신입 300명 AI 교육", audience: "executive" });
    await h.drain();
    let s = await h.state(id);
    const failedId = s.pending_runs[0].run_id;
    expect(s.pending_runs[0].status).toBe("failed");

    await h.ok(id, "REQUEST_OUTLINE"); // 재시도 대신 진행
    await h.drain();
    s = await h.state(id);
    expect(s.pending_runs.find((r) => r.run_id === failedId)).toBeUndefined();
    await h.ok(id, "CONFIRM_OUTLINE", { draft_id: s.outline_draft!.draft_id });
    await h.drain();
    s = await h.state(id);
    expect(s.phase).toBe("WAITING_REPLY");

    const retry = await h.act(id, "RETRY_RUN", { run_id: failedId });
    expect(retry.ok).toBe(false);
    s = await h.state(id);
    expect(s.phase).toBe("WAITING_REPLY"); // 단계가 되돌아가지 않는다
    expect(s.plan.current?.version_no).toBe(1);
  });

  it("같은 작업을 새로 넣으면 이전 실패 항목이 남지 않는다", async () => {
    const h = await makeHarness();
    const id = await h.create({ type: "education", idea: "신입 300명 AI 교육", audience: "executive" });
    await h.drain();
    h.override("intake", () => "FAIL");
    await h.ok(id, "ANSWER_INTAKE", { text: "답변 1" });
    await h.drain();
    expect((await h.state(id)).pending_runs.map((r) => r.status)).toEqual(["failed"]);
    h.override("intake", mock);
    await h.ok(id, "ANSWER_INTAKE", { text: "답변 2" });
    const s = await h.state(id);
    expect(s.pending_runs.length).toBe(1);
    expect(s.pending_runs[0].status).toBe("queued");
  });

  it("마무리할 때 남겨 둔 변경안은 재작업을 시작하면 다시 확인 단계로 돌아온다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "RESPOND_ISSUES", { responses: [{ issue_id: "I-001", response_type: "accept", text: "" }] });
    await h.ok(id, "PROCEED");
    await h.drain();
    await h.ok(id, "FINISH", { via_command: true });
    await h.drain();
    await h.ok(id, "START_REWORK");
    let s = await h.state(id);
    expect(s.phase).toBe("REVISION_CONFIRM");
    await h.ok(id, "CONFIRM_REVISION", { revision_id: s.revision!.revision_id });
    await h.drain();
    s = await h.state(id);
    expect(s.plan.current?.version_no).toBe(2);
    expect(s.revision).toBeNull();
  });
});

describe("AI 제안만으로 쟁점이 사라지지 않는다", () => {
  it("반박도 대상 변경도 없으면 '철회' 제안을 받지 않는다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "RESPOND_ISSUES", { responses: [{ issue_id: "I-001", response_type: "add_info", text: "참고 정보입니다." }] });
    h.override("judge", (p) => {
      const out = mock(p);
      out.judgments[0].proposed_state = "WITHDRAWN";
      return out;
    });
    await h.ok(id, "PROCEED");
    await h.drain();
    const s = await h.state(id);
    const issue = s.issues.find((i) => i.display_id === "I-001")!;
    expect(issue.state).toBe("OPEN");
    expect(unresolvedCritical(s).map((i) => i.display_id)).toContain("I-001");
    expect(s.judgments.at(-1)!.server_note).toContain("철회할 수 없어");
  });

  it("치명 지적이 보완 대표에 병합되면 대표의 심각도가 치명으로 올라간다", async () => {
    const h = await makeHarness();
    h.override("consolidate", (p) => {
      const keys = (p.context.candidates as { key: string; severity: string }[]).map((c) => c);
      const major = keys.find((c) => c.severity === "major")!;
      const critical = keys.find((c) => c.severity === "critical")!;
      return { groups: [{ representative_key: major.key, member_keys: [critical.key], reason: "같은 문제" }], existing_links: [], order: keys.map((c) => c.key) };
    });
    const id = await h.toReply();
    const s = await h.state(id);
    const merged = s.issues.find((i) => i.state === "MERGED")!;
    const rep = s.issues.find((i) => i.issue_id === merged.representative_id)!;
    expect(rep.severity).toBe("critical");
    expect(unresolvedCritical(s).length).toBe(2); // 병합으로 치명 집계가 줄지 않는다(원래 치명 2건)
  });

  it("해소된 쟁점과 '같은 문제'로 분류된 새 치명 지적은 병합하지 않고 새 쟁점으로 남긴다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    let s = await h.state(id);
    await h.ok(id, "RESPOND_ISSUES", { responses: s.issues.map((i) => ({ issue_id: i.issue_id, response_type: "accept", text: "" })) });
    await h.ok(id, "PROCEED");
    await h.drain();
    s = await h.state(id);
    await h.ok(id, "CONFIRM_REVISION", { revision_id: s.revision!.revision_id });
    await h.drain();
    s = await h.state(id);
    expect(s.issues.every((i) => i.state === "RESOLVED")).toBe(true);

    // 2라운드: 재무가 새 치명 지적을 내고, 정리 단계가 해소된 I-001의 중복이라고 분류한다
    h.override("review:finance", (p) => {
      const plan = p.context.plan as { sections: { claims: { claim_id: string }[] }[] };
      return {
        findings: [{ severity: "critical", target_claim_ids: [plan.sections[0].claims[0].claim_id], critique: "새로 드러난 치명 문제", reason: "이유", source_refs: [], uncertainties: "", expected_question: "질문", resolution_conditions: ["조건"], reopen_issue_id: null, reopen_reason: "" }],
        no_findings_reason: "",
      };
    });
    h.override("consolidate", (p) => {
      const keys = (p.context.candidates as { key: string }[]).map((c) => c.key);
      return { groups: [], existing_links: [{ candidate_key: keys[0], issue_id: "I-001", relation: "duplicate", reason: "같은 문제" }], order: keys };
    });
    await h.ok(id, "REQUEST_REVIEW");
    await h.drain();
    s = await h.state(id);
    const fresh = s.issues.find((i) => i.critique === "새로 드러난 치명 문제")!;
    expect(fresh.state).toBe("OPEN");
    expect(unresolvedCritical(s).map((i) => i.issue_id)).toContain(fresh.issue_id);
    await h.ok(id, "PROCEED");
    await h.ok(id, "FINISH", { via_command: false });
    await h.drain();
    s = await h.state(id);
    expect(s.end?.reason).not.toBe("REVIEW_FINISHED");
    const out = await getOutput(h.db, id, s.outputs[0].output_snapshot_id);
    expect((out!.snapshot.decision_status as DecisionStatus).unresolved_critical_ids).toContain(fresh.display_id);
  });

  it("바뀌는 내용이 없는 변경안과 같은 조건을 두 번 판정한 응답은 형식 오류로 처리한다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "RESPOND_ISSUES", { responses: [{ issue_id: "I-001", response_type: "accept", text: "" }] });
    h.override("revise", (p) => ({ ...mock(p), changes: [], fact_changes: [] }));
    await h.ok(id, "PROCEED");
    await h.drain();
    let s = await h.state(id);
    expect(s.revision).toBeNull();
    expect(s.pending_runs[0]).toMatchObject({ task: "revise", status: "failed", error_code: "AI_SCHEMA_ERROR" });

    h.override("revise", mock);
    await h.ok(id, "RETRY_RUN", { run_id: s.pending_runs[0].run_id });
    await h.drain();
    s = await h.state(id);
    h.override("judge", (p) => {
      const out = mock(p);
      const first = out.judgments[0].condition_results[0];
      out.judgments[0].condition_results = [first, { ...first, result: "unmet" }];
      return out;
    });
    await h.ok(id, "CONFIRM_REVISION", { revision_id: s.revision!.revision_id });
    await h.drain();
    s = await h.state(id);
    expect(s.issues.find((i) => i.display_id === "I-001")!.state).toBe("RECHECK_PENDING"); // 해소로 넘어가지 않았다
    expect(s.pending_runs[0]).toMatchObject({ task: "judge", status: "failed" });
  });
});

describe("변경안·검토 흐름", () => {
  it("변경안을 적용하지 않으면 함께 요청한 변경도 끝나고, 같은 변경안이 반복해서 만들어지지 않는다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "SUBMIT_REPLY", { text: "30명으로 줄여줘" });
    await h.drain();
    let s = await h.state(id);
    await h.ok(id, "CONFIRM_REPLY_MAPPING", { mapping_id: s.pending_mapping!.mapping_id });
    await h.ok(id, "PROCEED");
    await h.drain();
    s = await h.state(id);
    await h.ok(id, "REJECT_REVISION", { revision_id: s.revision!.revision_id });
    s = await h.state(id);
    expect(s.phase).toBe("ROUND_SUMMARY");
    expect(s.change_requests.map((c) => c.status)).toEqual(["dropped"]);
    const before = (await h.runs(id, "revise")).length;
    await h.ok(id, "RESUME_REPLY");
    await h.ok(id, "PROCEED");
    expect((await h.runs(id, "revise")).length).toBe(before); // 변경안을 다시 만들지 않는다
    expect((await h.state(id)).phase).toBe("ROUND_SUMMARY");
  });

  it("추가 검토가 실패해도 기본 라운드 검토 누락으로 기록하지 않는다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    h.override("review:finance", () => "FAIL");
    await h.ok(id, "EXTRA_REVIEW", { role: "finance" });
    await h.drain();
    await h.ok(id, "PROCEED_WITH_MISSING_REVIEW");
    const s = await h.state(id);
    expect(s.rounds[0].missing_roles).toEqual([]);
    expect(s.phase).toBe("WAITING_REPLY");
  });

  it("자유 입력 답변은 화면 첫 묶음 밖의 미해결 쟁점에도 연결된다", async () => {
    const h = await makeHarness();
    h.override("review:it", (p) => {
      const out = mock(p);
      out.findings.push({ ...out.findings[0], critique: "두 번째 IT 지적" });
      return out;
    });
    const id = await h.toReply(); // 쟁점 6건
    let s = await h.state(id);
    expect(s.issues.length).toBe(6);
    await h.ok(id, "RESPOND_ISSUES", { responses: ["I-001", "I-002", "I-003", "I-004", "I-005"].map((issue_id) => ({ issue_id, response_type: "hold", text: "" })) });
    await h.ok(id, "SUBMIT_REPLY", { text: "I-006 수용" });
    await h.drain();
    s = await h.state(id);
    expect(s.pending_mapping?.items).toMatchObject([{ issue_id: "I-006", response_type: "accept" }]);
  });

  it("삭제된 항목을 대상으로 하던 해소 쟁점은 그 뒤의 무관한 변경에서 다시 열리지 않는다", () => {
    const plan: PlanContent = { core_message: "", requested_decision: "", facts: [], sections: [{ section_id: "S1", key: "problem", title: "", claims: [{ claim_id: "C-002", text: "", kind: "goal", source_refs: [], fact_refs: [], updated_in_version: 3 }] }] };
    const removed = { "C-001": 2 };
    expect(targetsChangedSince(plan, removed, ["C-001"], 1)).toBe(true); // v2에서 삭제 → v1 기준으로는 변경
    expect(targetsChangedSince(plan, removed, ["C-001"], 2)).toBe(false); // v2에서 해소한 뒤에는 다시 변경으로 보지 않는다
    expect(targetsChangedSince(plan, removed, ["C-002"], 2)).toBe(true);
    expect(targetsChangedSince(plan, undefined, ["C-999"], 0)).toBe(false);
  });
});

// 실제 ChatGPT 플랜으로 전체 흐름을 돌렸을 때(2026-10-04) 나온 문제의 재발 방지 시험
describe("실제 AI 시험에서 나온 문제", () => {
  const pilotFact = { op: "add", fact_id: null, label: "파일럿 규모", value: "30", unit: "명", kind: "user_statement", area: "people", note: "", source_refs: [] };

  it("본문 항목은 그대로 두고 핵심 메시지·요청 결정·숫자 추가만 한 변경안은 '반영'으로 받지 않는다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "RESPOND_ISSUES", { responses: [{ issue_id: "I-001", response_type: "accept", text: "" }] });
    h.override("revise", (p) => ({ ...mock(p), changes: [], core_message: "30명 파일럿 후 확대", requested_decision: "30명 파일럿 승인", fact_changes: [pilotFact] }));
    await h.ok(id, "PROCEED");
    await h.drain();
    const s = await h.state(id);
    expect(s.revision).toBeNull();
    expect(s.pending_runs[0]).toMatchObject({ task: "revise", status: "failed", error_code: "AI_SCHEMA_ERROR" });
    expect(s.issues.find((i) => i.display_id === "I-001")!.state).toBe("CHANGE_PENDING");
  });

  it("수용한 쟁점이 없어도, 요청 결정만 바꾸고 본문을 그대로 둔 변경안은 받지 않는다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "SUBMIT_REPLY", { text: "30명으로 줄여줘" });
    await h.drain();
    let s = await h.state(id);
    await h.ok(id, "CONFIRM_REPLY_MAPPING", { mapping_id: s.pending_mapping!.mapping_id });
    h.override("revise", (p) => ({ ...mock(p), changes: [], requested_decision: "30명 파일럿 승인" }));
    await h.ok(id, "PROCEED");
    await h.drain();
    s = await h.state(id);
    expect(s.revision).toBeNull();
    expect(s.pending_runs[0]).toMatchObject({ task: "revise", status: "failed", error_code: "AI_SCHEMA_ERROR" });
  });

  it("판정에는 변경안의 자기 설명이 아니라 실제로 바뀐 항목 목록을 넘긴다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "RESPOND_ISSUES", { responses: [{ issue_id: "I-001", response_type: "accept", text: "" }] });
    await h.ok(id, "PROCEED");
    await h.drain();
    const s = await h.state(id);
    const target = s.issues.find((i) => i.display_id === "I-001")!.target_claim_ids[0];
    let seen: Record<string, unknown> = {};
    h.override("judge", (p) => {
      seen = (p.context.issues as Record<string, unknown>[])[0];
      return mock(p);
    });
    await h.ok(id, "CONFIRM_REVISION", { revision_id: s.revision!.revision_id });
    await h.drain();
    expect(seen.revision_applied).toBe(true);
    expect(seen.changed_since_raised).toEqual({ claim_ids: [target], removed_claim_ids: [], fact_ids: [] });
    expect(seen).not.toHaveProperty("applied_changes");
    expect(seen.state_label).toBe("재검증 대기");
  });

  it("인터뷰 2차 정리는 1차 정리를 대체하고, 뼈대 작성에는 마지막 묶음의 미응답 질문만 넘긴다", async () => {
    const h = await makeHarness();
    const id = await h.create({ type: "education", idea: "신입 300명 AI 교육", audience: "executive" });
    await h.drain(); // 1차: 질문 2개 + 정리 1건
    h.override("intake", () => ({
      questions: [{ text: "다듬은 질문", why: "이유" }],
      info_items: [{ kind: "user_statement", text: "정리 A" }, { kind: "unknown", text: "정리 B" }],
      ready_for_outline: false,
      type_suggestion: null,
      note: "",
    }));
    await h.ok(id, "ANSWER_INTAKE", { text: "연 300명, 예산은 모름" });
    await h.drain();
    const s = await h.state(id);
    expect(s.intake.questions.length).toBe(3); // 기록은 남는다
    expect(s.intake.info_items.map((i) => `${i.origin}:${i.text}`)).toEqual(["user:연 300명, 예산은 모름", "ai:정리 A", "ai:정리 B"]);
    let seen: unknown;
    h.override("outline", (p) => {
      seen = p.context.intake_answers;
      return mock(p);
    });
    await h.ok(id, "REQUEST_OUTLINE");
    await h.drain();
    expect(seen).toEqual([{ question: "다듬은 질문", answer: "(미응답 — 미확인으로 다룰 것)" }]);
  });
});

// 실사용 의견(2026-10-06): 쟁점 설명이 장황하다 → 한 줄 의견(headline)을 받아 카드 첫 줄에 쓴다
describe("쟁점 한 줄 의견", () => {
  it("검토 결과의 한 줄 의견이 쟁점까지 이어지고, 한 줄 의견이 없는 이전 형식 응답도 받는다", async () => {
    const h = await makeHarness();
    h.override("review:finance", (p) => {
      const out = mock(p);
      delete out.findings[0].headline; // 배포 전에 만들어진 작업의 응답 형식
      return out;
    });
    const id = await h.toReply();
    const s = await h.state(id);
    const finance = s.issues.find((i) => i.role === "finance")!;
    const risk = s.issues.find((i) => i.role === "risk")!;
    expect(finance.headline).toBe("");
    expect(risk.headline).toBe("[모의] 리스크: 근거가 부족함");
    expect(s.pending_runs).toEqual([]); // 실패한 작업 없음
  });
});

describe("요청 검사", () => {
  it("프로토타입 키 같은 이름의 동작도 허용 목록 밖이면 입력 오류로 거절한다", async () => {
    const h = await makeHarness();
    const id = await h.toReview();
    for (const action of ["toString", "constructor", "__proto__"]) {
      const res = await h.act(id, action, {});
      expect(res.error?.code).toBe("INVALID_INPUT");
    }
    const res = await dispatch(h.db, { project_id: "not-a-uuid", action: "PROCEED", expected_state_version: 1, request_key: crypto.randomUUID(), payload: {} });
    expect(res.error?.code).toBe("NOT_FOUND");
  });

  it("자동화 우회 값으로 들어온 요청은 화면용 경로에서 구분된다", () => {
    expect(viaBypass(new Request("https://app.example/api/projects"))).toBe(false);
    expect(viaBypass(new Request("https://app.example/api/projects", { headers: { "x-vercel-protection-bypass": "s" } }))).toBe(true);
    expect(viaBypass(new Request("https://app.example/api/projects?x-vercel-protection-bypass=s"))).toBe(true);
    expect(viaBypass(new Request("https://app.example/api/projects", { headers: { "x-vercel-set-bypass-cookie": "true" } }))).toBe(true);
  });
});
