// 실제 Postgres(Neon)에서의 저장·잠금 동작 시험. 임시 스키마를 만들어 그 안에서만 돌리고 끝나면 지운다.
// 실행: RFT_PG_TEST=1 npx vitest run tests/postgres.integration.test.ts  (.env.local의 DATABASE_URL_UNPOOLED 사용)
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDb, migrate, type Db } from "@/server/db";
import { claimRun } from "@/server/runs";
import { dispatch, getOutput, getProject } from "@/server/service";
import { makeHarness } from "./harness";

function directUrl(): string | null {
  if (process.env.RFT_PG_TEST !== "1") return null;
  if (process.env.DATABASE_URL_UNPOOLED) return process.env.DATABASE_URL_UNPOOLED;
  if (!fs.existsSync(".env.local")) return null;
  const m = fs.readFileSync(".env.local", "utf8").match(/^DATABASE_URL_UNPOOLED\s*=\s*"?([^"\r\n]+)"?/m);
  return m ? m[1] : null;
}

const url = directUrl();
const schema = `rft_test_${randomBytes(4).toString("hex")}`;
type PgDb = Db & { close: () => Promise<void> };

describe.skipIf(!url)("실제 Postgres (임시 스키마)", { timeout: 900_000 }, () => {
  let admin: PgDb;
  let db: PgDb;

  beforeAll(async () => {
    admin = await createPgDb(url!, { max: 1 });
    await admin.query(`create schema ${schema}`);
    db = await createPgDb(url!, { searchPath: schema, max: 6 });
    await migrate(db);
  }, 300_000);

  afterAll(async () => {
    await db?.close();
    await admin?.query(`drop schema if exists ${schema} cascade`);
    await admin?.close();
  }, 120_000);

  it("시험용 테이블은 임시 스키마 안에만 만들어진다", async () => {
    const rows = (await admin.query("select table_schema from information_schema.tables where table_name = 'projects' and table_schema = $1", [schema])).rows;
    expect(rows.length).toBe(1);
    const current = (await db.query("select current_schema() as s")).rows[0];
    expect(current.s).toBe(schema);
  });

  it("아이디어 입력부터 산출물 4종까지 이어진다", async () => {
    const h = await makeHarness(db);
    const id = await h.toReply();
    let s = await h.state(id);
    expect(s.phase).toBe("WAITING_REPLY");
    await h.ok(id, "RESPOND_ISSUES", { responses: s.issues.map((i) => ({ issue_id: i.issue_id, response_type: "accept", text: "" })) });
    await h.ok(id, "PROCEED");
    await h.drain();
    s = await h.state(id);
    await h.ok(id, "CONFIRM_REVISION", { revision_id: s.revision!.revision_id });
    await h.drain();
    await h.ok(id, "FINISH", { via_command: false });
    await h.drain();
    s = await h.state(id);
    expect(s.phase).toBe("OUTPUT_READY");
    expect(s.outputs[0].validation.errors).toEqual([]);
    const out = await getOutput(db, id, s.outputs[0].output_snapshot_id);
    expect(Object.keys(out!.artifacts).sort()).toEqual(["debate_log", "plan_doc", "qa", "storyline"]);
    // 스냅샷·이벤트가 버전마다 빠짐없이 남았다
    const row = (await db.query("select state_version from projects where project_id = $1", [id])).rows[0];
    const snaps = (await db.query("select count(*)::int as n from state_snapshots where project_id = $1", [id])).rows[0];
    const events = (await db.query("select count(*)::int as n from events where project_id = $1", [id])).rows[0];
    expect(snaps.n).toBe(row.state_version);
    expect(events.n).toBe(row.state_version);
  });

  it("동시에 들어온 같은 요청은 한 번만 반영되고 둘 다 같은 결과를 받는다", async () => {
    const h = await makeHarness(db);
    const id = await h.toReply();
    const before = (await getProject(db, id))!.state_version;
    const req = { project_id: id, action: "RESPOND_ISSUES", expected_state_version: before, request_key: randomUUID(), payload: { responses: [{ issue_id: "I-001", response_type: "accept", text: "" }] } };
    const results = await Promise.all([dispatch(db, req), dispatch(db, req), dispatch(db, req)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.duplicate).length).toBe(2);
    const after = (await getProject(db, id))!;
    expect(after.state_version).toBe(before + 1);
    expect(after.state.decisions.length).toBe(1);
  });

  it("서로 다른 요청이 동시에 오면 하나만 반영되고 나머지는 버전 충돌을 받는다", async () => {
    const h = await makeHarness(db);
    const id = await h.toReply();
    const before = (await getProject(db, id))!.state_version;
    const mk = (issue: string) => ({ project_id: id, action: "RESPOND_ISSUES", expected_state_version: before, request_key: randomUUID(), payload: { responses: [{ issue_id: issue, response_type: "hold", text: "" }] } });
    const results = await Promise.all([dispatch(db, mk("I-001")), dispatch(db, mk("I-002")), dispatch(db, mk("I-003"))]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => r.error?.code === "VERSION_CONFLICT").length).toBe(2);
    expect((await getProject(db, id))!.state_version).toBe(before + 1);
  });

  it("동시에 여러 번 가져가도 같은 작업을 두 번 넘기지 않는다", async () => {
    const h = await makeHarness(db);
    await h.toReview(); // 검토 5건이 대기 중
    const claims = await Promise.all([1, 2, 3, 4, 5, 6].map(() => claimRun(db, h.runnerId)));
    const ids = claims.flatMap((c) => (c.status === "claimed" ? [c.job.run_id] : []));
    expect(ids.length).toBe(5);
    expect(new Set(ids).size).toBe(5);
  });

  it("불변 테이블은 수정·삭제를 거부한다", async () => {
    const h = await makeHarness(db);
    const id = await h.toReview();
    await expect(db.query("update plan_versions set change_summary = 'x' where project_id = $1", [id])).rejects.toThrow(/immutable/);
    await expect(db.query("delete from events where project_id = $1", [id])).rejects.toThrow(/immutable/);
  });
});
