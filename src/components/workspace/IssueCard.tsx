"use client";
import { useState } from "react";
import { ISSUE_STATE_LABELS } from "@/core/constants";
import { isUnresolved } from "@/core/state";
import type { Issue, ProjectState, ResponseType } from "@/core/types";
import { Button, inputClass } from "../ui";
import { claimText, RoleBadge, SeverityBadge, StateBadge, type Act } from "./shared";

const RESPONSE_LABEL: Record<ResponseType, string> = { accept: "수용", rebut: "반박", hold: "보류", add_info: "정보 추가", recheck_request: "재검토 요청" };
const RESULT_MARK = { met: ["✓", "text-emerald-700", "충족"], unmet: ["✗", "text-red-700", "미충족"], unknown: ["?", "text-amber-700", "판단 불가"] } as const;

// 쟁점 카드: 처음에는 한 줄 의견·짧은 설명·대응 버튼만 보이고, 근거와 해결 조건은 펼쳐야 보인다.
export function IssueCard({ issue, state, act, busy, readOnly = false }: { issue: Issue; state: ProjectState; act: Act; busy: boolean; readOnly?: boolean }) {
  const [text, setText] = useState("");
  const [writing, setWriting] = useState<"rebut" | "add_info" | "recheck_request" | null>(null);
  const plan = state.plan.current?.content;
  const judgment = state.judgments.find((j) => j.judgment_id === issue.last_judgment_id);
  const rep = issue.representative_id ? state.issues.find((i) => i.issue_id === issue.representative_id) : null;
  const pendingFollowUp = Boolean(issue.follow_up && issue.follow_up.answer === null);
  const lastDecision = [...state.decisions].reverse().find((d) => d.issue_ids.includes(issue.issue_id));
  const headline = issue.headline?.trim();
  const met = judgment ? issue.resolution_conditions.filter((c) => judgment.condition_results.find((r) => r.condition_id === c.condition_id)?.result === "met").length : 0;

  async function respond(type: ResponseType) {
    const ok = await act("RESPOND_ISSUES", { responses: [{ issue_id: issue.issue_id, response_type: type, text: text.trim() }] });
    if (ok) {
      setText("");
      setWriting(null);
    }
  }

  const replyBox = (type: "rebut" | "add_info" | "recheck_request", placeholder: string, submitLabel: string, cancel: boolean) => (
    <div className="space-y-2">
      <textarea className={inputClass} rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={`${issue.display_id} ${submitLabel}`} autoFocus={cancel} />
      <div className="flex gap-2">
        <Button disabled={busy || !text.trim()} onClick={() => respond(type)}>
          {submitLabel}
        </Button>
        {cancel && (
          <Button variant="ghost" onClick={() => setWriting(null)}>
            취소
          </Button>
        )}
      </div>
    </div>
  );

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

      {/* 한 줄 의견. 이전 형식 쟁점은 지적 문장을 두 줄로 줄여 보여 주고 전문은 펼침에 둔다. */}
      <p className={`mt-2 font-semibold text-slate-900 ${headline ? "" : "line-clamp-2"}`}>{headline || issue.critique}</p>
      {headline && <p className="mt-1 text-sm text-slate-700">{issue.critique}</p>}

      {(judgment || lastDecision) && (
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
          {lastDecision && <span>내 대응: {RESPONSE_LABEL[lastDecision.response_type]}</span>}
          {judgment && (
            <span>
              판정: {judgment.applied_state === "OPEN" ? "미해소" : ISSUE_STATE_LABELS[judgment.applied_state]} · 해결 조건 {met}/{issue.resolution_conditions.length} 충족
            </span>
          )}
        </p>
      )}

      {pendingFollowUp && (
        <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-sm">
          <span className="font-semibold">추가 질문 </span>
          {issue.follow_up!.question}
        </div>
      )}

      <details className="mt-2 text-sm">
        <summary className="cursor-pointer select-none text-indigo-700 hover:underline">근거·해결 조건 보기</summary>
        <dl className="mt-2 space-y-2 border-l-2 border-slate-100 pl-3 text-slate-700">
          {!headline && (
            <div>
              <dt className="text-xs font-semibold text-slate-500">지적 전문</dt>
              <dd>{issue.critique}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs font-semibold text-slate-500">왜 중요한가</dt>
            <dd>{issue.reason}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-slate-500">해결하려면</dt>
            <dd>
              <ul className="space-y-1">
                {issue.resolution_conditions.map((c) => {
                  const r = judgment?.condition_results.find((x) => x.condition_id === c.condition_id);
                  const mark = r ? RESULT_MARK[r.result] : null;
                  return (
                    <li key={c.condition_id} className="flex gap-1.5">
                      <span className={`w-4 shrink-0 text-center font-bold ${mark ? mark[1] : "text-slate-400"}`} aria-label={mark ? mark[2] : "판정 전"}>
                        {mark ? mark[0] : "·"}
                      </span>
                      <span>
                        {c.text}
                        {r && <span className="block text-xs text-slate-500">{r.reason}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </dd>
          </div>
          {issue.expected_question && (
            <div>
              <dt className="text-xs font-semibold text-slate-500">보고 때 나올 질문</dt>
              <dd>{issue.expected_question}</dd>
            </div>
          )}
          {issue.uncertainties && (
            <div>
              <dt className="text-xs font-semibold text-slate-500">아직 모르는 것</dt>
              <dd>{issue.uncertainties}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs font-semibold text-slate-500">대상 항목</dt>
            <dd className="space-y-1">
              {issue.target_claim_ids.map((id) => (
                <p key={id}>
                  <span className="font-mono text-xs text-slate-400">{id}</span> {claimText(plan, id)}
                </p>
              ))}
              {issue.source_refs.length > 0 && <p className="font-mono text-xs text-slate-500">자료 {issue.source_refs.join(", ")}</p>}
            </dd>
          </div>
          {lastDecision && (
            <div>
              <dt className="text-xs font-semibold text-slate-500">내 대응</dt>
              <dd>
                {lastDecision.interpreted_action}
                {lastDecision.quote && <span className="text-slate-500"> — &ldquo;{lastDecision.quote}&rdquo;</span>}
              </dd>
            </div>
          )}
          {judgment && (
            <div>
              <dt className="text-xs font-semibold text-slate-500">판정 이유</dt>
              <dd>
                {judgment.reason}
                {judgment.server_note && <span className="text-slate-500"> (서버: {judgment.server_note})</span>}
                {judgment.relies_on_user_confirmation && <span className="text-slate-500"> (사용자 진술에 의존한 판정)</span>}
              </dd>
            </div>
          )}
        </dl>
      </details>

      {!readOnly && issue.state !== "MERGED" && (
        <div className="no-print mt-3 space-y-2">
          {pendingFollowUp ? (
            replyBox("rebut", "추가 질문에 대한 답", "답변 제출", false)
          ) : writing ? (
            replyBox(writing, writing === "rebut" ? "반박하는 이유나 근거" : writing === "add_info" ? "추가할 정보나 근거" : "재검토를 요청하는 이유", RESPONSE_LABEL[writing], true)
          ) : isUnresolved(issue) ? (
            <div className="flex flex-wrap gap-2">
              {issue.state !== "CHANGE_PENDING" && (
                <Button disabled={busy} onClick={() => respond("accept")}>
                  수용
                </Button>
              )}
              <Button variant="secondary" disabled={busy} onClick={() => setWriting("rebut")}>
                반박
              </Button>
              {issue.state !== "EVIDENCE_PENDING" && (
                <Button variant="secondary" disabled={busy} onClick={() => respond("hold")}>
                  보류
                </Button>
              )}
              <Button variant="secondary" disabled={busy} onClick={() => setWriting("add_info")}>
                정보 추가
              </Button>
            </div>
          ) : (
            <Button variant="ghost" disabled={busy} onClick={() => setWriting("recheck_request")}>
              재검토 요청
            </Button>
          )}
          {issue.state === "EVIDENCE_PENDING" && !writing && <p className="text-xs text-slate-500">보류는 해소가 아닙니다. 근거를 확인하면 &apos;정보 추가&apos;로 넣어 주세요.</p>}
        </div>
      )}
    </article>
  );
}
