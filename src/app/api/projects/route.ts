import { browserGet, browserPost } from "@/server/http";
import { dispatch, listProjects } from "@/server/service";
import { getStatus } from "@/server/status";

export const dynamic = "force-dynamic";

export async function GET() {
  return browserGet(async (db) => ({ ok: true, data: { projects: await listProjects(db), status: await getStatus(db) } }));
}

export async function POST(req: Request) {
  return browserPost(req, (db, body) => dispatch(db, { action: "CREATE_PROJECT", request_key: String(body.request_key ?? ""), payload: body.payload }));
}
