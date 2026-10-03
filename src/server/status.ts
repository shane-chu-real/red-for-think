import type { Db } from "./db";
import { listRunners, type RunnerStatus } from "./runnerAuth";
import { caps, kstDay } from "./runs";
import { getSetting } from "./settings";

// 화면 상단에 보여 줄 실행기·AI 상태
export async function getStatus(db: Db, projectId?: string) {
  const runners = (await listRunners(db)).filter((r) => !r.revoked_at);
  const active = runners.find((r) => r.online) ?? runners[0] ?? null;
  const status = (active?.status ?? null) as RunnerStatus | null;
  const paused = await getSetting<{ paused: boolean; reason: string; at: string }>(db, "ai_paused");
  const model = await getSetting<string>(db, "model_slug");
  const scopes = [`day:${kstDay()}`, ...(projectId ? [`project:${projectId}`] : [])];
  const counts = (await db.query("select scope, count from usage_counters where scope = any($1::text[])", [scopes])).rows;
  const get = (s: string) => counts.find((c) => c.scope === s)?.count ?? 0;
  let badge: "online" | "offline" | "none" | "login_required" | "plan_disabled" | "paused" | "mock" = "none";
  if (active) {
    if (!active.online) badge = "offline";
    else if (paused?.paused) badge = "paused";
    else if (status?.mode === "mock") badge = "mock";
    else if (!status?.signed_in) badge = "login_required";
    else if (!status?.plan_usage_enabled) badge = "plan_disabled";
    else badge = "online";
  }
  return {
    badge,
    runner: active ? { runner_id: active.runner_id, label: active.label, online: active.online, last_seen_at: active.last_seen_at, status } : null,
    runners,
    paused: paused?.paused ? paused : null,
    model_slug: model,
    usage: { today: get(scopes[0]), project: projectId ? get(scopes[1]) : null, caps: caps() },
  };
}
