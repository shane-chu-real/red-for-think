"use client";
import {
  INFO_KIND_LABELS,
  ISSUE_STATE_LABELS,
  ROLE_LABELS,
  SEVERITY_LABELS,
  type InfoKind,
  type IssueState,
  type Role,
  type Severity,
} from "@/core/constants";
import type { PlanContent, ProjectState, SourceDoc } from "@/core/types";
import type { RunView, StatusView } from "@/lib/client";
import { Badge } from "../ui";

export interface ProjectView {
  state: ProjectState;
  state_version: number;
  updated_at: string;
  runs: RunView[];
  sources: Pick<SourceDoc, "source_id" | "title" | "body" | "char_count" | "created_at">[];
  status: StatusView;
}

// 화면에서 서버로 보내는 동작 함수. 성공 여부를 돌려준다.
export type Act = (action: string, payload?: unknown) => Promise<boolean>;

export interface PanelProps {
  view: ProjectView;
  act: Act;
  busy: boolean;
  // 원탁에서 고른 관점. 있으면 그 관점이 말한 내용만 보여 준다.
  filter?: Role | null;
}

// 다섯 관점의 고유색과 머리글자(원탁 자리·말풍선·기록에서 같은 색으로 구분한다)
export const ROLE_STYLE: Record<Role, { color: string; rgb: string; initial: string }> = {
  executive: { color: "#7C8CFF", rgb: "124 140 255", initial: "경" },
  risk: { color: "#FF6B8B", rgb: "255 107 139", initial: "리" },
  field: { color: "#2EE6A8", rgb: "46 230 168", initial: "현" },
  finance: { color: "#FFC24B", rgb: "255 194 75", initial: "재" },
  it: { color: "#B57BFF", rgb: "181 123 255", initial: "IT" },
};
export const roleTint = (role: Role, alpha: number) => `rgb(${ROLE_STYLE[role].rgb} / ${alpha})`;

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={severity === "critical" ? "red" : severity === "major" ? "amber" : "slate"}>{SEVERITY_LABELS[severity]}</Badge>;
}

export function StateBadge({ state }: { state: IssueState }) {
  const tone = state === "RESOLVED" ? "green" : state === "WITHDRAWN" || state === "MERGED" ? "slate" : state === "OPEN" ? "red" : "amber";
  return <Badge tone={tone}>{ISSUE_STATE_LABELS[state]}</Badge>;
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-extrabold text-on-accent" style={{ background: ROLE_STYLE[role].color }}>
      {ROLE_LABELS[role]} 검토자
    </span>
  );
}

// 관점 얼굴: 고유색 테두리의 동그라미. size는 px.
export function RoleAvatar({ role, size = 40, active = false, className = "" }: { role: Role; size?: number; active?: boolean; className?: string }) {
  const { color, initial } = ROLE_STYLE[role];
  return (
    <span
      aria-hidden="true"
      className={`inline-flex flex-none items-center justify-center rounded-full font-extrabold ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.34),
        color,
        border: `2px solid ${color}`,
        background: active ? roleTint(role, 0.22) : "rgb(10 9 24 / 0.85)",
        boxShadow: active ? `0 0 0 3px ${color}, 0 0 36px ${roleTint(role, 0.7)}` : `0 0 16px ${roleTint(role, 0.4)}`,
      }}
    >
      {initial}
    </span>
  );
}

export function KindBadge({ kind }: { kind: InfoKind }) {
  const tone = kind === "document" ? "green" : kind === "unknown" ? "red" : kind === "assumption" || kind === "goal" ? "amber" : "slate";
  return <Badge tone={tone}>{INFO_KIND_LABELS[kind]}</Badge>;
}

export function claimText(plan: PlanContent | undefined, claimId: string): string {
  for (const s of plan?.sections ?? []) {
    const c = s.claims.find((x) => x.claim_id === claimId);
    if (c) return c.text;
  }
  return "(이전 버전의 항목)";
}

// 기획 뼈대 보기: 섹션별 항목과 정보 종류, 사실(숫자) 표
export function PlanView({ plan }: { plan: PlanContent }) {
  return (
    <div className="space-y-3 text-sm">
      <p>
        <span className="font-semibold">핵심 메시지</span> {plan.core_message}
      </p>
      <p>
        <span className="font-semibold">요청 결정</span> {plan.requested_decision}
      </p>
      {plan.sections.map((s) => (
        <div key={s.section_id}>
          <h4 className="font-semibold text-ink">{s.title}</h4>
          {s.claims.length === 0 && <p className="text-faint">(내용 없음)</p>}
          <ul className="mt-1 space-y-1">
            {s.claims.map((c) => (
              <li key={c.claim_id} className="flex flex-wrap items-start gap-1.5">
                <span className="font-mono text-xs text-faint">{c.claim_id}</span>
                <KindBadge kind={c.kind} />
                <span className="min-w-0 flex-1">
                  {c.text}
                  {[...c.source_refs, ...c.fact_refs].length > 0 && <span className="ml-1 font-mono text-xs text-faint">[{[...c.source_refs, ...c.fact_refs].join(", ")}]</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {plan.facts.length > 0 && (
        <div className="overflow-x-auto">
          <h4 className="font-semibold text-ink">사실·숫자</h4>
          <table className="mt-1 w-full min-w-[420px] text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-2">ID</th>
                <th className="py-1 pr-2">항목</th>
                <th className="py-1 pr-2">값</th>
                <th className="py-1 pr-2">종류</th>
                <th className="py-1">비고</th>
              </tr>
            </thead>
            <tbody>
              {plan.facts.map((f) => (
                <tr key={f.fact_id} className="border-t border-line-soft">
                  <td className="py-1 pr-2 font-mono text-faint">{f.fact_id}</td>
                  <td className="py-1 pr-2">{f.label}</td>
                  <td className="py-1 pr-2 font-medium">
                    {f.value}
                    {f.value !== "미정" && f.unit}
                  </td>
                  <td className="py-1 pr-2">
                    <KindBadge kind={f.kind} />
                  </td>
                  <td className="py-1 text-muted">{f.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
