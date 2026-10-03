import { getDb } from "@/server/db";
import { error, readJson, respond } from "@/server/http";
import { pairRunner } from "@/server/runnerAuth";
import { toEnvelopeError } from "@/server/service";

export const dynamic = "force-dynamic";

// 1회용 연결 코드를 실행기 토큰으로 바꾼다. 토큰은 이 응답에서만 내려 주고 DB에는 해시만 남는다.
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const paired = await pairRunner(await getDb(), { code: String(body.code ?? ""), label: String(body.label ?? ""), host_id: body.host_id ? String(body.host_id) : null });
    if (!paired) return error("PAIRING_INVALID", "연결 코드가 잘못되었거나 이미 사용되었거나 만료되었습니다. 설정 화면에서 새로 발급해 주세요.");
    return respond({ ok: true, data: paired });
  } catch (e) {
    return respond(toEnvelopeError(e));
  }
}
