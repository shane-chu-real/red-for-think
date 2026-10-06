"use client";
import { useState } from "react";
import { ISSUE_STATE_LABELS } from "@/core/constants";
import { isUnresolved } from "@/core/state";
import type { Issue, ProjectState, ResponseType } from "@/core/types";
import { Button, inputClass } from "../ui";
import { claimText, ROLE_STYLE, RoleAvatar, RoleBadge, SeverityBadge, StateBadge, type Act } from "./shared";

const RESPONSE_LABEL: Record<ResponseType, string> = { accept: "수용", rebut: "반박", hold: "보류", add_info: "정보 추가", recheck_request: "재검토 요청" };
const RESULT_MARK = { met: ["✓", "text-ok", "충족"], unmet: ["✗", "text-danger", "미충족"], unknown: ["?", "text-warn", "판단 불가"] } as const;

// 쟁점 말풍선: 처음에는 누가 말했는지·한 줄 의견·짧은 설명·대응 버튼만 보이고, 근거와 해결 조건은 펼쳐야 보인다.
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
  const { color } = ROLE_STYLE[issue.role];
  const criticalOpen = issue.severity === "critical" && isUnresolved(issue);

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

  const block = "rounded-2xl bg-surface-2 px-3.5 py-3";
  const blockLabel = "mb-1 block text-xs font-extrabold text-muted";

  return (
    <article className="flex items-start gap-3">
      <RoleAvatar role={issue.role} size={40} className="mt-1" />
      <div className={`glass min-w-0 flex-1 rounded-[6px_22px_22px_22px] border bg-surface p-4 sm:p-5 ${criticalOpen ? "border-danger-line" : "border-line"}`}>
        <div className="flex flex-wrap items-center gap-1.5">
          <RoleBadge role={issue.role} />
          <span className="font-mono text-xs text-faint">{issue.display_id}</span>
          <SeverityBadge severity={issue.severity} />
          <StateBadge state={issue.state} />
          {issue.extra && <span className="text-xs text-muted">추가 검토</span>}
          {rep && <span className="text-xs text-muted">→ 대표 {rep.display_id}</span>}
        </div>

        {/* 한 줄 의견. 이전 형식 쟁점은 지적 문장을 두 줄로 줄여 보여 주고 전문은 펼침에 둔다. */}
        <p className={`mt-2.5 text-lg font-extrabold leading-snug tracking-tight text-ink ${headline ? "" : "line-clamp-2"}`}>{headline || issue.critique}</p>
        {headline && <p className="mt-1.5 text-[15px] leading-relaxed text-soft">{issue.critique}</p>}

        {(judgment || lastDecision) && (
          <p className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            {lastDecision && <span>내 대응: {RESPONSE_LABEL[lastDecision.response_type]}</span>}
            {judgment && (
              <span>
                판정: {judgment.applied_state === "OPEN" ? "미해소" : ISSUE_STATE_LABELS[judgment.applied_state]} · 해결 조건 {met}/{issue.resolution_conditions.length} 충족
              </span>
            )}
          </p>
        )}

        {pendingFollowUp && (
          <div className="mt-2.5 rounded-2xl border border-warn-line bg-warn-bg px-3.5 py-2.5 text-sm text-ink">
            <span className="font-extrabold text-warn">추가 질문 </span>
            {issue.follow_up!.question}
          </div>
        )}

        <details className="mt-2 text-sm">
          <summary className="inline-flex min-h-10 cursor-pointer select-none items-center font-bold hover:underline" style={{ color }}>
            근거·해결 조건 보기
          </summary>
          <dl className="mt-1 grid gap-2.5 text-soft sm:grid-cols-2">
            {!headline && (
              <div className={`${block} sm:col-span-2`}>
                <dt className={blockLabel}>지적 전문</dt>
                <dd>{issue.critique}</dd>
              </div>
            )}
            <div className={block}>
              <dt className={blockLabel}>왜 중요한가</dt>
              <dd>{issue.reason}</dd>
            </div>
            {issue.expected_question && (
              <div className={block}>
                <dt className={blockLabel}>보고 때 나올 질문</dt>
                <dd>“{issue.expected_question}”</dd>
              </div>
            )}
            <div className={`${block} sm:col-span-2`}>
              <dt className={blockLabel}>
                해결하려면{judgment ? ` · ${met}/${issue.resolution_conditions.length} 충족` : ""}
              </dt>
              <dd>
                <ul className="space-y-1.5">
                  {issue.resolution_conditions.map((c) => {
                    const r = judgment?.condition_results.find((x) => x.condition_id === c.condition_id);
                    const mark = r ? RESULT_MARK[r.result] : null;
                    return (
                      <li key={c.condition_id} className="flex gap-2">
                        <span className={`w-4 shrink-0 text-center font-extrabold ${mark ? mark[1] : "text-faint"}`} aria-label={mark ? mark[2] : "판정 전"}>
                          {mark ? mark[0] : "·"}
                        </span>
                        <span>
                          {c.text}
                          {r && <span className="block text-xs text-muted">{r.reason}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </dd>
            </div>
            {issue.uncertainties && (
              <div className={block}>
                <dt className={blockLabel}>아직 모르는 것</dt>
                <dd>{issue.uncertainties}</dd>
              </div>
            )}
            <div className={block}>
              <dt className={blockLabel}>대상 항목</dt>
              <dd className="space-y-1">
                {issue.target_claim_ids.map((id) => (
                  <p key={id}>
                    <span className="font-mono text-xs text-faint">{id}</span> {claimText(plan, id)}
                  </p>
                ))}
                {issue.source_refs.length > 0 && <p className="font-mono text-xs text-muted">자료 {issue.source_refs.join(", ")}</p>}
              </dd>
            </div>
            {lastDecision && (
              <div className={block}>
                <dt className={blockLabel}>내 대응</dt>
                <dd>
                  {lastDecision.interpreted_action}
                  {lastDecision.quote && <span className="text-muted"> — &ldquo;{lastDecision.quote}&rdquo;</span>}
                </dd>
              </div>
            )}
            {judgment && (
              <div className={`${block} sm:col-span-2`}>
                <dt className={blockLabel}>판정 이유</dt>
                <dd>
                  {judgment.reason}
                  {judgment.server_note && <span className="text-muted"> (서버: {judgment.server_note})</span>}
                  {judgment.relies_on_user_confirmation && <span className="text-muted"> (사용자 진술에 의존한 판정)</span>}
                </dd>
              </div>
            )}
          </dl>
        </details>

        {!readOnly && issue.state !== "MERGED" && (
          <div className="no-print mt-2 space-y-2">
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
            {issue.state === "EVIDENCE_PENDING" && !writing && <p className="text-xs text-muted">보류는 해소가 아닙니다. 근거를 확인하면 &apos;정보 추가&apos;로 넣어 주세요.</p>}
          </div>
        )}
      </div>
    </article>
  );
}
