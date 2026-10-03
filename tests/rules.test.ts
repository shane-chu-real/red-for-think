// 판정·재개·라운드·대기열·저장 규칙
import { describe, expect, it } from "vitest";
import { parseCommand } from "@/core/commands";
import { mockOutput } from "@/core/mock";
import type { RunPayload } from "@/core/prompts";
import { strictJsonSchema } from "@/core/schemas";
import { TASKS } from "@/core/constants";
import { claimRun, completeRun, expireLeases, failRun } from "@/server/runs";
import { authenticateRunner, createPairing, pairRunner, revokeRunner } from "@/server/runnerAuth";
import { getSetting } from "@/server/settings";
import { makeHarness } from "./harness";

const mock = (p: RunPayload) => JSON.parse(mockOutput(p));

describe("해소 판정 규칙", () => {
  it("판단 불가 조건이 남으면 AI가 해소라고 해도 해소로 처리하지 않는다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "RESPOND_ISSUES", { responses: [{ issue_id: "I-001", response_type: "accept", text: "" }] });
    await h.ok(id, "PROCEED");
    await h.drain();
    let s = await h.state(id);
    h.override("judge", (p) => {
      const out = mock(p);
      out.judgments[0].condition_results[1].result = "unknown";
      out.judgments[0].proposed_state = "RESOLVED";
      return out;
    });
    await h.ok(id, "CONFIRM_REVISION", { revision_id: s.revision!.revision_id });
    await h.drain();
    s = await h.state(id);
    const issue = s.issues.find((i) => i.display_id === "I-001")!;
    expect(issue.state).toBe("OPEN");
    const j = s.judgments.find((x) => x.judgment_id === issue.last_judgment_id)!;
    expect(j.proposed_state).toBe("RESOLVED");
    expect(j.applied_state).toBe("OPEN");
    expect(j.server_note).toContain("해소로 처리하지 않았습니다");
    expect(j.plan_version_id).toBe(s.plan.current!.plan_version_id);
  });

  it("반박은 추가 질문을 한 번만 받고, 답한 뒤 다시 판정한다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "RESPOND_ISSUES", { responses: [{ issue_id: "I-003", response_type: "rebut", text: "실습은 가상 데이터만 사용합니다." }] });
    await h.ok(id, "PROCEED");
    await h.drain();
    let s = await h.state(id);
    let issue = s.issues.find((i) => i.display_id === "I-003")!;
    expect(s.phase).toBe("WAITING_REPLY"); // 추가 질문에 답할 때까지 기다린다
    expect(issue.state).toBe("REBUTTAL_PENDING");
    expect(issue.follow_up?.answer).toBeNull();
    expect(issue.follow_ups_used).toBe(1);

    await h.ok(id, "RESPOND_ISSUES", { responses: [{ issue_id: "I-003", response_type: "rebut", text: "사내 AI 가이드라인 요약을 교육 자료에 넣습니다." }] });
    await h.ok(id, "PROCEED");
    await h.drain();
    s = await h.state(id);
    issue = s.issues.find((i) => i.display_id === "I-003")!;
    expect(issue.state).toBe("WITHDRAWN");
    expect(s.phase).toBe("ROUND_SUMMARY");
  });

  it("해소된 쟁점은 대상 항목이 바뀐 경우에만 재개된다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    let s = await h.state(id);
    const all = s.issues.map((i) => ({ issue_id: i.issue_id, response_type: "accept", text: "" }));
    await h.ok(id, "RESPOND_ISSUES", { responses: all });
    await h.ok(id, "PROCEED");
    await h.drain();
    s = await h.state(id);
    await h.ok(id, "CONFIRM_REVISION", { revision_id: s.revision!.revision_id });
    await h.drain();
    s = await h.state(id);
    expect(s.issues.every((i) => i.state === "RESOLVED")).toBe(true);
    const finance = s.issues.find((i) => i.role === "finance")!; // 대상: 자원 항목(인원 사실 참조)
    const executive = s.issues.find((i) => i.role === "executive")!; // 대상: 요청 결정 항목

    // 인원만 바꾸는 변경 → 인원을 참조하는 항목의 쟁점만 재개
    await h.ok(id, "SUBMIT_REPLY", { text: "30명으로 줄여줘" });
    await h.drain();
    s = await h.state(id);
    await h.ok(id, "CONFIRM_REPLY_MAPPING", { mapping_id: s.pending_mapping!.mapping_id });
    await h.ok(id, "PROCEED");
    await h.drain();
    s = await h.state(id);
    h.override("judge", (p) => {
      const out = mock(p);
      for (const j of out.judgments) {
        j.proposed_state = "UNRESOLVED";
        for (const c of j.condition_results) c.result = "unmet";
      }
      return out;
    });
    await h.ok(id, "CONFIRM_REVISION", { revision_id: s.revision!.revision_id });
    await h.drain();
    s = await h.state(id);
    const fin = s.issues.find((i) => i.issue_id === finance.issue_id)!;
    const exe = s.issues.find((i) => i.issue_id === executive.issue_id)!;
    expect(fin.history.some((x) => x.reason.includes("전제 변경으로 재개"))).toBe(true);
    expect(fin.state).toBe("OPEN");
    expect(exe.state).toBe("RESOLVED"); // 관련 없는 쟁점은 그대로
  });

  it("라운드는 최대 3회이고, 역할 추가 검토는 라운드 수와 별도로 기록된다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "PROCEED");
    let s = await h.state(id);
    expect(s.phase).toBe("ROUND_SUMMARY");
    await h.ok(id, "EXTRA_REVIEW", { role: "risk" });
    await h.drain();
    s = await h.state(id);
    expect(s.round).toBe(1);
    expect(s.rounds[0].extra_reviews.length).toBe(1);
    expect(s.issues.filter((i) => i.extra).length).toBe(1);

    await h.ok(id, "PROCEED");
    await h.ok(id, "REQUEST_REVIEW");
    await h.drain();
    s = await h.state(id);
    expect(s.round).toBe(2);
    if (s.phase === "WAITING_REPLY") await h.ok(id, "PROCEED");
    await h.ok(id, "REQUEST_REVIEW"); // 미해결 치명이 남아 있어 3라운드 허용
    await h.drain();
    s = await h.state(id);
    expect(s.round).toBe(3);
    if (s.phase === "WAITING_REPLY") await h.ok(id, "PROCEED");
    const res = await h.act(id, "REQUEST_REVIEW");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_TRANSITION");
    await h.ok(id, "FINISH", { via_command: false });
    s = await h.state(id);
    expect(s.end?.reason).toBe("ROUND_LIMIT");
  });

  it("변경안 작업이 실패하면 다시 시도하거나 응답 단계로 돌아갈 수 있다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    await h.ok(id, "RESPOND_ISSUES", { responses: [{ issue_id: "I-001", response_type: "accept", text: "" }] });
    h.override("revise", () => "FAIL");
    await h.ok(id, "PROCEED");
    await h.drain();
    let s = await h.state(id);
    expect(s.phase).toBe("REVISION_CONFIRM");
    expect(s.pending_runs.map((r) => r.status)).toEqual(["failed"]);
    await h.ok(id, "RESUME_REPLY");
    s = await h.state(id);
    expect(s.phase).toBe("WAITING_REPLY");
    expect(s.pending_runs).toEqual([]);
    expect(s.issues.find((i) => i.display_id === "I-001")!.state).toBe("CHANGE_PENDING"); // 수용은 그대로 '변경 대기'
  });

  it("뼈대 확인 전에는 검토를 시작하지 않는다", async () => {
    const h = await makeHarness();
    const id = await h.create({ type: "ai_task", idea: "영업 보고서 요약 AI", audience: "executive" });
    await h.drain();
    await h.ok(id, "REQUEST_OUTLINE");
    await h.drain();
    const s = await h.state(id);
    expect(s.phase).toBe("OUTLINE_CONFIRM");
    expect(s.plan.current).toBeNull();
    expect((await h.runs(id, "review")).length).toBe(0);
    const res = await h.act(id, "REQUEST_REVIEW");
    expect(res.error?.code).toBe("INVALID_TRANSITION");
  });
});

