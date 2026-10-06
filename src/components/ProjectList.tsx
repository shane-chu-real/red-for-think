"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AUDIENCES, AUDIENCE_LABELS, LIMITS, PHASE_LABELS, PROJECT_TYPES, PROJECT_TYPE_LABELS, type Audience, type Phase, type ProjectType } from "@/core/constants";
import { apiGet, apiPost, kst, newKey, type StatusView } from "@/lib/client";
import { StatusBar } from "./StatusBar";
import { Badge, Button, Card, ErrorNote, Field, inputClass } from "./ui";

interface ProjectRow {
  project_id: string;
  title: string;
  type: ProjectType;
  phase: Phase;
  round: number;
  unresolved_critical_count: number;
  updated_at: string;
}

export function ProjectList() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ title: "", type: "education" as ProjectType, audience: "executive" as Audience, idea: "", problem: "", requested_decision: "" });
  const [sources, setSources] = useState<{ title: string; text: string }[]>([]);
  // 같은 제출을 다시 눌러도 한 번만 만들어지도록 제출 단위로 키를 유지한다.
  const [requestKey, setRequestKey] = useState(newKey);

  const load = useCallback(async () => {
    const res = await apiGet<{ projects: ProjectRow[]; status: StatusView }>("/api/projects");
    if (res.ok && res.data) {
      setProjects(res.data.projects);
      setStatus(res.data.status);
    } else setError(res.error?.message ?? "목록을 불러오지 못했습니다.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    const res = await apiPost<{ project_id: string }>("/api/projects", {
      request_key: requestKey,
      payload: { ...form, sources: sources.filter((s) => s.title.trim() && s.text.trim()) },
    });
    setBusy(false);
    if (res.ok && res.data) {
      setRequestKey(newKey());
      router.push(`/projects/${res.data.project_id}`);
    } else setError(res.error?.message ?? "프로젝트를 만들지 못했습니다.");
  }

  const total = sources.reduce((a, s) => a + s.text.trim().length, 0);

  return (
    <>
      <StatusBar status={status} title="기획 레드팀" />
      <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <Card title="새 프로젝트" className="min-w-0">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="기획 유형">
                <select className={inputClass} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ProjectType })}>
                  {PROJECT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {PROJECT_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="보고 대상">
                <select className={inputClass} value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as Audience })}>
                  {AUDIENCES.map((a) => (
                    <option key={a} value={a}>
                      {AUDIENCE_LABELS[a]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="아이디어" hint="한 줄에서 한 문단. 이 내용으로 인터뷰 질문이 만들어집니다.">
              <textarea className={inputClass} rows={3} value={form.idea} onChange={(e) => setForm({ ...form, idea: e.target.value })} placeholder="예: 신입사원 대상 '나만의 AI 에이전트 만들기' 2일 교육" />
            </Field>
            <Field label="해결할 문제 (선택)">
              <textarea className={inputClass} rows={2} value={form.problem} onChange={(e) => setForm({ ...form, problem: e.target.value })} />
            </Field>
            <Field label="이번에 받을 결정 (선택)" hint="탐색 승인, 파일럿 범위·예산 승인, 확대 여부 판단 등">
              <input className={inputClass} value={form.requested_decision} onChange={(e) => setForm({ ...form, requested_decision: e.target.value })} />
            </Field>
            <Field label="프로젝트 이름 (선택)">
              <input className={inputClass} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="비우면 아이디어 첫 줄을 씁니다" />
            </Field>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ink">참고 자료 (선택, 텍스트 붙여넣기)</span>
                <Button variant="ghost" onClick={() => setSources([...sources, { title: "", text: "" }])}>
                  + 자료 추가
                </Button>
              </div>
              <p className="text-xs text-muted">
                파일 업로드는 지원하지 않습니다. PDF·Word 등은 내용을 복사해 붙여 주세요. 자료 1건 {LIMITS.sourceMaxChars.toLocaleString()}자, 합계 {LIMITS.sourcesTotalMaxChars.toLocaleString()}자까지이며, 넘으면 자르지 않고 거절합니다.
              </p>
              {sources.map((s, i) => (
                <div key={i} className="space-y-2 rounded-2xl border border-line p-3">
                  <div className="flex gap-2">
                    <input className={inputClass} placeholder="자료 이름" value={s.title} onChange={(e) => setSources(sources.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                    <Button variant="secondary" onClick={() => setSources(sources.filter((_, j) => j !== i))}>
                      삭제
                    </Button>
                  </div>
                  <textarea className={inputClass} rows={4} placeholder="자료 내용을 붙여넣으세요" value={s.text} onChange={(e) => setSources(sources.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                  <p className="text-xs text-muted">{s.text.trim().length.toLocaleString()}자</p>
                </div>
              ))}
              {sources.length > 0 && <p className="text-xs text-muted">합계 {total.toLocaleString()}자</p>}
            </div>

            <ErrorNote message={error} />
            <Button onClick={create} disabled={busy || !form.idea.trim()}>
              {busy ? "저장 중…" : "프로젝트 만들고 인터뷰 시작"}
            </Button>
          </div>
        </Card>

        <Card title="최근 작업" className="min-w-0">
          {projects === null && <p className="text-sm text-muted">불러오는 중…</p>}
          {projects?.length === 0 && <p className="text-sm text-muted">아직 프로젝트가 없습니다.</p>}
          <ul className="divide-y divide-line-soft">
            {projects?.map((p) => (
              <li key={p.project_id} className="flex flex-wrap items-center gap-2 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{p.title}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <Badge>{PROJECT_TYPE_LABELS[p.type]}</Badge>
                    <Badge tone="indigo">
                      {PHASE_LABELS[p.phase]}
                      {p.round > 0 && ` · ${p.round}라운드`}
                    </Badge>
                    {p.unresolved_critical_count > 0 && <Badge tone="red">미해결 치명 {p.unresolved_critical_count}</Badge>}
                    <span>저장 {kst(p.updated_at)}</span>
                  </p>
                </div>
                <Link href={`/projects/${p.project_id}`} className="glass inline-flex min-h-10 items-center rounded-full border border-line bg-surface px-4 py-1.5 text-sm font-medium text-ink hover:bg-surface-2">
                  이어하기
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </main>
    </>
  );
}
