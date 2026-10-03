import { ROLES, ROLE_LABELS, type Role } from "./constants";
import type { ActionName } from "./schemas";

// 채팅창 명령 → 버튼과 같은 동작 (설계서 부록 A.5 '명령과 버튼의 동일 동작')
export type ParsedCommand =
  | { type: Extract<ActionName, "SET_INTENSITY">; payload: { intensity: 1 | 2 | 3 } }
  | { type: Extract<ActionName, "EXTRA_REVIEW">; payload: { role: Role } }
  | { type: Extract<ActionName, "PROCEED">; payload: Record<string, never> }
  | { type: Extract<ActionName, "FINISH">; payload: { via_command: true } }
  | { type: Extract<ActionName, "SET_AUDIENCE">; payload: { audience: "executive" | "department" } };

const ROLE_COMMANDS: Record<string, Role> = {
  재무: "finance",
  리스크: "risk",
  현업: "field",
  "현업·사용자": "field",
  경영진: "executive",
  it: "it",
  IT: "it",
};

export function parseCommand(text: string): ParsedCommand | null {
  const t = text.trim().replace(/\s+/g, "");
  if (!t.startsWith("/")) return null;
  const body = t.slice(1);
  const intensity = body.match(/^강도([123])$/);
  if (intensity) return { type: "SET_INTENSITY", payload: { intensity: Number(intensity[1]) as 1 | 2 | 3 } };
  if (body === "스킵") return { type: "PROCEED", payload: {} };
  if (body === "마무리") return { type: "FINISH", payload: { via_command: true } };
  if (body === "임원용") return { type: "SET_AUDIENCE", payload: { audience: "executive" } };
  if (body === "유관부서용") return { type: "SET_AUDIENCE", payload: { audience: "department" } };
  const role = ROLE_COMMANDS[body] ?? ROLE_COMMANDS[body.toLowerCase()];
  if (role) return { type: "EXTRA_REVIEW", payload: { role } };
  return null;
}

export const COMMAND_HELP = [
  "/강도1 · /강도2 · /강도3 — 이후 검토 깊이",
  `/${ROLES.map((r) => ROLE_LABELS[r].split("·")[0]).join(" · /")} — 해당 역할 추가 검토`,
  "/스킵 — 이번 라운드 응답 수집 종료(미응답·보류는 해소되지 않음)",
  "/마무리 — 현재 확정 버전으로 종료·산출",
  "/임원용 · /유관부서용 — 스토리라인 대상 전환",
];