describe("대기열·실행기", () => {
  it("임대가 만료되면 실패로 처리하고 자동으로 다시 넣지 않는다", async () => {
    const h = await makeHarness();
    const id = await h.create({ type: "ai_task", idea: "영업 보고서 요약 AI", audience: "executive" });
    const claim = await claimRun(h.db, h.runnerId);
    if (claim.status !== "claimed") throw new Error("no job");
    await h.db.query("update ai_runs set lease_expires_at = now() - interval '1 minute' where run_id = $1", [claim.job.run_id]);
    expect(await expireLeases(h.db)).toBe(1);
    const run = (await h.db.query("select status, error_code from ai_runs where run_id = $1", [claim.job.run_id])).rows[0];
    expect(run).toMatchObject({ status: "failed", error_code: "LEASE_EXPIRED" });
    expect((await claimRun(h.db, h.runnerId)).status).toBe("idle");
    const s = await h.state(id);
    expect(s.pending_runs[0].status).toBe("failed");
    // 만료 뒤 늦게 도착한 결과는 반영하지 않는다
    const late = await completeRun(h.db, h.runnerId, claim.job.run_id, { request_key: claim.job.request_key, terminal_event: "response.completed", text: mockOutput(claim.job.payload), output_mode: "mock" });
    expect(late.status).toBe("duplicate");
  });

  it("완료 이벤트가 없거나 다른 실행기가 보낸 결과는 받지 않는다", async () => {
    const h = await makeHarness();
    await h.create({ type: "ai_task", idea: "영업 보고서 요약 AI", audience: "executive" });
    const claim = await claimRun(h.db, h.runnerId);
    if (claim.status !== "claimed") throw new Error("no job");
    const body = { request_key: claim.job.request_key, text: mockOutput(claim.job.payload), output_mode: "json_schema" };
    expect((await completeRun(h.db, h.runnerId, claim.job.run_id, { ...body, terminal_event: "response.incomplete" })).status).toBe("rejected");
    expect((await completeRun(h.db, "00000000-0000-4000-8000-000000000000", claim.job.run_id, { ...body, terminal_event: "response.completed" })).status).toBe("rejected");
    expect((await completeRun(h.db, h.runnerId, claim.job.run_id, { ...body, terminal_event: "response.completed" })).status).toBe("succeeded");
  });

  it("사용 한도 오류가 오면 새 요청을 멈춘다(유료 경로로 넘어가지 않는다)", async () => {
    const h = await makeHarness();
    await h.toReview();
    const claim = await claimRun(h.db, h.runnerId);
    if (claim.status !== "claimed") throw new Error("no job");
    await failRun(h.db, h.runnerId, claim.job.run_id, { request_key: claim.job.request_key, error_code: "USAGE_LIMIT", message: "subscription_sharing_usage_limit_exceeded", http_status: 429 });
    expect((await getSetting<{ paused: boolean }>(h.db, "ai_paused"))?.paused).toBe(true);
    expect((await claimRun(h.db, h.runnerId)).status).toBe("paused");
  });

  it("프로젝트 호출 상한에 닿으면 그 작업을 실패로 표시하고, 다른 프로젝트의 대기열은 막지 않는다", async () => {
    const h = await makeHarness();
    process.env.AI_CAP_PER_PROJECT = "1";
    try {
      const a = await h.create({ type: "ai_task", idea: "프로젝트 A", audience: "executive" });
      await h.drain(); // A의 인터뷰 질문 1회 → 상한 도달
      await h.ok(a, "ANSWER_INTAKE", { text: "답변" }); // A에 새 작업이 대기열에 들어감
      const b = await h.create({ type: "ai_task", idea: "프로젝트 B", audience: "executive" }); // 더 늦게 들어온 B

      const claim = await claimRun(h.db, h.runnerId);
      // A의 작업 때문에 B가 막히지 않는다
      expect(claim.status).toBe("claimed");
      if (claim.status === "claimed") expect(claim.job.project_id).toBe(b);
      // A의 대기 작업은 이유와 함께 실패로 표시되어 화면에서 정리할 수 있다
      const sa = await h.state(a);
      expect(sa.pending_runs.map((r) => [r.status, r.error_code])).toEqual([["failed", "CAP_REACHED"]]);
      expect((await h.runs(a)).at(-1)).toMatchObject({ status: "failed", error_code: "CAP_REACHED" });
      // 사용자는 멈추지 않고 다음 동작을 할 수 있다(AI_BUSY가 아니다)
      const next = await h.act(a, "REQUEST_OUTLINE");
      expect(next.ok).toBe(true);
    } finally {
      delete process.env.AI_CAP_PER_PROJECT;
    }
  });

  it("하루 호출 상한에 닿으면 작업을 넘기지 않고 대기 상태로 둔다", async () => {
    const h = await makeHarness();
    process.env.AI_CAP_PER_DAY = "1";
    try {
      const a = await h.create({ type: "ai_task", idea: "프로젝트 A", audience: "executive" });
      await h.drain();
      await h.ok(a, "ANSWER_INTAKE", { text: "답변" });
      expect((await claimRun(h.db, h.runnerId)).status).toBe("cap_reached");
      expect((await h.state(a)).pending_runs.map((r) => r.status)).toEqual(["queued"]); // 내일 이어서 진행
    } finally {
      delete process.env.AI_CAP_PER_DAY;
    }
  });

  it("연결 코드는 1회용이고, 해제한 실행기는 인증되지 않는다", async () => {
    const h = await makeHarness();
    const p = await createPairing(h.db, "https://example.test");
    const info = JSON.parse(Buffer.from(p.connection_string.slice(5), "base64url").toString("utf8"));
    const first = await pairRunner(h.db, { code: info.code, label: "pc" });
    expect(first?.token).toBeTruthy();
    expect(await pairRunner(h.db, { code: info.code, label: "pc2" })).toBeNull(); // 재사용 거절
    expect(await pairRunner(h.db, { code: "WRONGCODE123", label: "x" })).toBeNull();
    expect(await authenticateRunner(h.db, `Bearer ${first!.token}`)).not.toBeNull();
    expect(await authenticateRunner(h.db, "Bearer not-a-token")).toBeNull();
    expect(await authenticateRunner(h.db, null)).toBeNull();
    await revokeRunner(h.db, first!.runner_id);
    expect(await authenticateRunner(h.db, `Bearer ${first!.token}`)).toBeNull();
    // 토큰 원문은 DB에 없다
    const rows = (await h.db.query("select token_hash from runners")).rows;
    expect(rows.some((r) => r.token_hash === first!.token)).toBe(false);
  });
});

