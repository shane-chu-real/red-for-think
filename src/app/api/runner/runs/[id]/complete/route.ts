import { runnerPost } from "@/server/http";
import { completeRun } from "@/server/runs";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return runnerPost(req, (db, runner, body) =>
    completeRun(db, runner.runner_id, id, {
      request_key: String(body.request_key ?? ""),
      terminal_event: String(body.terminal_event ?? ""),
      text: String(body.text ?? ""),
      output_mode: String(body.output_mode ?? "unknown").slice(0, 30),
      model_slug: body.model_slug ? String(body.model_slug).slice(0, 100) : null,
      provider_request_id: body.provider_request_id ? String(body.provider_request_id).slice(0, 200) : null,
      usage: body.usage ?? null,
    }),
  );
}
