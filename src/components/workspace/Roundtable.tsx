"use client";
import { PHASE_LABELS, ROLE_LABELS, type IssueState, type Phase, type Role } from "@/core/constants";
import { sortedOpenIssues } from "@/core/state";
import type { ProjectState } from "@/core/types";
import type { RunView } from "@/lib/client";
import { ROLE_STYLE, RoleAvatar, roleTint } from "./shared";

// 원탁 자리: 맞은편(위)부터 시계 방향. '나'는 앞쪽 가운데(180°)에 앉는다.
const SEATS: { role: Role; angle: number }[] = [
  { role: "executive", angle: 0 },
  { role: "risk", angle: 60 },
  { role: "it", angle: 120 },
  { role: "field", angle: 240 },
  { role: "finance", angle: 300 },
];
const RX = 320;
const RY = 160;

const MY_TURN: Record<Phase, string> = {
  INTAKE: "질문에 답할 차례",
  OUTLINE_CONFIRM: "뼈대를 확인할 차례",
  REVIEWING: "검토를 듣는 중",
  WAITING_REPLY: "",
  REVISION_CONFIRM: "변경안을 확인할 차례",
  VERIFYING: "판정을 기다리는 중",
  ROUND_SUMMARY: "다음 행동을 고를 차례",
  GENERATING: "산출물을 만드는 중",
  OUTPUT_READY: "산출물을 확인할 차례",
};

interface Seat {
  role: Role;
  count: number; // 이 관점이 낸 쟁점 수(병합된 것 제외)
  quote: string; // 대표 발언 한 줄
  status: string;
  critical: number; // 미해결 치명 수
  speaking: boolean; // 지금 검토 중
}

const shorten = (text: string, max = 32) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function seatsOf(state: ProjectState, runs: RunView[]): Seat[] {
  const open = sortedOpenIssues(state);
  return SEATS.map(({ role }) => {
    const mine = state.issues.filter((i) => i.role === role && i.state !== "MERGED");
    const mineOpen = open.filter((i) => i.role === role);
    const pending = state.pending_runs.find((p) => p.task === "review" && p.role === role);
    const speaking = pending?.status === "queued" && runs.find((r) => r.run_id === pending.run_id)?.status === "claimed";
    const n = (s: IssueState) => mine.filter((i) => i.state === s).length;
    let quote: string;
    let status: string;
    if (speaking) [quote, status] = ["기획을 검토하고 있어요", "검토 중"];
    else if (pending?.status === "queued") [quote, status] = ["차례를 기다리고 있어요", "검토 대기"];
    else if (pending?.status === "failed") [quote, status] = ["검토를 마치지 못했어요", "검토 실패"];
    else if (!mine.length) [quote, status] = state.round > 0 ? ["지적할 것이 없어요", "지적 없음"] : ["아직 발언 전이에요", "검토 전"];
    else {
      const top = mineOpen[0] ?? mine[mine.length - 1];
      quote = shorten(top.headline?.trim() || top.critique);
      const parts = [
        n("OPEN") && `미대응 ${n("OPEN")}`,
        n("CHANGE_PENDING") && `수용 ${n("CHANGE_PENDING")}`,
        n("EVIDENCE_PENDING") && `보류 ${n("EVIDENCE_PENDING")}`,
        n("REBUTTAL_PENDING") && `반박 ${n("REBUTTAL_PENDING")}`,
        n("RECHECK_PENDING") && `재검증 ${n("RECHECK_PENDING")}`,
      ].filter(Boolean);
      status = parts.length ? parts.slice(0, 2).join(" · ") : "모두 해소";
    }
    return { role, count: mine.length, quote, status, critical: mineOpen.filter((i) => i.severity === "critical").length, speaking: Boolean(speaking) };
  });
}

