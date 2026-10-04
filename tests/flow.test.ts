import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/core/outputs";
import type { DecisionStatus } from "@/core/types";
import { getOutput } from "@/server/service";
import { makeHarness } from "./harness";

describe("전체 흐름(모의 응답)", () => {
  it("새 프로젝트에서 네 산출물까지 이어진다", async () => {
    const h = await makeHarness();
    const id = await h.toReply();
    let s = await h.state(id);
    expect(s.phase).toBe("WAITING_REPLY");
    expect(s.plan.current?.version_no).toBe(1);
    const open = s.issues.filter((i) => i.state === "OPEN");
    expect(open.length).toBe(5);
    expect(open.map((i) => i.display_id)).toEqual(["I-001", "I-002", "I-003", "I-004", "I-005"]);
    // 치명 이슈가 앞 번호를 받는다
    expect(s.issues[0].severity).toBe("critical");

    await h.ok(id, "RESPOND_ISSUES", { responses: open.map((i) => ({ issue_id: i.issue_id, response_type: "accept", text: "" })) });
    await h.ok(id, "PROCEED");
    await h.drain(); // revise
    s = await h.state(id);
    expect(s.phase).toBe("REVISION_CONFIRM");
    await h.ok(id, "CONFIRM_REVISION", { revision_id: s.revision!.revision_id });
    await h.drain(); // judge
    s = await h.state(id);
    expect(s.phase).toBe("ROUND_SUMMARY");
    expect(s.plan.current?.version_no).toBe(2);
    expect(s.issues.every((i) => i.state === "RESOLVED")).toBe(true);

    await h.ok(id, "FINISH", { via_command: false });
    await h.drain(); // assess → plan_doc → storyline → qa
    s = await h.state(id);
    expect(s.phase).toBe("OUTPUT_READY");
    expect(s.end?.reason).toBe("REVIEW_FINISHED");
    const rec = s.outputs[0];
    expect(rec.validation.errors).toEqual([]);
    expect(rec.outcome).toBe("RESOLVED_CORE");

    const out = await getOutput(h.db, id, rec.output_snapshot_id);
    expect(Object.keys(out!.artifacts).sort()).toEqual(["debate_log", "plan_doc", "qa", "storyline"]);
    // 네 산출물이 같은 스냅샷을 가리킨다
    const arts = (await h.db.query("select output_snapshot_id from artifacts where project_id = $1", [id])).rows;
    expect(new Set(arts.map((a) => a.output_snapshot_id)).size).toBe(1);
    expect(arts.length).toBe(4);

    // 산출물에 나오는 F 번호를 풀어 볼 수 있게, 스냅샷 시점의 사실 목록이 함께 오고 Markdown 끝에 실린다
    expect(out!.refs.facts.map((f) => f.fact_id)).toEqual(s.plan.current!.content.facts.map((f) => f.fact_id));
    const a = out!.artifacts as Record<string, never>;
    const md = renderMarkdown({ title: out!.title, record: out!.record!, decisionStatus: out!.snapshot.decision_status as DecisionStatus, planDoc: a.plan_doc, storyline: a.storyline, qa: a.qa, debate: a.debate_log, refs: out!.refs });
    expect(md).toContain("## 참조 목록");
    expect(md).toContain("| F-001 | 대상 인원 | 300명 | 사용자 진술 |");
    expect(md).toContain("| F-002 | 예산 | 미정 | 미확인 |");
  });
});
