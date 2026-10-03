import { NextResponse } from "next/server";
import { renderMarkdown } from "@/core/outputs";
import type { DebateLogContent, DecisionStatus, PlanDocContent, QaContent, StorylineContent } from "@/core/types";
import { getDb } from "@/server/db";
import { error, respond, viaBypass } from "@/server/http";
import { getOutput, toEnvelopeError } from "@/server/service";

export const dynamic = "force-dynamic";

// 고정된 산출 스냅샷을 JSON 또는 Markdown으로 내보낸다. 같은 스냅샷으로 몇 번이든 다시 내보낼 수 있다.
export async function GET(req: Request, ctx: { params: Promise<{ id: string; snapshotId: string }> }) {
  const { id, snapshotId } = await ctx.params;
  if (viaBypass(req)) return error("BYPASS_NOT_ALLOWED", "이 경로는 로그인한 브라우저에서만 쓸 수 있습니다.");
  try {
    const out = await getOutput(await getDb(), id, snapshotId);
    if (!out || !out.record) return error("NOT_FOUND", "산출물을 찾을 수 없습니다.");
    if (new URL(req.url).searchParams.get("format") !== "md") return respond({ ok: true, data: out });
    const a = out.artifacts as Record<string, unknown>;
    const md = renderMarkdown({
      title: out.title,
      record: out.record,
      decisionStatus: out.snapshot.decision_status as DecisionStatus,
      planDoc: a.plan_doc as PlanDocContent,
      storyline: a.storyline as StorylineContent,
      qa: a.qa as QaContent,
      debate: a.debate_log as DebateLogContent,
    });
    const filename = encodeURIComponent(`${out.title}-v${out.record.plan_version_no}-${snapshotId.slice(0, 8)}.md`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return new NextResponse(md, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${filename}`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return respond(toEnvelopeError(e));
  }
}
