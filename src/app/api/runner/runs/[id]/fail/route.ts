import { runnerPost } from "@/server/http";
import { failRun } from "@/server/runs";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return runnerPost(req, (db, runner, body) =>
    failRun(db, runner.runner_id, id, {
      request_key: String(body.request_key ?? ""),
      error_code: String(body.error_code ?? "AI_ERROR"),
      message: String(body.message ?? ""),
      http_status: typeof body.http_status === "number" ? body.http_status : undefined,
      provider_request_id: body.provider_request_id ? String(body.provider_request_id).slice(0, 200) : undefined,
      retryable: Boolean(body.retryable),
    }),
  );
}
