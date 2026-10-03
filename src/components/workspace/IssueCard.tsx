"use client";
import { useState } from "react";
import { isUnresolved } from "@/core/state";
import type { Issue, ProjectState } from "@/core/types";
import { Button, inputClass } from "../ui";
import { claimText, RoleBadge, SeverityBadge, StateBadge, type Act } from "./shared";

// 쟁점 카드: 고정 ID, 역할, 심각도, 대상 주장, 지적과 이유, 근거와 불확실성, 예상 질문, 해소 조건, 현재 상태
export function IssueCard({ issue, state, act, busy, readOnly = false }: { issue: Issue; state: ProjectState; act: Act; busy: boolean; readOnly?: boolean }) {
  const [text, setText] = useState("");
  const plan = state.plan.current?.content;
  const judgment = state.judgments.find((j) => j.judgment_id === issue.last_judgment_id);
  const rep = issue.representative_id ? state.issues.find((i) => i.issue_id === issue.representative_id) : null;
  const pendingFollowUp = issue.follow_up && issue.follow_up.answer === null;
  const lastDecision = [...state.decisions].reverse().find((d) => d.issue_ids.includes(issue.issue_id));

  async function respond(type: string) {
    const ok = await act("RESPOND_ISSUES", { responses: [{ issue_id: issue.issue_id, response_type: type, text: text.trim() }] });
    if (ok) setText("");
  }

  return (
    <article className={`rounded-lg border bg-white p-4 ${issue.severity === "critical" && isUnresolved(issue) ? "border-red-300" : "border-slate-200"}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-sm font-bold text-slate-900">{issue.display_id}</span>
        <RoleBadge role={issue.role} />
        <SeverityBadge severity={issue.severity} />
        <StateBadge state={issue.state} />
        {issue.extra && <span className="text-xs text-slate-500">추가 검토</span>}
        {rep && <span className="text-xs text-slate-500">→ 대표 {rep.display_id}</span>}
      </div>
      <p className="mt-2 font-medium text-slate-900">{issue.critique}</p>
      <dl className="mt-2 space-y-1.5 text-sm text-slate-700">
        <div>
          <dt className="inline font-semibold">이유 </dt>
          <dd className="inline">{issue.reason}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">대상 주장 </dt>
          <dd className="inline">
            {issue.target_claim_ids.map((id) => (
              <span key={id} className="mr-2">
                <span className="font-mono text-xs text-slate-400">{id}</span> {claimText(plan, id)}
              </span>
            ))}
          </dd>
        </div>
        {(issue.source_refs.length > 0 || issue.uncertainties) && (
          <div>
            <dt className="inline font-semibold">근거·불확실성 </dt>
            <dd className="inline">
              {issue.source_refs.length > 0 && <span className="mr-1 font-mono text-xs">[{issue.source_refs.join(", ")}]</span>}
              {issue.uncertainties}
            </dd>
          </div>
        )}
        <div>
          <dt className="inline font-semibold">예상 질문 </dt>
          <dd className="inline">{issue.expected_question}</dd>
        </div>
        <div>
          <dt className="font-semibold">해소 조건</dt>
          <dd>
            <ul className="ml-4 list-disc">
              {issue.resolution_conditions.map((c) => {
                const r = judgment?.condition_results.find((x) => x.condition_id === c.condition_id);
                return (
                  <li key={c.condition_id}>
                    {c.text}
                    {r && (
                      <span className={`ml-1 text-xs ${r.result === "met" ? "text-emerald-700" : "text-red-700"}`}>
                        [{r.result === "met" ? "충족" : r.result === "unmet" ? "미충족" : "판단 불가"}: {r.reason}]
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </dd>
        </div>
        {lastDecision && (
          <div>
            <dt className="inline font-semibold">내 대응 </dt>
            <dd className="inline">
              {lastDecision.interpreted_action}
              {lastDecision.quote && ` — "${lastDecision.quote}"`}
            </dd>
          </div>
        )}
        {judgment && (
          <div className="rounded bg-slate-50 p-2">
            <dt className="inline font-semibold">판정 사유 </dt>
            <dd className="inline">
              {judgment.reason}
              {judgment.server_note && <span className="text-slate-500"> (서버: {judgment.server_note})</span>}
              {judgment.relies_on_user_confirmation && <span className="text-slate-500"> (사용자 진술에 의존한 판정)</span>}
            </dd>
          </div>
        )}
        {pendingFollowUp && (
          <div className="rounded border border-amber-200 bg-amber-50 p-2">
            <dt className="inline font-semibold">추가 질문 </dt>
            <dd className="inline">{issue.follow_up!.question}</dd>
          </div>
        )}
      </dl>

      {!readOnly && issue.state !== "MERGED" && (
        <div className="no-print mt-3 space-y-2">
          <textarea
            className={inputClass}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={pendingFollowUp ? "추가 질문에 대한 답" : isUnresolved(issue) ? "반박 근거, 추가 정보, 수용 시 바꿀 방향 (선택)" : "재검토를 요청하는 이유"}
            aria-label={`${issue.display_id} 응답 내용`}
          />
          <div className="flex flex-wrap gap-2">
            {isUnresolved(issue) ? (
              <>
                {issue.state !== "CHANGE_PENDING" && (
                  <Button disabled={busy} onClick={() => respond("accept")}>
                    수용
                  </Button>
                )}
                <Button variant="secondary" disabled={busy || !text.trim()} onClick={() => respond("rebut")}>
                  {pendingFollowUp ? "답변 제출" : "반박"}
                </Button>
                {issue.state !== "EVIDENCE_PENDING" && (
                  <Button variant="secondary" disabled={busy} onClick={() => respond("hold")}>
                    보류
                  </Button>
                )}
                <Button variant="secondary" disabled={busy || !text.trim()} onClick={() => respond("add_info")}>
                  정보 추가
                </Button>
              </>
            ) : (
              <Button variant="secondary" disabled={busy || !text.trim()} onClick={() => respond("recheck_request")}>
                재검토 요청
              </Button>
            )}
          </div>
          {issue.state === "EVIDENCE_PENDING" && <p className="text-xs text-slate-500">보류는 해소가 아닙니다. 근거를 확인하면 &apos;정보 추가&apos;로 넣어 주세요.</p>}
        </div>
      )}
    </article>
  );
}
