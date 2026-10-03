"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AUDIENCE_LABELS, DECISION_TYPE_LABELS, END_REASON_LABELS, ISSUE_STATE_LABELS, OUTCOME_LABELS, ROLE_LABELS, SEVERITY_LABELS } from "@/core/constants";
import { scopeNotes } from "@/core/outputs";
import type { DebateLogContent, DecisionStatus, OutputRecord, PlanDocContent, QaContent, StorylineContent } from "@/core/types";
import { apiGet, kst } from "@/lib/client";
import { Badge, Button, ErrorNote } from "./ui";

interface OutputData {
  title: string;
  record: OutputRecord;
  snapshot: { output_snapshot_id: string; decision_status: DecisionStatus; created_at: string };
  artifacts: { plan_doc: PlanDocContent; storyline: StorylineContent; qa: QaContent; debate_log: DebateLogContent };
}

const TABS = [
  ["all", "전체"],
  ["plan_doc", "상세 기획서"],
  ["storyline", "PPT 스토리라인"],
  ["qa", "예상 질의응답"],
  ["debate_log", "논쟁 기록"],
] as const;
type Tab = (typeof TABS)[number][0];

const th = "border border-slate-300 bg-slate-100 px-2 py-1 text-left align-top text-xs font-semibold";
const td = "border border-slate-300 px-2 py-1 align-top text-sm";

