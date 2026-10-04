// 실제 AI 전체 흐름 시험: 새 프로젝트를 만들어 인터뷰 → 뼈대 → 5역할 검토 → 답변 → 변경안 → 판정 → 네 산출물까지 진행한다.
// 주의: 켜 둔 실행기가 실제 ChatGPT 플랜 요청을 16건 안팎 씁니다(모의 실행기면 사용량 없음).
// 준비: 개발 서버(npm run dev)와 실행기(npm run runner -- start)를 먼저 켭니다. 운영 주소에는 쓸 수 없습니다(화면용 API는 로그인한 브라우저 전용).
// 실행: node scripts/e2e-real.mjs   (주소가 다르면 RFT_BASE=http://localhost:3300)
// 실패하면 자동 재시도하지 않고 멈춘다(사용량 보호). 결과는 .data/e2e/에 저장한다.
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.RFT_BASE ?? "http://localhost:3000";
const OUT = path.resolve(".data/e2e");
fs.mkdirSync(OUT, { recursive: true });
const H = { "content-type": "application/json", Origin: BASE };
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let projectId;
async function get(p) {
  return (await fetch(BASE + p)).json();
}
async function post(p, body) {
  return (await fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(body) })).json();
}
async function view() {
  const r = await get(`/api/projects/${projectId}`);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data;
}
async function act(action, payload = {}) {
  const v = await view();
  const r = await post(`/api/projects/${projectId}/actions`, { action, expected_state_version: v.state_version, request_key: crypto.randomUUID(), payload });
  if (!r.ok) throw new Error(`${action} 실패: ${JSON.stringify(r.error)}`);
  log(`동작 ${action} 저장됨 (v${r.state_version})`);
}
async function waitIdle(label, maxMs = 20 * 60 * 1000) {
  const start = Date.now();
  for (;;) {
    const v = await view();
    const failed = v.state.pending_runs.filter((r) => r.status === "failed");
    if (failed.length) {
      log("실패한 작업:", JSON.stringify(failed.map((f) => ({ task: f.task, role: f.role, code: f.error_code, msg: f.error_message }))));
      throw new Error(`${label} 단계에서 AI 작업 실패`);
    }
    if (!v.state.pending_runs.some((r) => r.status === "queued")) {
      log(`[${label}] 완료 → 단계 ${v.state.phase} (${Math.round((Date.now() - start) / 1000)}초)`);
      return v;
    }
    if (Date.now() - start > maxMs) throw new Error(`${label} 시간 초과`);
    await sleep(4000);
  }
}
const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function main() {
  const created = await post("/api/projects", {
    request_key: crypto.randomUUID(),
    payload: {
      type: "education",
      audience: "executive",
      idea: "신입사원 대상으로 '나만의 AI 에이전트 만들기' 2일 교육을 기획하고 싶습니다.",
      problem: "",
      requested_decision: "",
      sources: [
        {
          title: "사내 AI 가이드라인 요약(시험용 가상 자료)",
          text: "1. 외부 AI 서비스에 고객 개인정보와 대외비 문서를 입력하지 않는다.\n2. 교육 실습에는 가상 데이터 또는 공개 데이터만 사용한다.\n3. 업무에는 사내 승인 도구 목록에 있는 AI 도구만 사용한다.\n4. 신규 AI 도구 도입은 정보보안팀 검토를 거친다.",
        },
      ],
    },
  });
  if (!created.ok) throw new Error(`프로젝트 생성 실패: ${JSON.stringify(created.error)}`);
  projectId = created.data.project_id;
  log("프로젝트 생성:", projectId);

  let v = await waitIdle("인터뷰 질문");
  log("── 인터뷰 질문 ──");
  for (const q of v.state.intake.questions) log(`  ${q.question_id} ${q.text}  (이유: ${short(q.why, 80)})`);

  if (v.state.phase === "INTAKE") {
    await act("ANSWER_INTAKE", { text: "연 300명, 입문교육 안에 넣고, 입사 3개월 안에 에이전트 1개를 실제로 쓰게 하는 게 목표입니다. 예산은 모름, 임원 보고입니다." });
    v = await waitIdle("인터뷰 2차");
    if (v.state.phase === "INTAKE") {
      log("── 추가 질문 ──");
      for (const q of v.state.intake.questions.filter((x) => x.answer === null)) log(`  ${q.question_id} ${q.text}`);
      await act("REQUEST_OUTLINE");
      v = await waitIdle("뼈대 작성");
    }
  }
  if (v.state.pending_runs.length || !v.state.outline_draft) v = await waitIdle("뼈대 작성");

  const draft = v.state.outline_draft;
  log("── 기획 뼈대 ──");
  log("  핵심 메시지:", draft.content.core_message);
  log("  요청 결정:", draft.content.requested_decision);
  for (const s of draft.content.sections) for (const c of s.claims) log(`  [${s.key}] ${c.claim_id} (${c.kind}) ${short(c.text, 130)} ${[...c.source_refs, ...c.fact_refs].join(",")}`);
  for (const f of draft.content.facts) log(`  사실 ${f.fact_id} ${f.label} = ${f.value}${f.unit} (${f.kind}/${f.area}) ${short(f.note, 60)}`);
  await act("CONFIRM_OUTLINE", { draft_id: draft.draft_id });

  v = await waitIdle("5역할 검토·정리", 30 * 60 * 1000);
  log(`── 쟁점 ${v.state.issues.length}건 ──`);
  for (const i of v.state.issues) {
    log(`  ${i.display_id} [${i.role}/${i.severity}/${i.state}] ${short(i.critique, 150)}`);
    log(`     대상 ${i.target_claim_ids.join(",")} · 근거 ${i.source_refs.join(",") || "-"} · 조건: ${i.resolution_conditions.map((c) => short(c.text, 70)).join(" | ")}`);
  }

  const open = v.state.issues.filter((i) => i.state === "OPEN");
  const pick = (role) => open.find((i) => i.role === role);
  const fin = pick("finance");
  const it = pick("it");
  const risk = pick("risk");
  const lines = [];
  if (fin) lines.push(`${fin.display_id} 수용, 30명 파일럿 후 확대로 바꿔줘.`);
  if (it) lines.push(`${it.display_id} 보류, IT팀에 확인할게.`);
  if (risk) lines.push(`${risk.display_id} 반박, 실습은 가상 데이터만 써.`);
  if (lines.length && v.state.phase === "WAITING_REPLY") {
    log("── 내 답변 ──\n  " + lines.join("\n  "));
    await act("SUBMIT_REPLY", { text: lines.join("\n") });
    v = await waitIdle("답변 해석");
    const m = v.state.pending_mapping;
    log("── 답변 해석 ──");
    for (const x of m.items) log(`  ${x.issue_id} → ${x.response_type}: ${short(x.interpreted_action, 100)} (인용: ${short(x.quote, 50)})`);
    log(`  변경 요청: ${JSON.stringify(m.change_requests)} · 확인 질문: ${JSON.stringify(m.clarifications.map((c) => c.question))} · 미응답: ${m.unanswered_issue_ids.join(",")}`);
    await act("CONFIRM_REPLY_MAPPING", { mapping_id: m.mapping_id });
    await act("PROCEED");
    v = await waitIdle("변경안 또는 판정");
  }

  if (v.state.phase === "REVISION_CONFIRM" && v.state.revision) {
    const r = v.state.revision;
    log("── 변경안 ──", r.change_summary);
    for (const c of r.changes) log(`  ${c.op} ${c.claim_id ?? c.section_key}: ${short(c.text, 140)}`);
    for (const f of r.fact_changes) log(`  사실 ${f.op} ${f.fact_id ?? "(신규)"} ${f.label} = ${f.value}${f.unit}`);
    for (const c of r.cascade_impacts) log(`  연쇄 ${c.area}: ${c.before} → ${c.after} (${short(c.note, 60)})`);
    log(`  반영 못 함: ${JSON.stringify(r.unaddressed)}`);
    await act("CONFIRM_REVISION", { revision_id: r.revision_id });
    v = await waitIdle("해소 판정");
  }

  const showJudgments = (state) => {
    for (const j of state.judgments) {
      const issue = state.issues.find((i) => i.issue_id === j.issue_id);
      log(`  ${issue.display_id}: 제안 ${j.proposed_state} → 적용 ${j.applied_state} · ${short(j.reason, 150)}${j.server_note ? ` · 서버: ${j.server_note}` : ""}`);
      for (const c of j.condition_results) log(`     ${c.condition_id} ${c.result}: ${short(c.reason, 100)}`);
    }
  };
  log("── 판정 ──");
  showJudgments(v.state);

  if (v.state.phase === "WAITING_REPLY") {
    const fu = v.state.issues.filter((i) => i.follow_up && i.follow_up.answer === null);
    for (const i of fu) log(`  추가 질문 ${i.display_id}: ${i.follow_up.question}`);
    if (fu.length) {
      await act("RESPOND_ISSUES", { responses: fu.map((i) => ({ issue_id: i.issue_id, response_type: "rebut", text: "사내 AI 가이드라인 요약을 교육 자료에 넣겠습니다. 실습 범위에서는 가상 데이터만 씁니다." })) });
      await act("PROCEED");
      v = await waitIdle("추가 판정");
      log("── 추가 판정 ──");
      showJudgments({ ...v.state, judgments: v.state.judgments.slice(-fu.length) });
    } else {
      await act("PROCEED");
      v = await waitIdle("라운드 정리");
    }
  }

  log(`── 라운드 정리: 단계 ${v.state.phase}, 미해결 치명 ${v.state.issues.filter((i) => i.severity === "critical" && !["RESOLVED", "WITHDRAWN", "MERGED"].includes(i.state)).map((i) => i.display_id).join(",") || "없음"} ──`);
  for (const i of v.state.issues) log(`  ${i.display_id} [${i.severity}] ${i.state}`);

  await act("FINISH", { via_command: false });
  v = await waitIdle("산출물 생성", 40 * 60 * 1000);
  const rec = v.state.outputs.at(-1);
  log("── 산출물 ──", JSON.stringify({ phase: v.state.phase, end: v.state.end?.reason, outcome: rec?.outcome, errors: rec?.validation.errors, warnings: rec?.validation.warnings }));
  if (rec) {
    const md = await (await fetch(`${BASE}/api/projects/${projectId}/outputs/${rec.output_snapshot_id}?format=md`)).text();
    fs.writeFileSync(path.join(OUT, "e2e-output.md"), md, "utf8");
    log(`Markdown 저장: ${md.length}자`);
  }
  fs.writeFileSync(path.join(OUT, "e2e-state.json"), JSON.stringify(v.state, null, 1), "utf8");
  log("── AI 작업 기록 ──");
  for (const r of [...v.runs].reverse()) {
    const dur = r.finished_at && r.claimed_at ? Math.round((new Date(r.finished_at) - new Date(r.claimed_at)) / 1000) : null;
    log(`  ${r.task}${r.role ? ":" + r.role : ""} ${r.status} ${r.output_mode ?? ""} ${r.model_slug ?? ""} ${dur !== null ? dur + "초" : ""} ${r.error_code ?? ""}`);
  }
  log(`AI 호출 수(이 프로젝트): ${v.status.usage.project} · 오늘 ${v.status.usage.today}`);
  log("완료");
}

main().catch((e) => {
  log("중단:", e.message);
  process.exitCode = 1;
});
