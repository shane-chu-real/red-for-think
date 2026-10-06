"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { COMMAND_HELP, parseCommand } from "@/core/commands";
import { ACTOR_LABELS, LIMITS, PHASES, PHASE_LABELS, PROJECT_TYPE_LABELS, ROLES, ROLE_LABELS, type Phase, type Role } from "@/core/constants";
import { isUnresolved, unresolvedCritical } from "@/core/state";
import type { ProjectState } from "@/core/types";
import { apiGet, apiPost, kst, newKey } from "@/lib/client";
import { StatusBar } from "../StatusBar";
import { Badge, Button, Card, ErrorNote, inputClass } from "../ui";
import { IssueCard } from "./IssueCard";
import { AiWork, BackToReply, GeneratingPanel, IntakePanel, OutlinePanel, OutputsPanel, ReplyPanel, ReviewPanel, RevisionPanel, StatsBento, SummaryPanel } from "./panels";
import { Roundtable } from "./Roundtable";
import { PlanView, ROLE_STYLE, RoleAvatar, roleTint, type Act, type ProjectView } from "./shared";

type SaveState = "idle" | "saving" | "saved" | "failed";

const INPUT_HINT: Partial<Record<Phase, string>> = {
  INTAKE: "질문에 대한 답이나 추가 정보를 자유롭게 적어 주세요",
  OUTLINE_CONFIRM: "뼈대에서 고칠 점을 적어 주세요",
  WAITING_REPLY: "예: I-001 수용, 30명 파일럿으로 바꿔줘. I-002 보류, IT팀에 확인할게",
  ROUND_SUMMARY: "쟁점에 대한 답을 적으면 응답 단계로 돌아갑니다",
  REVISION_CONFIRM: "변경안에서 고칠 점을 적어 주세요",
};

const NEUTRAL_INITIAL: Record<string, string> = { moderator: "진", writer: "작" };

// 대화와 기록의 한 줄: 내 말은 오른쪽 말풍선, 다섯 관점은 고유색 얼굴, 진행자·작성자·시스템은 중립색
function TimelineItem({ t }: { t: ProjectState["timeline"][number] }) {
  if (t.actor === "user") {
    return (
      <li className="flex justify-end">
        <div className="max-w-[85%] rounded-[22px_6px_22px_22px] border border-accent/30 bg-accent/15 px-4 py-2.5 text-sm text-ink">
          <p className="whitespace-pre-wrap">{t.text}</p>
          <span className="mt-1 block text-right text-[11px] text-muted">{kst(t.at)}</span>
        </div>
      </li>
    );
  }
  const role = (ROLES as readonly string[]).includes(t.actor) ? (t.actor as Role) : null;
  return (
    <li className="flex items-start gap-2.5">
      {role ? (
        <RoleAvatar role={role} size={28} />
      ) : (
        <span aria-hidden="true" className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full border border-line bg-surface-2 text-[11px] font-extrabold text-soft">
          {NEUTRAL_INITIAL[t.actor] ?? "·"}
        </span>
      )}
      <div className={`min-w-0 flex-1 pt-0.5 text-sm ${t.kind === "error" ? "text-danger" : t.kind === "note" ? "text-muted" : "text-soft"}`}>
        <span className="mr-1.5 text-xs font-extrabold" style={role ? { color: ROLE_STYLE[role].color } : undefined}>
          {ACTOR_LABELS[t.actor] ?? t.actor}
        </span>
        <span className="whitespace-pre-wrap">{t.text}</span>
        <span className="ml-1.5 text-[11px] text-faint">{kst(t.at)}</span>
      </div>
    </li>
  );
}

