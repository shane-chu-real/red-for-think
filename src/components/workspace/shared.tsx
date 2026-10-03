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
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={severity === "critical" ? "red" : severity === "major" ? "amber" : "slate"}>{SEVERITY_LABELS[severity]}</Badge>;
}

export function StateBadge({ state }: { state: IssueState }) {
  const tone = state === "RESOLVED" ? "green" : state === "WITHDRAWN" || state === "MERGED" ? "slate" : state === "OPEN" ? "red" : "amber";
  return <Badge tone={tone}>{ISSUE_STATE_LABELS[state]}</Badge>;
}

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone="indigo">{ROLE_LABELS[role]}</Badge>;
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
          <h4 className="font-semibold text-slate-900">{s.title}</h4>
          {s.claims.length === 0 && <p className="text-slate-400">(내용 없음)</p>}
          <ul className="mt-1 space-y-1">
            {s.claims.map((c) => (
              <li key={c.claim_id} className="flex flex-wrap items-start gap-1.5">
                <span className="font-mono text-xs text-slate-400">{c.claim_id}</span>
                <KindBadge kind={c.kind} />
                <span className="min-w-0 flex-1">
                  {c.text}
                  {[...c.source_refs, ...c.fact_refs].length > 0 && <span className="ml-1 font-mono text-xs text-slate-400">[{[...c.source_refs, ...c.fact_refs].join(", ")}]</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {plan.facts.length > 0 && (
        <div className="overflow-x-auto">
          <h4 className="font-semibold text-slate-900">사실·숫자</h4>
          <table className="mt-1 w-full min-w-[420px] text-left text-xs">
            <thead className="text-slate-500">
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
                <tr key={f.fact_id} className="border-t border-slate-100">
                  <td className="py-1 pr-2 font-mono text-slate-400">{f.fact_id}</td>
                  <td className="py-1 pr-2">{f.label}</td>
                  <td className="py-1 pr-2 font-medium">
                    {f.value}
                    {f.value !== "미정" && f.unit}
                  </td>
                  <td className="py-1 pr-2">
                    <KindBadge kind={f.kind} />
                  </td>
                  <td className="py-1 text-slate-500">{f.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
