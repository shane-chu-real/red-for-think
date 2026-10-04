// DB 스키마 적용: DATABASE_URL이 가리키는 Postgres(Neon)에 마이그레이션을 실행한다.
// 사용: npm run db:migrate  (값은 `vercel env pull .env.local`로 받은 파일에서 읽는다)
import fs from "node:fs";
import { createPgDb, migrate } from "../src/server/db";

export function loadEnvFile(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

async function main() {
  loadEnvFile(".env.local");
  // 스키마 변경은 풀을 거치지 않는 직접 연결을 우선 쓴다.
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL이 없습니다. 먼저 `vercel env pull .env.local`을 실행해 주세요.");
  const db = await createPgDb(url, { max: 1 });
  try {
    const applied = await migrate(db);
    const host = new URL(url).host;
    console.log(applied.length ? `적용한 마이그레이션: ${applied.join(", ")} (${host})` : `이미 최신 상태입니다 (${host})`);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(`마이그레이션 실패: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
