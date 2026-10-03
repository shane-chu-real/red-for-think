"use client";
import Link from "next/link";
import type { StatusView } from "@/lib/client";
import { Badge } from "./ui";

const BADGE: Record<StatusView["badge"], { tone: "slate" | "red" | "amber" | "green" | "purple"; text: string }> = {
  none: { tone: "slate", text: "실행기 미연결 — 설정에서 연결해 주세요" },
  offline: { tone: "amber", text: "실행기 꺼짐 — PC에서 실행기를 켜 주세요" },
  online: { tone: "green", text: "실행기 연결됨 · ChatGPT 플랜" },
  mock: { tone: "purple", text: "모의 모드" },
  login_required: { tone: "amber", text: "실행기 로그인 필요 (runner login)" },
  plan_disabled: { tone: "amber", text: "로그인됨 / AI 플랜 사용 비활성" },
  paused: { tone: "red", text: "AI 일시정지" },
};

// 화면 공통 상단: 실행기 상태, 모의 모드 배너, 외부 AI 전송 안내
export function StatusBar({ status, title, back }: { status: StatusView | null; title: string; back?: boolean }) {
  const b = status ? BADGE[status.badge] : null;
  return (
    <header className="no-print border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex items-center gap-3">
          {back && (
            <Link href="/" className="text-sm text-indigo-700 hover:underline">
              ← 목록
            </Link>
          )}
          <h1 className="text-lg font-bold text-slate-900">{title}</h1>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-slate-600">
          {b && <Badge tone={b.tone}>{b.text}</Badge>}
          {status && (
            <span>
              AI 호출 오늘 {status.usage.today}/{status.usage.caps.perDay}
              {status.usage.project !== null && ` · 이 프로젝트 ${status.usage.project}/${status.usage.caps.perProject}`}
            </span>
          )}
          <Link href="/settings" className="text-indigo-700 hover:underline">
            설정
          </Link>
        </div>
      </div>
      {status?.badge === "mock" && (
        <p className="bg-purple-700 px-4 py-1.5 text-center text-sm font-medium text-white">개발용 모의 응답입니다. 실제 AI가 작성한 내용이 아니며, [모의] 표시가 붙습니다.</p>
      )}
      {status?.paused && (
        <p className="bg-red-700 px-4 py-1.5 text-center text-sm font-medium text-white">
          AI 요청을 멈췄습니다: {status.paused.reason} — ChatGPT 설정의 Usage를 확인한 뒤 설정 화면에서 재개해 주세요. 유료 경로로 자동 전환하지 않습니다.
        </p>
      )}
      <p className="bg-slate-100 px-4 py-1 text-center text-xs text-slate-600">입력한 기획 내용과 자료는 AI 작업 때 외부 AI(ChatGPT·OpenAI)로 전송됩니다. 보내면 안 되는 내용은 넣지 마세요.</p>
    </header>
  );
}