describe("저장 규칙", () => {
  it("기획 버전·스냅샷·이벤트는 수정하거나 지울 수 없다", async () => {
    const h = await makeHarness();
    const id = await h.toReview();
    await expect(h.db.query("update plan_versions set change_summary = 'x' where project_id = $1", [id])).rejects.toThrow(/immutable/);
    await expect(h.db.query("delete from state_snapshots where project_id = $1", [id])).rejects.toThrow(/immutable/);
    await expect(h.db.query("update events set action = 'x' where project_id = $1", [id])).rejects.toThrow(/immutable/);
  });

  it("화면이 본 버전이 낡았으면 VERSION_CONFLICT를 돌려준다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    const { dispatch } = await import("@/server/service");
    const res = await dispatch(h.db, { project_id: id, action: "PROCEED", expected_state_version: 1, request_key: crypto.randomUUID(), payload: {} });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("VERSION_CONFLICT");
  });

  it("허용 목록에 없는 동작은 거절한다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    const res = await h.act(id, "DELETE_EVERYTHING", {});
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_INPUT");
  });

  it("자료 길이 상한을 넘으면 자르지 않고 거절한다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    const res = await h.act(id, "ADD_SOURCE", { title: "긴 자료", text: "가".repeat(20001) });
    expect(res.error?.code).toBe("SOURCE_TOO_LONG");
    const s = await h.state(id);
    expect(s.sources.length).toBe(0);
  });
});

