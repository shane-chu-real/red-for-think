import { runnerPost } from "@/server/http";
import { heartbeat } from "@/server/runnerAuth";
import { getSetting } from "@/server/settings";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return runnerPost(req, async (db, runner, body) => {
    await heartbeat(db, runner.runner_id, body.status);
    const paused = await getSetting<{ paused: boolean; reason: string }>(db, "ai_paused");
    return { runner_id: runner.runner_id, model_slug: await getSetting<string>(db, "model_slug"), paused: paused?.paused ? paused.reason : null };
  });
}