export function OutputView({ projectId, snapshotId }: { projectId: string; snapshotId: string }) {
  const [data, setData] = useState<OutputData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");

  useEffect(() => {
    void apiGet<OutputData>(`/api/projects/${projectId}/outputs/${snapshotId}`).then((res) => {
      if (res.ok && res.data) setData(res.data);
      else setError(res.error?.message ?? "산출물을 불러오지 못했습니다.");
    });
  }, [projectId, snapshotId]);

  if (!data) return <main className="mx-auto max-w-5xl p-4">{error ? <ErrorNote message={error} /> : <p className="text-sm text-slate-500">불러오는 중…</p>}</main>;

  const { record, artifacts } = data;
  const ds = data.snapshot.decision_status;
  const notes = scopeNotes(ds);
  const show = (t: Tab) => tab === "all" || tab === t;

  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-4">
      <div className="no-print flex flex-wrap items-center gap-2">
        <Link href={`/projects/${projectId}`} className="text-sm text-indigo-700 hover:underline">
          ← 작업실
        </Link>
        <div className="flex flex-wrap gap-1" role="tablist">
          {TABS.map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`rounded px-2 py-1 text-sm ${tab === key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-200"}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={() => window.print()}>
            인쇄 · PDF 저장
          </Button>
          <a href={`/api/projects/${projectId}/outputs/${snapshotId}?format=md`} className="inline-flex min-h-9 items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50">
            Markdown 내려받기
          </a>
        </div>
      </div>

      <header className="rounded-lg border border-slate-200 bg-white p-4">
        <h1 className="text-xl font-bold text-slate-900">{data.title}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-slate-600">
          <Badge tone="indigo">확정 기획 v{record.plan_version_no}</Badge>
          <Badge>{AUDIENCE_LABELS[record.audience]}용</Badge>
          <Badge tone={ds.outcome === "RESOLVED_CORE" ? "green" : ds.outcome === "CONDITIONAL" ? "amber" : "red"}>{OUTCOME_LABELS[ds.outcome]}</Badge>
          <Badge>{END_REASON_LABELS[ds.end_reason]}</Badge>
          <span className="text-xs">
            생성 {kst(record.created_at)} · 네 산출물 모두 스냅샷 <span className="font-mono">{record.output_snapshot_id.slice(0, 8)}</span> 기준
          </span>
        </p>
        <p className="mt-2 text-sm text-slate-800">
          <span className="font-semibold">요청 결정({DECISION_TYPE_LABELS[ds.decision_type]})</span> {ds.decision_text}
        </p>
        <p className="mt-1 text-sm text-slate-700">{ds.outcome_rationale}</p>
        {ds.conditions.length > 0 && <p className="mt-1 text-sm text-slate-700">결정 전 확인 조건: {ds.conditions.join(" / ")}</p>}
        {ds.stop_switch_criteria.length > 0 && <p className="mt-1 text-sm text-slate-700">중단·전환 기준: {ds.stop_switch_criteria.join(" / ")}</p>}
        <p className="mt-2 text-xs text-slate-500">토론을 마쳤다는 것은 추진 승인이나 사실 검증 완료를 뜻하지 않습니다.</p>
        {notes.length > 0 && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-semibold">검토 범위와 한계</p>
            <ul className="ml-4 list-disc">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        )}
        {(record.validation.errors.length > 0 || record.validation.warnings.length > 0) && (
          <div className={`mt-3 rounded-md border p-3 text-sm ${record.validation.errors.length ? "border-red-200 bg-red-50 text-red-900" : "border-slate-200 bg-slate-50 text-slate-700"}`}>
            <p className="font-semibold">산출물 검사 결과 (구조 검사이며 내용의 사실 여부를 보증하지 않습니다)</p>
            <ul className="ml-4 list-disc">
              {record.validation.errors.map((e) => (
                <li key={e}>오류: {e}</li>
              ))}
              {record.validation.warnings.map((w) => (
                <li key={w}>확인 필요: {w}</li>
              ))}
            </ul>
          </div>
        )}
      </header>

      {show("plan_doc") && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-bold">1. 상세 기획서</h2>
          {artifacts.plan_doc.sections.map((s) => (
            <div key={s.key} className="mt-3">
              <h3 className="font-semibold text-slate-900">{s.title}</h3>
              {s.paragraphs.map((p, i) => (
                <p key={i} className="mt-1 whitespace-pre-wrap text-sm text-slate-800">
                  {p}
                </p>
              ))}
              {s.bullets.length > 0 && (
                <ul className="ml-5 mt-1 list-disc text-sm text-slate-800">
                  {s.bullets.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              )}
              {[...s.issue_refs, ...s.fact_refs, ...s.source_refs].length > 0 && <p className="mt-1 font-mono text-xs text-slate-400">참조: {[...s.issue_refs, ...s.fact_refs, ...s.source_refs].join(", ")}</p>}
            </div>
          ))}
        </section>
      )}

      {show("storyline") && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-bold">2. PPT 스토리라인 ({AUDIENCE_LABELS[artifacts.storyline.audience]}용)</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr>
                  <th className={th}>장표</th>
                  <th className={th}>헤드라인</th>
                  <th className={th}>핵심 내용</th>
                  <th className={th}>시각화 제안</th>
                  <th className={th}>관련 쟁점</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.storyline.slides.map((s) => (
                  <tr key={s.slide_id}>
                    <td className={`${td} whitespace-nowrap font-mono`}>
                      {s.slide_id}
                      {s.appendix && " 부록"}
                    </td>
                    <td className={`${td} font-medium`}>{s.headline}</td>
                    <td className={td}>
                      <ul className="ml-4 list-disc">
                        {s.key_points.map((k, i) => (
                          <li key={i}>{k}</li>
                        ))}
                      </ul>
                    </td>
                    <td className={td}>{s.visual}</td>
                    <td className={`${td} font-mono text-xs`}>{s.issue_refs.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="mt-4 font-semibold">헤드라인 테스트 (헤드라인만 이어 읽기)</h3>
          <ol className="ml-5 mt-1 list-decimal text-sm text-slate-800">
            {artifacts.storyline.slides
              .filter((s) => !s.appendix)
              .map((s) => (
                <li key={s.slide_id}>{s.headline}</li>
              ))}
          </ol>
          <h3 className="mt-4 font-semibold">임원용 1분 요약</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{artifacts.storyline.one_minute_summary}</p>
        </section>
      )}

      {show("qa") && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-bold">3. 예상 질의응답</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr>
                  <th className={th}>질문</th>
                  <th className={th}>예상 질문자</th>
                  <th className={th}>30초 답변</th>
                  <th className={th}>근거</th>
                  <th className={th}>장표</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.qa.items.map((q, i) => (
                  <tr key={i}>
                    <td className={`${td} font-medium`}>{q.question}</td>
                    <td className={`${td} whitespace-nowrap`}>{q.asker_role}</td>
                    <td className={td}>{q.answer_30s}</td>
                    <td className={`${td} font-mono text-xs`}>{q.evidence_refs.join(", ")}</td>
                    <td className={`${td} font-mono text-xs`}>{q.slide_ids.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {show("debate_log") && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-bold">4. 논쟁 기록</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse">
              <thead>
                <tr>
                  <th className={th}>ID</th>
                  <th className={th}>쟁점</th>
                  <th className={th}>역할</th>
                  <th className={th}>심각도</th>
                  <th className={th}>사용자 대응</th>
                  <th className={th}>상태</th>
                  <th className={th}>판정 근거</th>
                  <th className={th}>반영 위치 / 미반영 이유</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.debate_log.rows.map((r) => (
                  <tr key={r.display_id}>
                    <td className={`${td} whitespace-nowrap font-mono`}>{r.display_id}</td>
                    <td className={td}>{r.issue}</td>
                    <td className={`${td} whitespace-nowrap`}>{ROLE_LABELS[r.role]}</td>
                    <td className={`${td} whitespace-nowrap`}>{SEVERITY_LABELS[r.severity]}</td>
                    <td className={td}>{r.user_response}</td>
                    <td className={`${td} whitespace-nowrap`}>
                      {ISSUE_STATE_LABELS[r.state]}
                      {r.representative && ` → ${r.representative}`}
                    </td>
                    <td className={td}>{r.judgment_basis}</td>
                    <td className={td}>{r.reflected_in.length ? r.reflected_in.join(", ") : r.not_reflected_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
