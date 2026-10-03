"use client";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, kst, type StatusView } from "@/lib/client";
import { StatusBar } from "./StatusBar";
import { Badge, Button, Card, ErrorNote, inputClass } from "./ui";

export function SettingsView() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ connection_string: string; expires_at: string; bypass_included: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await apiGet<StatusView>("/api/settings");
    if (res.ok && res.data) setStatus(res.data);
    else setError(res.error?.message ?? "설정을 불러오지 못했습니다.");
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10000);
    return () => clearInterval(id);
  }, [load]);

  async function op(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await apiPost<StatusView>("/api/settings", body);
    setBusy(false);
    if (res.ok && res.data) setStatus(res.data);
    else setError(res.error?.message ?? "저장하지 못했습니다.");
  }

  async function createPairing() {
    setBusy(true);
    setError(null);
    const res = await apiPost<{ connection_string: string; expires_at: string; bypass_included: boolean }>("/api/settings", { op: "create_pairing" });
    setBusy(false);
    if (res.ok && res.data) {
      setPairing(res.data);
      setCopied(false);
    } else setError(res.error?.message ?? "연결 문자열을 만들지 못했습니다.");
  }

  const models = status?.runner?.status?.models ?? [];

  return (
    <>
      <StatusBar status={status} title="설정" back />
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <ErrorNote message={error} />

        <Card title="1. 실행기 연결 (내 PC)">
          <p className="text-sm text-slate-700">
            AI 호출은 이 웹앱이 아니라 내 PC의 실행기가 ChatGPT 플랜으로 수행합니다. ChatGPT 토큰은 PC 밖으로 나가지 않으며, 이 화면에도 저장되지 않습니다.
          </p>
          <ol className="ml-5 mt-2 list-decimal space-y-1 text-sm text-slate-700">
            <li>
              아래 버튼으로 연결 문자열을 발급합니다. 안에 든 연결 코드는 10분 동안 1회만 유효하지만, 배포 보호를 통과하는 값도 함께 들어 있습니다. 채팅·문서·메신저에 남기지 마세요.
            </li>
            <li>
              PC의 프로젝트 폴더에서 <code className="rounded bg-slate-100 px-1">npm run runner -- pair</code> 를 실행하고, 물어볼 때 연결 문자열을 붙여넣습니다. 채팅이나 문서에는 붙이지 마세요.
            </li>
            <li>
              <code className="rounded bg-slate-100 px-1">npm run runner -- login</code> 으로 ChatGPT에 로그인하고 플랜 사용을 승인합니다.
            </li>
            <li>
              <code className="rounded bg-slate-100 px-1">npm run runner -- start</code> 로 실행기를 켭니다. 켜 둔 동안에만 AI 작업이 진행됩니다.
            </li>
          </ol>
          <Button className="mt-3" disabled={busy} onClick={createPairing}>
            연결 문자열 발급
          </Button>
          {pairing && (
            <div className="mt-3 space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-900">
                지금만 표시됩니다 · {kst(pairing.expires_at)}까지 유효{pairing.bypass_included ? " · Vercel 보호 우회 값 포함" : " · 로컬 개발용(보호 우회 값 없음)"}
              </p>
              <textarea className={`${inputClass} font-mono text-xs`} rows={4} readOnly value={pairing.connection_string} aria-label="실행기 연결 문자열" onFocus={(e) => e.currentTarget.select()} />
              <p className="text-xs text-amber-900">
                이 문자열이 새어 나갔다고 생각되면 Vercel 프로젝트 설정(Deployment Protection → Protection Bypass for Automation)에서 값을 교체하고 다시 배포한 뒤, 아래에서 실행기를 해제하고 새로 연결하세요. 우회 값만으로는 프로젝트를 읽거나 바꿀 수 없고 실행기 전용 경로만 통과합니다.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(pairing.connection_string);
                    setCopied(true);
                  }}
                >
                  {copied ? "복사됨" : "복사"}
                </Button>
                <Button variant="ghost" onClick={() => setPairing(null)}>
                  닫기
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card title="2. 등록된 실행기">
          {status?.runners.length === 0 && <p className="text-sm text-slate-500">등록된 실행기가 없습니다.</p>}
          <ul className="space-y-2">
            {status?.runners.map((r) => (
              <li key={r.runner_id} className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{r.label}</span>
                  <Badge tone={r.online ? "green" : "slate"}>{r.online ? "켜짐" : "꺼짐"}</Badge>
                  {r.status?.mode === "mock" && <Badge tone="purple">모의 모드</Badge>}
                  {r.status?.mode === "chatgpt" && <Badge tone={r.status.signed_in ? "green" : "amber"}>{r.status.signed_in ? "ChatGPT 로그인됨" : "로그인 필요"}</Badge>}
                  {r.status?.mode === "chatgpt" && r.status.signed_in && <Badge tone={r.status.plan_usage_enabled ? "green" : "amber"}>{r.status.plan_usage_enabled ? "플랜 사용 가능" : "플랜 사용 비활성"}</Badge>}
                  {r.status && r.status.mode === "chatgpt" && <Badge>구조화 출력: {{ unknown: "미확인", supported: "지원", unsupported: "미지원(텍스트 JSON으로 대체)" }[r.status.structured_output]}</Badge>}
                  <span className="text-xs text-slate-500">마지막 연결 {kst(r.last_seen_at)}</span>
                  <Button className="ml-auto" variant="danger" disabled={busy} onClick={() => op({ op: "revoke_runner", runner_id: r.runner_id })}>
                    해제
                  </Button>
                </div>
                {r.status?.account_label && <p className="mt-1 text-xs text-slate-500">계정: {r.status.account_label}</p>}
                {r.status?.message && <p className="mt-1 text-xs text-amber-800">{r.status.message}</p>}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="3. 모델과 사용량">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">사용할 모델 (실행기가 내 계정에서 조회한 목록)</span>
            <select className={inputClass} value={status?.model_slug ?? ""} disabled={busy} onChange={(e) => op({ op: "set_model", model_slug: e.target.value || null })}>
              <option value="">자동 (목록의 첫 모델)</option>
              {models.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.display_name} ({m.slug})
                </option>
              ))}
              {status?.model_slug && !models.some((m) => m.slug === status.model_slug) && <option value={status.model_slug}>{status.model_slug} (현재 목록에 없음)</option>}
            </select>
          </label>
          {models.length === 0 && <p className="mt-1 text-xs text-slate-500">실행기가 ChatGPT에 로그인하면 모델 목록이 표시됩니다. 모델 이름은 코드에 고정하지 않습니다.</p>}
          <p className="mt-3 text-sm text-slate-700">
            앱 내부 호출 상한: 하루 {status?.usage.caps.perDay}회(오늘 {status?.usage.today}회 사용), 프로젝트당 {status?.usage.caps.perProject}회. Vercel 환경변수 <code className="rounded bg-slate-100 px-1">AI_CAP_PER_DAY</code>, <code className="rounded bg-slate-100 px-1">AI_CAP_PER_PROJECT</code>로 바꿉니다. 이 값은 과금 사고를 막는 안전장치이며 ChatGPT가 보장하는 한도가 아닙니다.
          </p>
          {status?.paused && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              <p>AI 요청이 멈춰 있습니다: {status.paused.reason}</p>
              <Button className="mt-2" variant="secondary" disabled={busy} onClick={() => op({ op: "resume_ai" })}>
                확인했고 다시 진행합니다
              </Button>
            </div>
          )}
        </Card>

        <Card title="4. 추가 과금을 막기 위한 확인 (직접 확인해 주세요)">
          <ul className="ml-5 list-disc space-y-1 text-sm text-slate-700">
            <li>ChatGPT → Settings → Usage에서 &apos;포함 사용량 소진 후 크레딧 사용&apos;과 &apos;자동 크레딧 구매&apos;가 꺼져 있는지 확인합니다.</li>
            <li>이 앱에는 유료 API로 대신 호출하거나 다른 공급자로 자동 전환하는 코드가 없습니다. 한도에 닿으면 멈춥니다.</li>
            <li>Plus 플랜의 사용 한도는 ChatGPT를 포함해 이 플랜을 쓰는 모든 앱이 함께 씁니다.</li>
            <li>앱 연결을 끊으려면 PC에서 <code className="rounded bg-slate-100 px-1">npm run runner -- logout</code> 을 실행하거나 ChatGPT 설정에서 앱 연결을 해제합니다.</li>
          </ul>
        </Card>
      </main>
    </>
  );
}
