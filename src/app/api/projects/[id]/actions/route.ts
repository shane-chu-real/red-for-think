import { browserPost } from "@/server/http";
import { dispatch } from "@/server/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return browserPost(req, (db, body) =>
    dispatch(db, {
      project_id: id,
      action: String(body.action ?? ""),
      expected_state_version: typeof body.expected_state_version === "number" ? body.expected_state_version : -1,
      request_key: String(body.request_key ?? ""),
      payload: body.payload,
    }),
  );
}
