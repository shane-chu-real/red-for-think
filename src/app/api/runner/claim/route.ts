import { runnerPost } from "@/server/http";
import { claimRun } from "@/server/runs";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return runnerPost(req, (db, runner) => claimRun(db, runner.runner_id));
}
