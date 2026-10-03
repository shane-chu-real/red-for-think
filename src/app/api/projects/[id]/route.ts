import { browserGet } from "@/server/http";
import { getProject } from "@/server/service";
import { getStatus } from "@/server/status";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return browserGet(async (db) => {
    const project = await getProject(db, id);
    if (!project) return { ok: false, error: { code: "NOT_FOUND", message: "프로젝트를 찾을 수 없습니다.", retryable: false } };
    return { ok: true, state_version: project.state_version, data: { ...project, status: await getStatus(db, id) } };
  });
}
