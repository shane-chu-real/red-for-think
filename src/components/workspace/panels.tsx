"use client";
import Link from "next/link";
import { useState } from "react";
import {
  AUDIENCE_LABELS,
  END_REASON_LABELS,
  FACT_AREA_LABELS,
  ISSUE_STATES,
  ISSUE_STATE_LABELS,
  LIMITS,
  OUTCOME_LABELS,
  ROLES,
  ROLE_LABELS,
  SECTION_TITLES,
  TASK_LABELS,
  type Role,
  type Task,
} from "@/core/constants";
import { isUnresolved, sortedOpenIssues, unresolvedCritical } from "@/core/state";
import type { ProjectState } from "@/core/types";
import { kst } from "@/lib/client";
import { Badge, Button, Card, inputClass } from "../ui";
import { IssueCard } from "./IssueCard";
import { claimText, PlanView, type PanelProps } from "./shared";

// AI 작업 상태: 완료·대기·실패를 구분해 보여 주고 실패한 작업만 다시 시도한다.
export function AiWork({ view, act, busy }: PanelProps) {
  const { state, runs, status } = view;
  if (!state.pending_runs.length) return null;
  const waiting = state.pending_runs.some((r) => r.status === "queued");
  return (
    <Card title="AI 작업 상태">
      <ul className="space-y-1.5 text-sm">
        {state.pending_runs.map((p) => {
          const run = runs.find((r) => r.run_id === p.run_id);
          const running = run?.status === "claimed";
          return (
            <li key={p.run_id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-28 font-medium">
                {TASK_LABELS[p.task as Task]}
                {p.role && ` · ${ROLE_LABELS[p.role as Role]}`}
              </span>
              {p.status === "failed" ? <Badge tone="red">실패</Badge> : running ? <Badge tone="indigo">실행 중</Badge> : <Badge>대기</Badge>}
              {p.status === "failed" && (
                <>
                  <span className="min-w-0 flex-1 text-xs text-danger">{p.error_message}</span>
                  <Button variant="secondary" disabled={busy} onClick={() => act("RETRY_RUN", { run_id: p.run_id })}>
                    다시 시도
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {waiting && status.badge !== "online" && status.badge !== "mock" && (
        <p className="mt-3 rounded-2xl border border-warn-line bg-warn-bg px-4 py-2.5 text-sm text-warn">
          작업이 대기 중입니다. {status.badge === "none" ? "설정에서 실행기를 연결해 주세요." : status.badge === "paused" ? "AI 요청이 일시정지 상태입니다." : "PC에서 실행기를 켜면 이어서 진행됩니다."} 저장은 이미 끝났으므로 창을 닫아도 됩니다.
        </p>
      )}
    </Card>
  );
}

export function IntakePanel({ view, act, busy }: PanelProps) {
  const { state } = view;
  // 마지막 묶음의 질문만 보여 준다(진행자가 묶음마다 남은 질문을 다시 정리해 준다).
  const open = state.intake.questions.filter((q) => q.answer === null && q.batch === state.intake.batches);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [idea, setIdea] = useState("");
  const waiting = state.pending_runs.some((r) => r.status === "queued");

  if (!state.idea) {
    return (
      <Card title="아이디어 입력">
        <p className="mb-2 text-sm text-muted">아이디어가 없으면 기획 내용을 만들지 않습니다. 한 줄에서 한 문단으로 적어 주세요.</p>
        <textarea className={inputClass} rows={3} value={idea} onChange={(e) => setIdea(e.target.value)} aria-label="기획 아이디어" />
        <Button className="mt-2" disabled={busy || !idea.trim()} onClick={() => act("ANSWER_INTAKE", { text: idea.trim() })}>
          인터뷰 시작
        </Button>
      </Card>
    );
  }
  return (
    <Card title={`인터뷰 질문 (${open.length}개 남음)`}>
      {waiting && <p className="text-sm text-muted">진행자가 질문을 준비하고 있습니다.</p>}
      {!waiting && open.length === 0 && <p className="text-sm text-muted">남은 질문이 없습니다.</p>}
      <div className="space-y-3">
        {open.map((q) => (
          <div key={q.question_id}>
            <p className="text-sm font-medium text-ink">
              <span className="font-mono text-xs text-faint">{q.question_id}</span> {q.text}
            </p>
            <p className="text-xs text-muted">{q.why}</p>
            <textarea className={`${inputClass} mt-1`} rows={2} value={answers[q.question_id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.question_id]: e.target.value })} placeholder='모르면 "모름"' aria-label={`${q.question_id} 답변`} />
          </div>
        ))}
      </div>
      {!waiting && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={busy || !Object.values(answers).some((v) => v.trim())}
            onClick={async () => {
              const ok = await act("ANSWER_INTAKE", { answers: Object.entries(answers).filter(([, v]) => v.trim()).map(([question_id, text]) => ({ question_id, text: text.trim() })) });
              if (ok) setAnswers({});
            }}
          >
            답한 것만 제출
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => act("REQUEST_OUTLINE")}>
            남은 질문은 미확인으로 두고 뼈대 만들기
          </Button>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">일부만 답해도 됩니다. 답하지 않은 질문은 미확인으로 남습니다.</p>
    </Card>
  );
}

export function OutlinePanel({ view, act, busy }: PanelProps) {
  const { state } = view;
  const draft = state.outline_draft;
  const [feedback, setFeedback] = useState("");
  const waiting = state.pending_runs.some((r) => r.status === "queued");
  return (
    <Card title="기획 뼈대 확인">
      {waiting && <p className="mb-3 text-sm text-muted">작성자가 뼈대를 쓰고 있습니다.</p>}
      {draft && (
        <>
          <PlanView plan={draft.content} />
          {!waiting && (
            <div className="mt-4 space-y-2 border-t border-line-soft pt-3">
              <p className="text-sm text-muted">확인하기 전에는 검토를 시작하지 않습니다. 확인하면 이 뼈대가 확정 기획 v1이 되고 다섯 역할의 검토가 시작됩니다.</p>
              <Button disabled={busy} onClick={() => act("CONFIRM_OUTLINE", { draft_id: draft.draft_id })}>
                이 뼈대로 확정하고 검토 시작
              </Button>
              <textarea className={inputClass} rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="방향이 다르면 수정할 내용을 적어 주세요" aria-label="뼈대 수정 요청" />
              <Button
                variant="secondary"
                disabled={busy || !feedback.trim()}
                onClick={async () => {
                  if (await act("REVISE_OUTLINE", { feedback: feedback.trim() })) setFeedback("");
                }}
              >
                수정 요청
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function ReviewPanel({ view, act, busy }: PanelProps) {
  const { state, runs } = view;
  const rec = state.rounds.find((r) => r.round === state.round);
  const failed = state.pending_runs.filter((r) => r.task === "review" && r.status === "failed");
  const waiting = state.pending_runs.some((r) => r.status === "queued");
  const rows = [...(rec?.review_runs ?? []).map((r) => ({ ...r, extra: false })), ...(rec?.extra_reviews ?? []).filter((r) => r.status !== "succeeded" || state.pending_runs.length > 0).map((r) => ({ ...r, extra: true }))];
  return (
    <Card title={`${state.round}라운드 역할별 검토 (확정 기획 v${state.plan.current?.version_no})`}>
      <ul className="grid gap-2 sm:grid-cols-2">
        {rows.map((r) => {
          const run = runs.find((x) => x.run_id === r.run_id);
          const label = r.status === "succeeded" ? "완료" : r.status === "failed" ? "실패" : r.status === "missing" ? "누락" : run?.status === "claimed" ? "검토 중" : "대기";
          const tone = r.status === "succeeded" ? "green" : r.status === "failed" || r.status === "missing" ? "red" : run?.status === "claimed" ? "indigo" : "slate";
          return (
            <li key={r.run_id} className="flex items-center justify-between rounded-2xl border border-line px-4 py-2 text-sm">
              <span>
                {ROLE_LABELS[r.role]}
                {r.extra && " (추가)"}
              </span>
              <Badge tone={tone}>{label}</Badge>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-muted">검토자는 같은 확정 기획과 자료만 보고 각각 따로 호출됩니다. 같은 모델의 별도 호출이므로 통계적으로 독립된 판단은 아닙니다.</p>
      {failed.length > 0 && !waiting && (
        <div className="mt-3 rounded-2xl border border-warn-line bg-warn-bg p-4 text-sm text-warn">
          <p>실패한 검토가 있습니다. 위 &apos;AI 작업 상태&apos;에서 실패한 역할만 다시 시도하거나, 누락으로 기록하고 진행할 수 있습니다. 누락이 있으면 &apos;검토 완료&apos;로 표시되지 않습니다.</p>
          <Button className="mt-2" variant="secondary" disabled={busy} onClick={() => act("PROCEED_WITH_MISSING_REVIEW")}>
            누락으로 기록하고 진행
          </Button>
        </div>
      )}
    </Card>
  );
}

export function ReplyPanel({ view, act, busy, filter }: PanelProps) {
  const { state } = view;
  const [showAll, setShowAll] = useState(false);
  const open = sortedOpenIssues(state);
  const followUps = open.filter((i) => i.follow_up && i.follow_up.answer === null);
  const batch = [...new Set([...followUps, ...open.slice(0, LIMITS.displayBatch)])];
  // 원탁에서 관점을 고르면 그 관점이 낸 쟁점을 모두(미해결 먼저, 끝난 것은 뒤에) 보여 준다.
  const shown = filter ? [...open, ...state.issues.filter((i) => !isUnresolved(i) && i.state !== "MERGED")].filter((i) => i.role === filter) : showAll ? open : batch;
  const mapping = state.pending_mapping;
  const waiting = state.pending_runs.some((r) => r.status === "queued");
  const unanswered = open.filter((i) => i.state === "OPEN").length;
  const pendingRequests = state.change_requests.filter((c) => c.status === "pending");

  return (
    <div className="space-y-4">
      {mapping && (
        <Card title="답변 해석 확인">
          <p className="mb-2 text-sm text-muted">입력하신 답변을 아래처럼 이해했습니다. 확인하기 전에는 반영하지 않습니다.</p>
          <blockquote className="mb-2 whitespace-pre-wrap rounded-2xl bg-surface-2 px-4 py-3 text-sm text-soft">{mapping.reply_text}</blockquote>
          <ul className="space-y-1 text-sm">
            {mapping.items.map((m) => (
              <li key={m.issue_id}>
                <span className="font-mono font-semibold">{m.issue_id}</span> → {{ accept: "수용", rebut: "반박", hold: "보류", add_info: "정보 추가" }[m.response_type]}: {m.interpreted_action}
              </li>
            ))}
            {mapping.change_requests.map((c, i) => (
              <li key={`cr${i}`}>
                <Badge tone="indigo">변경 요청</Badge> {c}
              </li>
            ))}
            {mapping.clarifications.map((c, i) => (
              <li key={`cl${i}`} className="text-warn">
                <Badge tone="amber">확인 필요</Badge> {c.question}
              </li>
            ))}
            {mapping.unanswered_issue_ids.length > 0 && <li className="text-muted">미응답으로 남는 쟁점: {mapping.unanswered_issue_ids.join(", ")}</li>}
            {mapping.items.length === 0 && mapping.change_requests.length === 0 && <li className="text-muted">연결된 쟁점이 없습니다.</li>}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => act("CONFIRM_REPLY_MAPPING", { mapping_id: mapping.mapping_id })}>
              이대로 반영
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => act("DISCARD_REPLY_MAPPING", { mapping_id: mapping.mapping_id })}>
              취소
            </Button>
          </div>
        </Card>
      )}

      <Card
        title={`쟁점 대응 (미해결 ${open.length}건 · 치명 ${unresolvedCritical(state).length}건)`}
        actions={
          <Button disabled={busy || waiting || Boolean(mapping)} onClick={() => act("PROCEED")}>
            응답 마치고 다음 단계로
          </Button>
        }
      >
        <p className="text-sm text-muted">
          중요한 순서로 {LIMITS.displayBatch}개씩 보여 드립니다. 버튼이나 아래 입력창으로 답해 주세요. 답하지 않은 {unanswered}건은 미응답으로 남습니다.
        </p>
        {pendingRequests.length > 0 && <p className="mt-2 text-sm text-accent">대기 중인 변경 요청: {pendingRequests.map((c) => c.text).join(" / ")}</p>}
      </Card>

      {shown.map((issue) => (
        <IssueCard key={issue.issue_id} issue={issue} state={state} act={act} busy={busy || waiting} />
      ))}
      {!filter && open.length > batch.length && (
        <Button variant="ghost" onClick={() => setShowAll(!showAll)}>
          {showAll ? "중요한 것만 보기" : `나머지 ${open.length - batch.length}건 더 보기`}
        </Button>
      )}
      {open.length === 0 && <p className="text-sm text-muted">미해결 쟁점이 없습니다. 다음 단계로 진행해 주세요.</p>}
    </div>
  );
}

// 변경안·판정 작업이 실패했을 때: 다시 시도하거나 응답 단계로 돌아갈 수 있다.
export function BackToReply({ view, act, busy }: PanelProps) {
  const failed = view.state.pending_runs.some((r) => r.status === "failed");
  const waiting = view.state.pending_runs.some((r) => r.status === "queued");
  if (!failed || waiting) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <p className="text-sm text-danger">AI 작업이 실패했습니다. 위에서 다시 시도하거나 응답 단계로 돌아갈 수 있습니다.</p>
      <Button variant="secondary" disabled={busy} onClick={() => act("RESUME_REPLY")}>
        응답 단계로 돌아가기
      </Button>
    </div>
  );
}

export function RevisionPanel({ view, act, busy }: PanelProps) {
  const { state } = view;
  const rev = state.revision;
  const plan = state.plan.current?.content;
  const [feedback, setFeedback] = useState("");
  const waiting = state.pending_runs.some((r) => r.status === "queued");
  if (!rev) {
    return (
      <Card title="변경안 확인">
        {waiting ? <p className="text-sm text-muted">작성자가 변경안을 만들고 있습니다.</p> : <p className="text-sm text-muted">확인할 변경안이 없습니다.</p>}
        <BackToReply view={view} act={act} busy={busy} />
      </Card>
    );
  }
  const addressed = rev.addressed_issue_ids.map((id) => state.issues.find((i) => i.issue_id === id)?.display_id ?? id);
  return (
    <Card title={`변경안 확인 → 적용하면 확정 기획 v${(state.plan.current?.version_no ?? 0) + 1}`}>
      <p className="text-sm font-medium text-ink">{rev.change_summary}</p>
      <p className="mt-1 text-xs text-muted">반영 대상 쟁점: {addressed.join(", ") || "없음"}</p>

      <h4 className="mt-3 text-sm font-semibold">바뀌는 내용</h4>
      <ul className="mt-1 space-y-2 text-sm">
        {rev.core_message && <li>핵심 메시지 → {rev.core_message}</li>}
        {rev.requested_decision && <li>요청 결정 → {rev.requested_decision}</li>}
        {rev.changes.map((c, i) => (
          <li key={i} className="rounded-2xl border border-line p-3">
            <Badge tone={c.op === "add" ? "green" : c.op === "remove" ? "red" : "amber"}>{c.op === "add" ? "추가" : c.op === "remove" ? "삭제" : "수정"}</Badge>{" "}
            <span className="font-mono text-xs text-faint">{c.claim_id ?? (c.section_key && SECTION_TITLES[c.section_key])}</span>
            {c.op !== "add" && c.claim_id && <p className="mt-1 text-muted line-through">{claimText(plan, c.claim_id)}</p>}
            {c.op !== "remove" && <p className="mt-1 text-ink">{c.text}</p>}
          </li>
        ))}
        {rev.fact_changes.map((f, i) => {
          const before = plan?.facts.find((x) => x.fact_id === f.fact_id);
          return (
            <li key={`f${i}`} className="rounded-2xl border border-line p-3">
              <Badge tone="indigo">숫자</Badge> {f.label}: {before ? `${before.value}${before.value !== "미정" ? before.unit : ""}` : "(없음)"} → <span className="font-semibold">{f.op === "remove" ? "삭제" : `${f.value}${f.value !== "미정" ? f.unit : ""}`}</span>
            </li>
          );
        })}
        {rev.changes.length + rev.fact_changes.length === 0 && <li className="text-muted">바뀌는 항목이 없습니다.</li>}
      </ul>

      <h4 className="mt-3 text-sm font-semibold">연쇄 영향 (인원·예산·일정·목표)</h4>
      {rev.cascade_impacts.length === 0 ? (
        <p className="text-sm text-muted">표시된 연쇄 영향이 없습니다.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="mt-1 w-full min-w-[420px] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1 pr-2">영역</th>
                <th className="py-1 pr-2">이전</th>
                <th className="py-1 pr-2">이후</th>
                <th className="py-1">비고</th>
              </tr>
            </thead>
            <tbody>
              {rev.cascade_impacts.map((c, i) => (
                <tr key={i} className="border-t border-line-soft">
                  <td className="py-1 pr-2">{FACT_AREA_LABELS[c.area]}</td>
                  <td className="py-1 pr-2">{c.before}</td>
                  <td className="py-1 pr-2 font-medium">{c.after}</td>
                  <td className="py-1 text-muted">{c.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rev.unaddressed.length > 0 && (
        <p className="mt-3 text-sm text-warn">
          반영하지 못한 쟁점: {rev.unaddressed.map((u) => `${u.issue_id} (${u.reason})`).join(", ")}
        </p>
      )}

      <div className="mt-4 space-y-2 border-t border-line-soft pt-3">
        <p className="text-sm text-muted">적용해야 기획이 바뀝니다. 적용한 뒤에는 실제 반영 결과로 해소 조건을 다시 검증합니다(적용만으로 해소되지 않습니다).</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || waiting} onClick={() => act("CONFIRM_REVISION", { revision_id: rev.revision_id })}>
            변경안 적용
          </Button>
          <Button variant="secondary" disabled={busy || waiting} onClick={() => act("REJECT_REVISION", { revision_id: rev.revision_id })}>
            적용하지 않음
          </Button>
        </div>
        <textarea className={inputClass} rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="변경안을 고쳐야 하면 내용을 적어 주세요" aria-label="변경안 수정 요청" />
        <Button
          variant="secondary"
          disabled={busy || waiting || !feedback.trim()}
          onClick={async () => {
            if (await act("REJECT_REVISION", { revision_id: rev.revision_id, feedback: feedback.trim() })) setFeedback("");
          }}
        >
          변경안 다시 요청
        </Button>
      </div>
    </Card>
  );
}

// 쟁점 현황 타일: 남은 대응(도넛) · 미해결 치명 · 해소
export function StatsBento({ state }: { state: ProjectState }) {
  const live = state.issues.filter((i) => i.state !== "MERGED");
  if (!live.length) return null;
  const left = live.filter((i) => i.state === "OPEN").length;
  const answered = live.length - left;
  const pct = Math.round((answered / live.length) * 100);
  const crit = unresolvedCritical(state);
  const resolved = live.filter((i) => i.state === "RESOLVED");
  const ids = (list: typeof live) => (list.length ? `${list.slice(0, 3).map((i) => i.display_id).join(" · ")}${list.length > 3 ? " …" : ""}` : "없음");
  const tile = "glass flex flex-col gap-1 rounded-3xl border p-4";
  return (
    <section aria-label="쟁점 현황" className="grid grid-cols-2 gap-3">
      <div className="glass col-span-2 flex items-center gap-4 rounded-3xl border border-line bg-surface p-4">
        <div
          aria-hidden="true"
          className="flex h-[88px] w-[88px] flex-none items-center justify-center rounded-full"
          style={{ background: `conic-gradient(var(--color-accent) 0 ${pct}%, var(--color-surface-2) ${pct}% 100%)` }}
        >
          <span className="flex h-[66px] w-[66px] items-center justify-center rounded-full bg-deep font-display text-xl text-ink">
            {answered}/{live.length}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-extrabold text-muted">남은 대응</span>
          <span className="font-display text-2xl text-ink">{left}건</span>
          <span className="text-xs text-muted">{left ? `쟁점 ${live.length}건 중 ${answered}건에 답했어요` : "모든 쟁점에 답했어요"}</span>
        </div>
      </div>
      <div className={`${tile} ${crit.length ? "border-danger-line bg-danger-bg" : "border-line bg-surface"}`}>
        <span className={`text-xs font-extrabold ${crit.length ? "text-danger" : "text-muted"}`}>미해결 치명</span>
        <span className={`font-display text-3xl ${crit.length ? "text-danger" : "text-ink"}`}>{crit.length}</span>
        <span className="font-mono text-xs text-muted">{ids(crit)}</span>
      </div>
      <div className={`${tile} border-ok/30 bg-ok-bg`}>
        <span className="text-xs font-extrabold text-ok">해소</span>
        <span className="font-display text-3xl text-ok">{resolved.length}</span>
        <span className="font-mono text-xs text-muted">{ids(resolved)}</span>
      </div>
    </section>
  );
}

export function SummaryPanel({ view, act, busy }: PanelProps) {
  const { state } = view;
  const live = state.issues.filter((i) => i.state !== "MERGED");
  const crit = unresolvedCritical(state);
  const missing = state.rounds.filter((r) => r.missing_roles.length > 0);
  const important = live.filter((i) => isUnresolved(i) && i.severity !== "minor").length;
  const canNext = state.round < LIMITS.maxRounds && (state.round < LIMITS.maxRounds - 1 || important > 0);
  return (
    <Card title={`${state.round}라운드 정리`}>
      <div className="flex flex-wrap gap-2 text-sm">
        {ISSUE_STATES.filter((s) => s !== "MERGED").map((s) => (
          <span key={s} className="rounded-full bg-surface-2 px-3 py-1">
            {ISSUE_STATE_LABELS[s]} <span className="font-semibold">{live.filter((i) => i.state === s).length}</span>
          </span>
        ))}
      </div>
      <p className={`mt-3 text-sm ${crit.length ? "font-medium text-danger" : "text-soft"}`}>{crit.length ? `미해결 치명 이슈 ${crit.length}건: ${crit.map((i) => i.display_id).join(", ")}` : "미해결 치명 이슈는 없습니다."}</p>
      {missing.length > 0 && (
        <p className="mt-1 text-sm text-warn">
          검토 누락: {missing.map((m) => `${m.round}라운드 ${m.missing_roles.map((r) => ROLE_LABELS[r]).join("·")}`).join(", ")} — 누락이 있으면 검토 완료로 표시하지 않습니다.
        </p>
      )}
      <p className="mt-1 text-xs text-muted">토론을 끝내는 것과 쟁점이 해소되는 것은 다릅니다. 종료는 추진 승인이나 사실 검증 완료를 뜻하지 않습니다.</p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={busy || !canNext} onClick={() => act("REQUEST_REVIEW")} title={canNext ? "" : "최대 라운드에 도달했거나 3라운드를 진행할 중요한 미해결 쟁점이 없습니다."}>
          {state.round + 1}라운드 검토 시작
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => act("RESUME_REPLY")}>
          쟁점 응답 계속하기
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => act("FINISH", { via_command: false })}>
          검토 마치고 산출물 만들기
        </Button>
      </div>
      {!canNext && <p className="mt-1 text-xs text-muted">{state.round >= LIMITS.maxRounds ? `검토는 최대 ${LIMITS.maxRounds}라운드입니다.` : "3라운드는 중요한 미해결 쟁점이 남았을 때만 진행합니다."}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">역할별 추가 검토(라운드 수와 별도):</span>
        {ROLES.map((r) => (
          <Button key={r} variant="ghost" disabled={busy} onClick={() => act("EXTRA_REVIEW", { role: r })}>
            {ROLE_LABELS[r]}
          </Button>
        ))}
      </div>
    </Card>
  );
}

export function GeneratingPanel({ view, act, busy }: PanelProps) {
  const { state } = view;
  const gen = state.generation;
  const steps: { label: string; done: boolean }[] = [
    { label: "결과 판단", done: Boolean(gen?.decision_status) },
    { label: "상세 기획서", done: Boolean(gen?.plan_doc) },
    { label: "PPT 스토리라인", done: Boolean(gen?.storyline) },
    { label: "예상 질의응답", done: Boolean(gen?.qa) },
    { label: "논쟁 기록·검사", done: false },
  ];
  const failed = state.pending_runs.some((r) => r.status === "failed");
  const waiting = state.pending_runs.some((r) => r.status === "queued");
  return (
    <Card title="산출물 생성 중 (같은 확정 스냅샷으로 네 가지를 만듭니다)">
      <ol className="space-y-1.5 text-sm">
        {steps.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <Badge tone={s.done ? "green" : "slate"}>{s.done ? "완료" : "대기"}</Badge>
            {s.label}
          </li>
        ))}
      </ol>
      {failed && !waiting && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="text-sm text-danger">생성 중 실패한 작업이 있습니다. 위에서 다시 시도하거나 재작업으로 돌아갈 수 있습니다.</p>
          <Button variant="secondary" disabled={busy} onClick={() => act("START_REWORK")}>
            생성 취소하고 돌아가기
          </Button>
        </div>
      )}
    </Card>
  );
}

export function OutputsPanel({ view, act, busy }: PanelProps) {
  const { state } = view;
  const outputs = [...state.outputs].reverse();
  const ready = state.phase === "OUTPUT_READY";
  if (!outputs.length) return null;
  return (
    <Card title="산출물">
      <ul className="space-y-3">
        {outputs.map((o, idx) => (
          <li key={o.output_snapshot_id} className="rounded-2xl border border-line p-4 text-sm">
            <div className="flex flex-wrap items-center gap-1.5">
              {idx === 0 && <Badge tone="indigo">최신</Badge>}
              <span className="font-medium">확정 기획 v{o.plan_version_no}</span>
              <Badge>{AUDIENCE_LABELS[o.audience]}용</Badge>
              <Badge tone={o.outcome === "RESOLVED_CORE" ? "green" : o.outcome === "CONDITIONAL" ? "amber" : "red"}>{OUTCOME_LABELS[o.outcome]}</Badge>
              <Badge>{END_REASON_LABELS[o.end_reason]}</Badge>
              <span className="text-xs text-muted">
                {kst(o.created_at)} · 스냅샷 {o.output_snapshot_id.slice(0, 8)}
              </span>
            </div>
            <p className={`mt-1 text-xs ${o.validation.errors.length ? "text-danger" : "text-muted"}`}>
              검사: 오류 {o.validation.errors.length}건, 확인 필요 {o.validation.warnings.length}건{o.validation.errors.length > 0 && " — 오류가 있는 산출물입니다. 내용을 확인해 주세요."}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Link href={`/projects/${state.project_id}/outputs/${o.output_snapshot_id}`} className="glow-accent inline-flex min-h-10 items-center rounded-full bg-accent px-4 py-1.5 text-sm font-bold text-on-accent hover:bg-accent-hi">
                보기·인쇄
              </Link>
              <a href={`/api/projects/${state.project_id}/outputs/${o.output_snapshot_id}?format=md`} className="glass inline-flex min-h-10 items-center rounded-full border border-line bg-surface px-4 py-1.5 text-sm font-medium text-ink hover:bg-surface-2">
                Markdown 내려받기
              </a>
            </div>
          </li>
        ))}
      </ul>
      {ready && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
          <Button variant="secondary" disabled={busy} onClick={() => act("SET_AUDIENCE", { audience: state.settings.storyline_audience === "executive" ? "department" : "executive" })}>
            스토리라인 대상: {AUDIENCE_LABELS[state.settings.storyline_audience]}용 (바꾸기)
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => act("GENERATE_OUTPUT")}>
            다시 생성
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => act("START_REWORK")}>
            새 버전으로 수정 시작
          </Button>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">기획을 고쳐도 이전 산출물은 원래 스냅샷을 그대로 가리킵니다.</p>
    </Card>
  );
}