export function Workspace({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [tab, setTab] = useState<"plan" | "issues" | "sources">("plan");
  const [text, setText] = useState("");
  // 원탁에서 고른 관점. 고르면 그 관점이 말한 내용만 보인다.
  const [filter, setFilter] = useState<Role | null>(null);
  const busyRef = useRef(false);
  const logRef = useRef<HTMLOListElement>(null);

  const load = useCallback(async () => {
    const res = await apiGet<ProjectView>(`/api/projects/${projectId}`);
    if (res.ok && res.data) {
      setView(res.data);
      return true;
    }
    setError(res.error?.message ?? "프로젝트를 불러오지 못했습니다.");
    return false;
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // AI 작업이 대기 중이면 3초, 아니면 20초 간격으로 다시 불러온다.
  const waiting = view?.state.pending_runs.some((r) => r.status === "queued") ?? false;
  useEffect(() => {
    const id = setInterval(
      () => {
        if (!busyRef.current && document.visibilityState === "visible") void load();
      },
      waiting ? 3000 : 20000,
    );
    // 다른 창에 있다가 돌아오면 바로 최신 상태를 불러온다.
    const onVisible = () => {
      if (document.visibilityState === "visible" && !busyRef.current) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, waiting]);

  // 새 기록이 생기거나 관점을 바꾸면 대화 창을 맨 아래(최신)로 내린다.
  const logLength = view?.state.timeline.length ?? 0;
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLength, filter]);

  const act: Act = useCallback(
    async (action, payload = {}) => {
      if (!view || busyRef.current) return false;
      busyRef.current = true;
      setSave("saving");
      setError(null);
      const res = await apiPost(`/api/projects/${projectId}/actions`, { action, expected_state_version: view.state_version, request_key: newKey(), payload });
      busyRef.current = false;
      if (res.ok) {
        setSave("saved");
        setSavedAt(new Date().toISOString());
        await load();
        return true;
      }
      // 저장되지 않았으면 완료로 표시하지 않는다.
      setSave("failed");
      setError(res.error?.message ?? "저장하지 못했습니다.");
      if (res.error?.code === "VERSION_CONFLICT") await load();
      return false;
    },
    [view, projectId, load],
  );

  if (!view) {
    return (
      <>
        <StatusBar status={null} title="기획 작업실" back />
        <main className="mx-auto max-w-7xl p-4">{error ? <ErrorNote message={error} /> : <p className="text-sm text-muted">불러오는 중…</p>}</main>
      </>
    );
  }

  const { state } = view;
  const busy = save === "saving";
  const plan = state.plan.current;
  const crit = unresolvedCritical(state);
  const props = { view, act, busy, filter };
  const phaseIndex = PHASES.indexOf(state.phase);
  const canRespond = ["WAITING_REPLY", "ROUND_SUMMARY"].includes(state.phase);
  // 고른 관점이 낸 쟁점(미해결 먼저)과 남긴 기록
  const roleIssues = filter ? state.issues.filter((i) => i.role === filter && i.state !== "MERGED").sort((a, b) => Number(isUnresolved(b)) - Number(isUnresolved(a))) : [];
  const timeline = state.timeline.filter((t) => !filter || t.actor === filter).slice(-60);

  async function submitText() {
    const t = text.trim();
    if (!t) return;
    const cmd = parseCommand(t);
    let ok = false;
    if (cmd) ok = await act(cmd.type, cmd.payload);
    else if (t.startsWith("/")) {
      setError(`알 수 없는 명령입니다. 사용할 수 있는 명령: ${COMMAND_HELP.join(" | ")}`);
      return;
    } else if (state.phase === "INTAKE") ok = await act("ANSWER_INTAKE", { text: t });
    else if (state.phase === "OUTLINE_CONFIRM") ok = await act("REVISE_OUTLINE", { feedback: t });
    else if (state.phase === "WAITING_REPLY" || state.phase === "ROUND_SUMMARY") ok = await act("SUBMIT_REPLY", { text: t });
    else if (state.phase === "REVISION_CONFIRM" && state.revision) ok = await act("REJECT_REVISION", { revision_id: state.revision.revision_id, feedback: t });
    else {
      setError("이 단계에서는 자유 입력을 받지 않습니다. 명령(/마무리 등)은 쓸 수 있습니다.");
      return;
    }
    if (ok) setText("");
  }

  return (
    <>
      <StatusBar status={view.status} title={state.title} back />
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-4">
        {/* 지금 단계, 확정 버전, 저장 상태 */}
        <section className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <ol className="flex flex-wrap gap-1.5 text-xs">
            {PHASES.map((p, idx) => (
              <li
                key={p}
                className={`rounded-full px-3 py-1 ${p === state.phase ? "bg-accent font-extrabold text-on-accent" : idx < phaseIndex ? "bg-surface-2 text-soft" : "text-faint"}`}
                aria-current={p === state.phase ? "step" : undefined}
              >
                {PHASE_LABELS[p]}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge>{PROJECT_TYPE_LABELS[state.type]}</Badge>
            <Badge tone="indigo">{plan ? `확정 기획 v${plan.version_no}` : "확정 기획 없음"}</Badge>
            {state.round > 0 && <Badge>{state.round}라운드 / 최대 {LIMITS.maxRounds}</Badge>}
            <Badge>검토 강도 {state.settings.intensity}</Badge>
            {crit.length > 0 && <Badge tone="red">미해결 치명 {crit.length}</Badge>}
          </div>
          <span className="ml-auto text-xs" role="status" aria-live="polite">
            {save === "saving" && <span className="text-accent">저장 중…</span>}
            {save === "saved" && <span className="text-ok">저장 완료 {kst(savedAt)}</span>}
            {save === "failed" && <span className="font-semibold text-danger">저장 실패 — 반영되지 않았습니다</span>}
            {save === "idle" && <span className="text-muted">마지막 저장 {kst(view.updated_at)}</span>}
          </span>
        </section>

        <ErrorNote message={error} />

        <Roundtable state={state} runs={view.runs} filter={filter} onFilter={setFilter} />

        {/* 좁은 화면에서 표의 최소 폭이 칸을 밀어내지 않도록 두 칸 모두 min-w-0 */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="min-w-0 space-y-4">
            {filter && (
              <div className="glass flex flex-wrap items-center gap-2.5 rounded-2xl border px-4 py-2" style={{ background: roleTint(filter, 0.14), borderColor: ROLE_STYLE[filter].color }} role="status">
                <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: ROLE_STYLE[filter].color, boxShadow: `0 0 10px ${ROLE_STYLE[filter].color}` }} />
                <span className="text-sm font-medium text-ink">
                  {ROLE_LABELS[filter]} 관점의 발언 {roleIssues.length}건만 보는 중
                </span>
                <Button className="ml-auto" variant="secondary" onClick={() => setFilter(null)}>
                  전체 보기
                </Button>
              </div>
            )}
            {/* 응답 단계에서는 쟁점 대응 패널이 고른 관점의 쟁점을 보여 준다. */}
            {filter && state.phase !== "WAITING_REPLY" && roleIssues.map((issue) => <IssueCard key={issue.issue_id} issue={issue} state={state} act={act} busy={busy || waiting} readOnly={!canRespond} />)}

            <AiWork {...props} />
            {state.phase === "INTAKE" && <IntakePanel {...props} />}
            {state.phase === "OUTLINE_CONFIRM" && <OutlinePanel {...props} />}
            {state.phase === "REVIEWING" && <ReviewPanel {...props} />}
            {state.phase === "WAITING_REPLY" && <ReplyPanel {...props} />}
            {state.phase === "REVISION_CONFIRM" && <RevisionPanel {...props} />}
            {state.phase === "VERIFYING" && (
              <Card title="재검증">
                <p className="text-sm text-muted">진행자가 실제 적용 결과와 근거로 해소 조건을 하나씩 검증하고 있습니다.</p>
                <BackToReply {...props} />
              </Card>
            )}
            {state.phase === "ROUND_SUMMARY" && <SummaryPanel {...props} />}
            {state.phase === "GENERATING" && <GeneratingPanel {...props} />}
            <OutputsPanel {...props} />

            <Card title="대화와 기록">
              <ol ref={logRef} className="max-h-96 space-y-3 overflow-y-auto pr-1">
                {timeline.length === 0 && <li className="text-sm text-muted">{filter ? "이 관점이 남긴 기록이 없습니다." : "아직 기록이 없습니다."}</li>}
                {timeline.map((t, i) => (
                  <TimelineItem key={i} t={t} />
                ))}
              </ol>
              <div className="no-print mt-4 border-t border-line-soft pt-4">
                <div className="glass flex items-end gap-2 rounded-3xl border border-line bg-surface py-2 pl-4 pr-2 focus-within:border-accent">
                  <textarea
                    className="min-h-11 flex-1 resize-none bg-transparent py-2.5 text-sm text-ink placeholder:text-faint focus:outline-none"
                    rows={2}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submitText();
                    }}
                    placeholder={INPUT_HINT[state.phase] ?? "명령을 입력할 수 있습니다 (/마무리 등)"}
                    aria-label="답변 또는 명령 입력"
                  />
                  <button
                    type="button"
                    aria-label="보내기"
                    disabled={busy || !text.trim()}
                    onClick={() => void submitText()}
                    className="glow-accent inline-flex h-11 w-11 flex-none items-center justify-center rounded-full bg-accent text-on-accent transition-colors hover:bg-accent-hi disabled:cursor-not-allowed disabled:bg-accent/25 disabled:text-soft disabled:shadow-none"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12h14" />
                      <path d="M13 6l6 6-6 6" />
                    </svg>
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted">명령: /강도1~3 · /재무 /리스크 /현업 /경영진 /IT · /스킵 · /마무리 · /임원용 /유관부서용 (Ctrl+Enter로 전송)</p>
              </div>
            </Card>
          </div>

          <aside className="min-w-0 space-y-4">
            <StatsBento state={state} />
            <Card
              title={
                <div className="flex gap-1" role="tablist">
                  {(
                    [
                      ["plan", "기획 뼈대"],
                      ["issues", `쟁점 ${state.issues.length}`],
                      ["sources", `자료 ${state.sources.length}`],
                    ] as const
                  ).map(([key, label]) => (
                    <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`min-h-9 rounded-full px-3 py-1 text-sm ${tab === key ? "bg-accent font-bold text-on-accent" : "font-medium text-muted hover:bg-surface-2"}`}>
                      {label}
                    </button>
                  ))}
                </div>
              }
            >
              {tab === "plan" &&
                (plan ? (
                  <>
                    <p className="mb-2 text-xs text-muted">
                      v{plan.version_no} · {kst(plan.confirmed_at)} 확정 · {plan.change_summary}
                    </p>
                    <PlanView plan={plan.content} />
                    {state.plan.history.length > 1 && (
                      <details className="mt-3 text-xs text-muted">
                        <summary className="cursor-pointer">버전 이력 {state.plan.history.length}개</summary>
                        <ul className="mt-1 space-y-1">
                          {state.plan.history.map((h) => (
                            <li key={h.plan_version_id}>
                              v{h.version_no} · {kst(h.confirmed_at)} · {h.change_summary}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted">아직 확정된 기획이 없습니다. 뼈대를 확인하면 여기에 표시됩니다.</p>
                ))}
              {tab === "issues" && (
                <div className="space-y-4">
                  {state.issues.length === 0 && <p className="text-sm text-muted">아직 쟁점이 없습니다.</p>}
                  {state.issues
                    .filter((i) => !filter || i.role === filter)
                    .map((issue) => (
                      <IssueCard key={issue.issue_id} issue={issue} state={state} act={act} busy={busy || waiting} readOnly={!canRespond} />
                    ))}
                </div>
              )}
              {tab === "sources" && <Sources view={view} act={act} busy={busy} />}
            </Card>
          </aside>
        </div>
      </main>
    </>
  );
}

function Sources({ view, act, busy }: { view: ProjectView; act: Act; busy: boolean }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const total = view.sources.reduce((a, s) => a + s.char_count, 0);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted">
        등록한 자료는 텍스트 그대로 저장되며, 이후 모든 AI 작업에 전체가 외부 AI로 전송됩니다. 합계 {total.toLocaleString()} / {LIMITS.sourcesTotalMaxChars.toLocaleString()}자.
      </p>
      {view.sources.map((s) => (
        <details key={s.source_id} className="rounded-2xl border border-line p-3">
          <summary className="cursor-pointer">
            <span className="font-mono text-xs text-faint">{s.source_id}</span> {s.title} <span className="text-xs text-muted">({s.char_count.toLocaleString()}자 · 추출 성공 · AI 전송 대상)</span>
          </summary>
          <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-soft">{s.body}</p>
        </details>
      ))}
      {view.state.phase !== "GENERATING" && (
        <div className="space-y-2 border-t border-line-soft pt-3">
          <input className={inputClass} placeholder="자료 이름" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="자료 이름" />
          <textarea className={inputClass} rows={4} placeholder="자료 내용을 붙여넣으세요 (파일 업로드는 지원하지 않습니다)" value={body} onChange={(e) => setBody(e.target.value)} aria-label="자료 내용" />
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              disabled={busy || !title.trim() || !body.trim()}
              onClick={async () => {
                if (await act("ADD_SOURCE", { title: title.trim(), text: body })) {
                  setTitle("");
                  setBody("");
                }
              }}
            >
              자료 추가
            </Button>
            <span className="text-xs text-muted">{body.trim().length.toLocaleString()}자</span>
          </div>
        </div>
      )}
    </div>
  );
}