describe("명령과 스키마", () => {
  it("명령은 버튼과 같은 동작으로 해석된다", () => {
    expect(parseCommand("/강도3")).toEqual({ type: "SET_INTENSITY", payload: { intensity: 3 } });
    expect(parseCommand("/강도 1")).toEqual({ type: "SET_INTENSITY", payload: { intensity: 1 } });
    expect(parseCommand("/재무")).toEqual({ type: "EXTRA_REVIEW", payload: { role: "finance" } });
    expect(parseCommand("/IT")).toEqual({ type: "EXTRA_REVIEW", payload: { role: "it" } });
    expect(parseCommand("/스킵")).toEqual({ type: "PROCEED", payload: {} });
    expect(parseCommand("/마무리")).toEqual({ type: "FINISH", payload: { via_command: true } });
    expect(parseCommand("/유관부서용")).toEqual({ type: "SET_AUDIENCE", payload: { audience: "department" } });
    expect(parseCommand("그냥 문장")).toBeNull();
    expect(parseCommand("/없는명령")).toBeNull();
  });

  it("AI 출력 스키마는 모든 필드가 필수이고 추가 속성을 금지한다", () => {
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      if (n.type === "object" && n.properties) {
        expect(n.additionalProperties).toBe(false);
        expect((n.required as string[]).sort()).toEqual(Object.keys(n.properties as object).sort());
      }
      for (const v of Object.values(n)) Array.isArray(v) ? v.forEach(walk) : walk(v);
    };
    for (const t of TASKS) walk(strictJsonSchema(t));
  });
});
