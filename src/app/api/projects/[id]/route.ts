import { browserGet } from "@/server/http";
import { expireLeases } from "@/server/runs";
import { getProject } from "@/server/service";
import { getStatus } from "@/server/status";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return browserGet(req, async (db) => {
    // 실행기가 작업 도중 꺼진 채 돌아오지 않아도, 화면을 열면 만료된 작업이 실패로 정리되어 다시 시도할 수 있다.
    await expireLeases(db).catch(() => 0);
    const project = await getProject(db, id);
    if (!project) return { ok: false, error: { code: "NOT_FOUND", message: "프로젝트를 찾을 수 없습니다.", retryable: false } };
    return { ok: true, state_version: project.state_version, data: { ...project, status: await getStatus(db, id) } };
  });
}
