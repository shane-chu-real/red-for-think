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