// 원탁: 탁자 위에 주제, 앞쪽 가운데에 나, 둘레에 다섯 관점. 자리를 누르면 그 관점의 발언만 본다.
export function Roundtable({ state, runs, filter, onFilter }: { state: ProjectState; runs: RunView[]; filter: Role | null; onFilter: (role: Role | null) => void }) {
  const seats = seatsOf(state, runs);
  const live = state.issues.filter((i) => i.state !== "MERGED");
  const unanswered = live.filter((i) => i.state === "OPEN").length;
  const plan = state.plan.current;
  const waiting = state.pending_runs.some((r) => r.status === "queued");
  const myTurn = waiting && state.phase !== "REVIEWING" ? "AI가 작업하는 중" : MY_TURN[state.phase] || `남은 대응 ${unanswered}`;
  const topicHint = filter ? "눌러서 전체 발언 보기" : live.length ? `쟁점 ${live.length} · 남은 대응 ${unanswered}` : `${PHASE_LABELS[state.phase]} 단계`;
  const pick = (role: Role) => onFilter(filter === role ? null : role);
  const label = (s: Seat) => (filter === s.role ? `${ROLE_LABELS[s.role]} 관점 거르기 해제` : `${ROLE_LABELS[s.role]} 관점의 발언 ${s.count}건만 보기`);

  return (
    <section aria-label="원탁" className="no-print">
      <div className="relative hidden h-[480px] rounded-[32px] min-[1100px]:block" style={{ background: "radial-gradient(ellipse 55% 65% at 50% 52%, rgb(124 140 255 / 0.20), transparent 70%)" }}>
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-[340px] w-[700px] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-dashed border-line-soft" />
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 h-[232px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-line"
          style={{
            background: "radial-gradient(ellipse at 50% 35%, #2C2868 0%, #18163C 55%, #110F28 100%)",
            boxShadow: "0 0 0 10px rgb(124 140 255 / 0.05), 0 30px 90px rgb(124 140 255 / 0.30), inset 0 2px 0 rgb(255 255 255 / 0.08)",
          }}
        />

        <button
          type="button"
          onClick={() => onFilter(null)}
          aria-label="주제 · 전체 발언 보기"
          className="glass absolute left-1/2 top-1/2 flex w-[270px] -translate-x-1/2 -translate-y-1/2 flex-col gap-1 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-left shadow-[0_12px_30px_rgb(0_0_0/0.35)]"
        >
          <span className="text-[11.5px] font-extrabold tracking-wider text-accent">주제 · {plan ? `확정 기획 v${plan.version_no}` : "뼈대 확정 전"}</span>
          <span className="line-clamp-2 font-display text-lg leading-snug text-ink">{state.title}</span>
          <span className="text-xs text-muted">{topicHint}</span>
        </button>

        {seats.map((s) => {
          const { color } = ROLE_STYLE[s.role];
          const t = (SEATS.find((x) => x.role === s.role)!.angle * Math.PI) / 180;
          const x = Math.round(RX * Math.sin(t));
          const y = Math.round(-RY * Math.cos(t));
          const left = x < -20;
          const selected = filter === s.role;
          const lit = selected || s.speaking;
          return (
            <button
              key={s.role}
              type="button"
              disabled={s.count === 0}
              onClick={() => pick(s.role)}
              aria-pressed={selected}
              aria-label={label(s)}
              className={`absolute flex items-center gap-3 rounded-3xl p-1.5 transition-opacity ${left ? "flex-row-reverse text-right" : "text-left"} ${s.count === 0 ? "cursor-default" : "cursor-pointer"}`}
              style={{
                left: `calc(50% + ${x}px)`,
                top: `calc(50% + ${y}px)`,
                transform: left ? "translate(calc(-100% + 35px), -50%)" : "translate(-35px, -50%)",
                opacity: filter && !selected ? 0.35 : 1,
              }}
            >
              <RoleAvatar role={s.role} size={58} active={lit} className={lit ? "rt-pulse" : ""} />
              <span className={`flex max-w-[200px] flex-col gap-1.5 ${left ? "items-end" : "items-start"}`}>
                <span className="inline-flex items-center gap-2 font-display text-base" style={{ color }}>
                  {ROLE_LABELS[s.role]}
                  {lit && (
                    <span className="rt-eq" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  <span className="font-sans text-xs font-normal text-muted">발언 {s.count}</span>
                </span>
                <span
                  className="glass rounded-2xl border px-3 py-2 text-[13.5px] leading-snug text-ink"
                  style={{
                    background: selected ? roleTint(s.role, 0.16) : "rgb(255 255 255 / 0.06)",
                    borderColor: selected ? color : "rgb(255 255 255 / 0.12)",
                    boxShadow: selected ? `0 10px 30px ${roleTint(s.role, 0.25)}` : "none",
                  }}
                >
                  “{s.quote}”
                </span>
                <span className="text-xs text-muted">
                  {s.critical > 0 && <span className="text-danger">치명 {s.critical} · </span>}
                  {s.status}
                </span>
              </span>
            </button>
          );
        })}

        <div className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5 text-center" style={{ top: `calc(50% + ${RY}px)`, marginTop: -32 }}>
          <span
            className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-accent font-display text-[22px] text-on-accent"
            style={{ boxShadow: "0 0 0 4px var(--color-ground), 0 0 0 6px var(--color-accent), 0 0 40px var(--color-accent)" }}
          >
            나
          </span>
          <span className="text-[13.5px] font-extrabold text-ink">나 · 기획자</span>
          <span className="text-xs text-muted">{myTurn}</span>
        </div>
      </div>

      <div role="group" aria-label="관점 고르기" className="flex flex-wrap gap-2 py-2 min-[1100px]:hidden">
        {seats.map((s) => {
          const selected = filter === s.role;
          return (
            <button
              key={s.role}
              type="button"
              disabled={s.count === 0}
              onClick={() => pick(s.role)}
              aria-pressed={selected}
              aria-label={label(s)}
              className="glass inline-flex min-h-11 items-center gap-2 rounded-full border py-1 pl-1.5 pr-3.5 text-sm text-ink disabled:opacity-60"
              style={{ background: selected ? roleTint(s.role, 0.16) : "rgb(255 255 255 / 0.06)", borderColor: selected ? ROLE_STYLE[s.role].color : "rgb(255 255 255 / 0.12)" }}
            >
              <RoleAvatar role={s.role} size={32} active={selected || s.speaking} />
              {ROLE_LABELS[s.role]} {s.count}
              {s.critical > 0 && <span className="text-xs text-danger">치명 {s.critical}</span>}
            </button>
          );
        })}
      </div>
      {live.length > 0 && <p className="mt-1 hidden text-center text-xs text-muted min-[1100px]:block">자리를 누르면 그 관점의 발언만 보여요 · 탁자 위 주제를 누르면 전체로 돌아와요</p>}
    </section>
  );
}
