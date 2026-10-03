import { browserGet, browserPost, origin } from "@/server/http";
import { createPairing, revokeRunner } from "@/server/runnerAuth";
import { setSetting } from "@/server/settings";
import { getStatus } from "@/server/status";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return browserGet(req, async (db) => ({ ok: true, data: await getStatus(db) }));
}

export async function POST(req: Request) {
  return browserPost(req, async (db, body) => {
    switch (body.op) {
      case "create_pairing":
        // 연결 문자열은 이 응답에서 한 번만 내려 준다.
        return { ok: true, data: await createPairing(db, origin(req)) };
      case "revoke_runner":
        await revokeRunner(db, String(body.runner_id ?? ""));
        return { ok: true, data: await getStatus(db) };
      case "set_model":
        await setSetting(db, "model_slug", body.model_slug ? String(body.model_slug).slice(0, 100) : null);
        return { ok: true, data: await getStatus(db) };
      case "resume_ai":
        await setSetting(db, "ai_paused", { paused: false, reason: "", at: new Date().toISOString() });
        return { ok: true, data: await getStatus(db) };
      default:
        return { ok: false, error: { code: "INVALID_INPUT", message: "알 수 없는 설정 동작입니다.", retryable: false } };
    }
  });
}
