// 설계서 15장의 기능 검증 12개 사례 (인계서 v2 15장)
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mockOutput } from "@/core/mock";
import type { RunPayload } from "@/core/prompts";
import { unresolvedCritical } from "@/core/state";
import type { DecisionStatus, PlanDocContent } from "@/core/types";
import type { Db } from "@/server/db";
import { claimRun, completeRun } from "@/server/runs";
import { dispatch, getOutput, getProject } from "@/server/service";
import { makeHarness } from "./harness";

const mock = (p: RunPayload) => JSON.parse(mockOutput(p));

describe("기능 검증 사례", () => {
  it("1. 치명 이슈를 보류하면 EVIDENCE_PENDING으로 남고 치명 미해결·최종 조건에 계속 포함된다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    let s = await h.state(id);
    const crits = s.issues.filter((i) => i.severity === "critical");
    expect(crits.length).toBeGreaterThan(0);
    await h.ok(id, "RESPOND_ISSUES", { responses: crits.map((i) => ({ issue_id: i.issue_id, response_type: "hold", text: "담당 부서에 확인 예정" })) });
    s = await h.state(id);
    expect(crits.every((c) => s.issues.find((i) => i.issue_id === c.issue_id)!.state === "EVIDENCE_PENDING")).toBe(true);
    expect(unresolvedCritical(s).length).toBe(crits.length);
    const row = (await h.db.query("select unresolved_critical_count from projects where project_id = $1", [id])).rows[0];
    expect(row.unresolved_critical_count).toBe(crits.length);

    await h.ok(id, "PROCEED");
    await h.drain();
    s = await h.state(id);
    expect(s.phase).toBe("ROUND_SUMMARY"); // 보류는 판정 대상이 아니다
    // AI가 '핵심 쟁점 해소'라고 제안해도 서버가 막는다
    h.override("assess", (p) => ({ ...mock(p), outcome: "RESOLVED_CORE" }));
    await h.ok(id, "FINISH", { via_command: false });
    await h.drain();
    s = await h.state(id);
    expect(s.phase).toBe("OUTPUT_READY");
    expect(s.end?.reason).toBe("PENDING_EXTERNAL_CHECK");
    const out = await getOutput(h.db, id, s.outputs[0].output_snapshot_id);
    const ds = out!.snapshot.decision_status as DecisionStatus;
    expect(ds.outcome).toBe("CONDITIONAL");
    expect(ds.outcome_adjusted_note).toContain("서버 하한 규칙");
    expect(ds.unresolved_critical_ids.sort()).toEqual(crits.map((c) => c.display_id).sort());
    const doc = out!.artifacts.plan_doc as PlanDocContent;
    for (const c of crits) {
      expect(doc.sections.find((x) => x.key === "summary")!.issue_refs).toContain(c.display_id);
      expect(doc.sections.find((x) => x.key === "decision_request")!.issue_refs).toContain(c.display_id);
    }
  });

  it("2. '확인하겠다'는 약속은 확인 완료로 처리되지 않는다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "SUBMIT_REPLY", { text: "I-005 보류: IT팀에 제작 권한을 확인하겠습니다" });
    await h.drain();
    let s = await h.state(id);
    expect(s.pending_mapping?.items[0]).toMatchObject({ issue_id: "I-005", response_type: "hold" });
    // 확인 전에는 반영하지 않는다
    expect(s.issues.find((i) => i.display_id === "I-005")!.state).toBe("OPEN");
    await h.ok(id, "CONFIRM_REPLY_MAPPING", { mapping_id: s.pending_mapping!.mapping_id });
    await h.ok(id, "PROCEED");
    await h.drain();
    s = await h.state(id);
    const issue = s.issues.find((i) => i.display_id === "I-005")!;
    expect(issue.state).toBe("EVIDENCE_PENDING");
    expect(s.judgments.find((j) => j.issue_id === issue.issue_id)).toBeUndefined();
    const d = s.decisions.find((x) => x.issue_ids.includes(issue.issue_id))!;
    expect(d.original_reply).toContain("확인하겠습니다"); // 원문 보존
    expect(d.user_confirmed).toBe(true);
  });

  it("3. 다섯 쟁점 중 두 개만 답하면 두 개만 처리되고 나머지는 미응답으로 남는다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "SUBMIT_REPLY", { text: "I-001 수용\nI-004 반박 실습은 가상 데이터만 사용합니다" });
    await h.drain();
    let s = await h.state(id);
    expect(s.pending_mapping!.unanswered_issue_ids.sort()).toEqual(["I-002", "I-003", "I-005"]);
    await h.ok(id, "CONFIRM_REPLY_MAPPING", { mapping_id: s.pending_mapping!.mapping_id });
    s = await h.state(id);
    const st = Object.fromEntries(s.issues.map((i) => [i.display_id, i.state]));
    expect(st).toEqual({ "I-001": "CHANGE_PENDING", "I-002": "OPEN", "I-003": "OPEN", "I-004": "REBUTTAL_PENDING", "I-005": "OPEN" });
  });

  it("4. 300명→30명 축소: 새 버전에 인원·연쇄 영향이 반영되고 효과 입증 조건은 따로 남는다", async () => {
    const h = await makeHarness();
    h.override("review:finance", (p) => {
      const out = mock(p);
      out.findings[0].critique = "300명 × 2일 투입에 대한 효과 근거가 없습니다.";
      out.findings[0].resolution_conditions = ["대상 규모를 검증 가능한 범위로 조정", "파일럿의 검증 목표·측정 방법·확대/중단 기준 명시"];
      return out;
    });
    const id = await h.toReply();
    let s = await h.state(id);
    const fin = s.issues.find((i) => i.role === "finance")!;
    expect(s.plan.current!.content.facts.find((f) => f.area === "people")!.value).toBe("300");
    await h.ok(id, "SUBMIT_REPLY", { text: `${fin.display_id} 수용\n30명 파일럿 후 확대로 바꿔줘` });
    await h.drain();
    s = await h.state(id);
    expect(s.pending_mapping!.change_requests.length).toBe(1);
    await h.ok(id, "CONFIRM_REPLY_MAPPING", { mapping_id: s.pending_mapping!.mapping_id });
    await h.ok(id, "PROCEED");
    await h.drain();
    s = await h.state(id);
    expect(s.phase).toBe("REVISION_CONFIRM");
    const areas = s.revision!.cascade_impacts.map((c) => c.area).sort();
    expect(areas).toEqual(["budget", "people", "schedule"]); // 인원·예산·일정을 한 묶음으로 보여 준다
    // 축소만으로 효과 근거가 충족되지는 않는다: 두 번째 조건은 미충족으로 판정
    h.override("judge", (p) => {
      const out = mock(p);
      for (const j of out.judgments) {
        if (j.issue_id === fin.display_id) {
          j.condition_results[1].result = "unmet";
          j.proposed_state = "UNRESOLVED";
          j.reason = "인원은 줄였지만 파일럿의 검증 목표·측정 방법이 없습니다.";
        }
      }
      return out;
    });
    await h.ok(id, "CONFIRM_REVISION", { revision_id: s.revision!.revision_id });
    await h.drain();
    s = await h.state(id);
    expect(s.plan.current!.version_no).toBe(2);
    expect(s.plan.current!.content.facts.find((f) => f.area === "people")!.value).toBe("30");
    const after = s.issues.find((i) => i.issue_id === fin.issue_id)!;
    expect(after.applied_revision_ids.length).toBe(1);
    expect(after.state).toBe("OPEN"); // 효과 입증 문제는 미해결로 남는다
    expect(unresolvedCritical(s).map((i) => i.display_id)).toContain(fin.display_id);
    // 이전 버전은 불변으로 보존된다
    const v1 = (await h.db.query("select content from plan_versions where project_id = $1 and version_no = 1", [id])).rows[0];
    expect(v1.content.facts.find((f: { area: string }) => f.area === "people").value).toBe("300");
  });

  it("5. 수용 후 변경 적용 전에 마무리하면 기존 확정 버전으로 산출하고 미적용 변경을 표시한다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "RESPOND_ISSUES", { responses: [{ issue_id: "I-001", response_type: "accept", text: "" }] });
    await h.ok(id, "PROCEED");
    await h.drain();
    let s = await h.state(id);
    expect(s.phase).toBe("REVISION_CONFIRM");
    await h.ok(id, "FINISH", { via_command: true });
    await h.drain();
    s = await h.state(id);
    expect(s.phase).toBe("OUTPUT_READY");
    expect(s.plan.current!.version_no).toBe(1);
    expect(s.outputs[0].plan_version_no).toBe(1);
    expect(s.end?.reason).toBe("USER_FINISHED");
    const out = await getOutput(h.db, id, s.outputs[0].output_snapshot_id);
    const ds = out!.snapshot.decision_status as DecisionStatus;
    expect(ds.unapplied_revision).not.toBeNull();
    expect(ds.change_pending_issue_ids).toContain("I-001");
  });

  it("6. 같은 request_key는 한 번만 상태를 바꾸고 같은 결과를 돌려준다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    const key = randomUUID();
    const before = (await getProject(h.db, id))!.state_version;
    const req = { project_id: id, action: "RESPOND_ISSUES", expected_state_version: before, request_key: key, payload: { responses: [{ issue_id: "I-001", response_type: "accept", text: "" }] } };
    const [a, b] = await Promise.all([dispatch(h.db, req), dispatch(h.db, req)]);
    const c = await dispatch(h.db, req); // 늦은 재전송 (버전이 이미 올라간 뒤)
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect([a.duplicate, b.duplicate].filter(Boolean).length).toBe(1);
    expect(c.duplicate).toBe(true);
    const after = (await getProject(h.db, id))!;
    expect(after.state_version).toBe(before + 1);
    expect(after.state.decisions.length).toBe(1);
    const events = (await h.db.query("select count(*)::int as n from events where request_key = $1", [key])).rows[0];
    expect(events.n).toBe(1);
  });

  it("7. AI 호출 도중 상태가 바뀌면 늦은 응답은 superseded로 보존하고 적용하지 않는다", async () => {
    const h = await makeHarness();
    const id = await h.toReview();
    const claim = await claimRun(h.db, h.runnerId);
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") return;
    await h.ok(id, "FINISH", { via_command: true }); // 호출 중 사용자가 마무리
    const res = await completeRun(h.db, h.runnerId, claim.job.run_id, {
      request_key: claim.job.request_key,
      terminal_event: "response.completed",
      text: mockOutput(claim.job.payload),
      output_mode: "mock",
    });
    expect(res.status).toBe("superseded");
    const run = (await h.db.query("select status, result_text from ai_runs where run_id = $1", [claim.job.run_id])).rows[0];
    expect(run.status).toBe("superseded");
    expect(run.result_text).toBeTruthy();
    const s = await h.state(id);
    expect(s.issues.length).toBe(0); // 늦은 검토 결과가 쟁점으로 들어오지 않았다
    expect(s.candidates.length).toBe(0);
  });

  it("8. 검토자 한 명이 실패하면 성공한 결과는 보존하고 실패한 역할만 재시도한다", async () => {
    const h = await makeHarness();
    h.override("review:it", () => "FAIL");
    const id = await h.toReply();
    let s = await h.state(id);
    expect(s.phase).toBe("REVIEWING");
    expect(s.candidates.length).toBe(4);
    const failed = s.pending_runs.filter((r) => r.status === "failed");
    expect(failed.map((r) => r.role)).toEqual(["it"]);
    // 누락 상태에서는 다음 단계로 못 간다(정리 작업이 생기지 않았다)
    expect((await h.runs(id, "consolidate")).length).toBe(0);

    h.override("review:it", mock);
    const before = (await h.runs(id, "review")).length;
    await h.ok(id, "RETRY_RUN", { run_id: failed[0].run_id });
    expect((await h.runs(id, "review")).length).toBe(before + 1); // 실패한 역할 하나만 다시 넣는다
    await h.drain();
    s = await h.state(id);
    expect(s.phase).toBe("WAITING_REPLY");
    expect(s.issues.length).toBe(5);
    expect(s.rounds[0].missing_roles).toEqual([]);
  });

  it("8-2. 검토 누락을 기록하고 진행하면 미해결 0건이어도 검토 완료로 표시하지 않는다", async () => {
    const h = await makeHarness();
    h.override("review:it", () => "FAIL");
    const id = await h.toReply();
    await h.ok(id, "PROCEED_WITH_MISSING_REVIEW");
    await h.drain();
    let s = await h.state(id);
    expect(s.rounds[0].missing_roles).toEqual(["it"]);
    await h.ok(id, "RESPOND_ISSUES", { responses: s.issues.map((i) => ({ issue_id: i.issue_id, response_type: "accept", text: "" })) });
    await h.ok(id, "PROCEED");
    await h.drain();
    s = await h.state(id);
    await h.ok(id, "CONFIRM_REVISION", { revision_id: s.revision!.revision_id });
    await h.drain();
    s = await h.state(id);
    expect(unresolvedCritical(s).length).toBe(0);
    h.override("assess", (p) => ({ ...mock(p), outcome: "RESOLVED_CORE" }));
    await h.ok(id, "FINISH", { via_command: false });
    await h.drain();
    s = await h.state(id);
    expect(s.end?.reason).not.toBe("REVIEW_FINISHED");
    expect(s.outputs[0].outcome).toBe("CONDITIONAL");
    const out = await getOutput(h.db, id, s.outputs[0].output_snapshot_id);
    expect((out!.snapshot.decision_status as DecisionStatus).missing_reviews).toEqual([{ round: 1, roles: ["it"] }]);
  });

  it("9. 없는 출처를 인용한 AI 응답과 다른 프로젝트 ID 참조는 차단된다", async () => {
    const h = await makeHarness();
    h.override("review:finance", (p) => {
      const out = mock(p);
      out.findings[0].source_refs = ["SRC-999"];
      return out;
    });
    const id = await h.toReply();
    let s = await h.state(id);
    // 교정 1회 후에도 틀리면 실패로 남긴다. 서버가 근거를 보충해 성공 처리하지 않는다.
    const finance = (await h.runs(id, "review")).filter((r) => r.role === "finance");
    expect(finance.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(finance.every((r) => r.error_code === "AI_SCHEMA_ERROR")).toBe(true);
    expect(s.candidates.some((c) => c.role === "finance")).toBe(false);
    expect(s.pending_runs.find((r) => r.role === "finance")?.status).toBe("failed");

    // 다른 프로젝트
    h.override("review:finance", mock);
    const other = await h.toReply();
    await h.ok(id, "PROCEED_WITH_MISSING_REVIEW");
    await h.drain();
    s = await h.state(id);
    const otherState = await h.state(other);
    const foreign = otherState.issues[0].issue_id;
    const res = await h.act(id, "RESPOND_ISSUES", { responses: [{ issue_id: foreign, response_type: "accept", text: "" }] });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_REFERENCE");

    await h.ok(other, "FINISH", { via_command: true });
    await h.drain();
    const snap = (await h.state(other)).outputs[0].output_snapshot_id;
    expect(await getOutput(h.db, other, snap)).not.toBeNull();
    expect(await getOutput(h.db, id, snap)).toBeNull(); // 다른 프로젝트의 산출물을 돌려주지 않는다
  });

  it("10. 저장 도중 실패하면 전부 되돌리고, 같은 요청을 다시 보내도 한 번만 반영된다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    const before = (await getProject(h.db, id))!;
    const snapsBefore = (await h.db.query("select count(*)::int as n from state_snapshots where project_id = $1", [id])).rows[0].n;
    let failNext = true;
    const flaky: Db = {
      kind: h.db.kind,
      query: (sql, params) => h.db.query(sql, params),
      tx: (fn) =>
        h.db.tx((q) =>
          fn({
            query: (sql, params) => {
              if (failNext && sql.startsWith("insert into events")) {
                failNext = false;
                throw new Error("simulated crash before commit");
              }
              return q.query(sql, params);
            },
          }),
        ),
    };
    const key = randomUUID();
    const req = { project_id: id, action: "RESPOND_ISSUES", expected_state_version: before.state_version, request_key: key, payload: { responses: [{ issue_id: "I-001", response_type: "accept", text: "" }] } };
    const first = await dispatch(flaky, req);
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe("STORAGE_ERROR");
    const mid = (await getProject(h.db, id))!;
    expect(mid.state_version).toBe(before.state_version); // 완료로 표시되지 않았다
    expect(mid.state.decisions.length).toBe(0);
    expect((await h.db.query("select count(*)::int as n from state_snapshots where project_id = $1", [id])).rows[0].n).toBe(snapsBefore);

    const retry = await dispatch(flaky, req);
    expect(retry.ok).toBe(true);
    const again = await dispatch(flaky, req);
    expect(again.duplicate).toBe(true);
    const after = (await getProject(h.db, id))!;
    expect(after.state_version).toBe(before.state_version + 1);
    expect(after.state.decisions.length).toBe(1);
  });

  it("11. 충돌하는 출처는 둘 다 AI에 전달되고, 프로그램이 한쪽을 사실로 확정하지 않는다", async () => {
    const h = await makeHarness();
    h.override("outline", (p) => {
      const out = mock(p);
      out.facts = [{ key: "f1", label: "대상 인원", value: "미정", unit: "명", kind: "unknown", area: "people", source_refs: ["SRC-001", "SRC-002"], note: "SRC-001은 300명, SRC-002는 200명 — 충돌, 확인 필요" }];
      out.sections.find((x: { key: string }) => x.key === "resources").claims = [
        { text: "대상 인원은 자료 간 충돌(300명 대 200명)이 있어 확인이 필요합니다.", kind: "unknown", source_refs: ["SRC-001", "SRC-002"], fact_keys: ["f1"] },
      ];
      return out;
    });
    const id = await h.create({
      type: "education",
      idea: "신입사원 AI 교육",
      audience: "executive",
      sources: [
        { title: "인사팀 메모", text: "올해 신입은 300명입니다." },
        { title: "채용 계획", text: "올해 신입 채용은 200명으로 확정." },
      ],
    });
    const claim = await claimRun(h.db, h.runnerId);
    if (claim.status !== "claimed") throw new Error("no job");
    expect(claim.job.payload.instructions).toContain("충돌하면 숨기지 말고");
    expect(claim.job.payload.input[1].content).toContain("300명");
    expect(claim.job.payload.input[1].content).toContain("200명");
    await completeRun(h.db, h.runnerId, claim.job.run_id, { request_key: claim.job.request_key, terminal_event: "response.completed", text: mockOutput(claim.job.payload), output_mode: "mock" });
    await h.ok(id, "REQUEST_OUTLINE");
    await h.drain();
    const s = await h.state(id);
    const fact = s.outline_draft!.content.facts[0];
    expect(fact.value).toBe("미정");
    expect(fact.kind).toBe("unknown");
    expect(fact.source_refs).toEqual(["SRC-001", "SRC-002"]);
  });

  it("12. 빈 프로젝트에서 마무리하면 기획을 만들지 않고 필요한 최소 입력을 안내한다", async () => {
    const h = await makeHarness();
    const id = await h.create({ type: "ai_task", idea: "/강도3", audience: "executive" });
    let s = await h.state(id);
    expect(s.idea).toBe("");
    expect(s.settings.intensity).toBe(3); // 첫 입력이 명령이면 설정만 반영하고 아이디어를 요청한다
    expect((await h.runs(id)).length).toBe(0);
    const res = await h.act(id, "FINISH", { via_command: true });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("MINIMUM_INPUT_REQUIRED");
    expect(res.error?.message).toContain("아이디어");
    expect((await h.runs(id)).length).toBe(0);
    s = await h.state(id);
    expect(s.outputs.length).toBe(0);

    // 아이디어는 있지만 확정 뼈대가 없는 경우도 지어내지 않는다
    await h.ok(id, "ANSWER_INTAKE", { text: "영업 보고서 요약 AI 도입" });
    await h.drain();
    const res2 = await h.act(id, "FINISH", { via_command: true });
    expect(res2.error?.code).toBe("MINIMUM_INPUT_REQUIRED");
    expect(res2.error?.message).toContain("뼈대");
  });
});
