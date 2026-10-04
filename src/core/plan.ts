import { SECTION_KEYS, SECTION_TITLES, type SectionKey } from "./constants";
import type { AiOutput } from "./schemas";
import { pad } from "./state";
import type { Fact, PlanContent, ProjectState, RevisionProposal, Section } from "./types";

// 작성자 뼈대(AI 제안) → ID가 붙은 기획 내용. ID는 서버가 발급한다.
export function buildPlanFromOutline(state: ProjectState, out: AiOutput<"outline">, versionNo: number): PlanContent {
  const factIdByKey = new Map<string, string>();
  const facts: Fact[] = out.facts.map((f) => {
    state.counters.fact += 1;
    const fact_id = `F-${pad(state.counters.fact)}`;
    factIdByKey.set(f.key, fact_id);
    return {
      fact_id,
      label: f.label,
      value: f.value,
      unit: f.unit,
      kind: f.kind,
      area: f.area,
      source_refs: f.source_refs,
      note: f.note,
      updated_in_version: versionNo,
    };
  });

  const sections: Section[] = SECTION_KEYS.map((key, idx) => ({
    section_id: `S${idx + 1}`,
    key,
    title: SECTION_TITLES[key],
    claims: [],
  }));
  for (const s of out.sections) {
    const section = sections.find((x) => x.key === s.key)!;
    for (const c of s.claims) {
      state.counters.claim += 1;
      section.claims.push({
        claim_id: `C-${pad(state.counters.claim)}`,
        text: c.text,
        kind: c.kind,
        source_refs: c.source_refs,
        fact_refs: c.fact_keys.map((k) => factIdByKey.get(k)).filter((x): x is string => Boolean(x)),
        updated_in_version: versionNo,
      });
    }
  }
  return { core_message: out.core_message, requested_decision: out.requested_decision, sections, facts };
}

export function allClaims(plan: PlanContent) {
  return plan.sections.flatMap((s) => s.claims.map((c) => ({ ...c, section_key: s.key as SectionKey })));
}

export function claimIds(plan: PlanContent): string[] {
  return plan.sections.flatMap((s) => s.claims.map((c) => c.claim_id));
}

// 확인된 변경안을 새 기획 버전 내용으로 적용한다 (원본은 바꾸지 않는다).
export function applyRevision(state: ProjectState, base: PlanContent, rev: RevisionProposal, versionNo: number): PlanContent {
  const next: PlanContent = structuredClone(base);
  const changedFacts = new Set<string>();

  for (const fc of rev.fact_changes) {
    if (fc.op === "add") {
      state.counters.fact += 1;
      next.facts.push({
        fact_id: `F-${pad(state.counters.fact)}`,
        label: fc.label,
        value: fc.value,
        unit: fc.unit,
        kind: fc.kind,
        area: fc.area,
        source_refs: fc.source_refs,
        note: fc.note,
        updated_in_version: versionNo,
      });
      continue;
    }
    const idx = next.facts.findIndex((f) => f.fact_id === fc.fact_id);
    if (idx < 0) continue;
    changedFacts.add(next.facts[idx].fact_id);
    if (fc.op === "remove") {
      next.facts.splice(idx, 1);
    } else {
      next.facts[idx] = {
        ...next.facts[idx],
        label: fc.label || next.facts[idx].label,
        value: fc.value,
        unit: fc.unit,
        kind: fc.kind,
        area: fc.area,
        note: fc.note,
        source_refs: fc.source_refs,
        updated_in_version: versionNo,
      };
    }
  }

  for (const ch of rev.changes) {
    if (ch.op === "add") {
      const section = next.sections.find((s) => s.key === ch.section_key);
      if (!section) continue;
      state.counters.claim += 1;
      section.claims.push({
        claim_id: `C-${pad(state.counters.claim)}`,
        text: ch.text,
        kind: ch.kind,
        source_refs: ch.source_refs,
        fact_refs: ch.fact_refs,
        updated_in_version: versionNo,
      });
      continue;
    }
    for (const section of next.sections) {
      const idx = section.claims.findIndex((c) => c.claim_id === ch.claim_id);
      if (idx < 0) continue;
      if (ch.op === "remove") {
        section.claims.splice(idx, 1);
        state.plan.removed_claims = { ...(state.plan.removed_claims ?? {}), [ch.claim_id!]: versionNo };
      } else
        section.claims[idx] = {
          ...section.claims[idx],
          text: ch.text,
          kind: ch.kind,
          fact_refs: ch.fact_refs,
          source_refs: ch.source_refs,
          updated_in_version: versionNo,
        };
    }
  }

  // 바뀐 사실을 참조하는 항목도 전제가 바뀐 것으로 본다.
  const liveFacts = new Set(next.facts.map((f) => f.fact_id));
  for (const section of next.sections) {
    for (const claim of section.claims) {
      if (claim.fact_refs.some((f) => changedFacts.has(f))) claim.updated_in_version = versionNo;
      claim.fact_refs = claim.fact_refs.filter((f) => liveFacts.has(f));
    }
  }

  if (rev.core_message) next.core_message = rev.core_message;
  if (rev.requested_decision) next.requested_decision = rev.requested_decision;
  return next;
}

// 기준 버전 이후로 대상 항목(또는 참조 사실)이 바뀌었거나 삭제되었는지.
// 삭제는 '삭제된 버전'이 기준보다 뒤일 때만 변경으로 본다(한 번 재개된 뒤 변경안마다 반복 재개되지 않게).
export function targetsChangedSince(plan: PlanContent, removed: Record<string, number> | undefined, targetClaimIds: string[], sinceVersion: number): boolean {
  const claims = new Map(plan.sections.flatMap((s) => s.claims.map((c) => [c.claim_id, c] as const)));
  return targetClaimIds.some((id) => {
    const c = claims.get(id);
    if (c) return c.updated_in_version > sinceVersion;
    return (removed?.[id] ?? 0) > sinceVersion;
  });
}

// 본문(주장, 기존 숫자)이 실제로 바뀌는가.
// 핵심 메시지·요청 결정만 바꾸거나 숫자를 새로 추가만 한 변경안은 본문이 그대로이므로 '반영'으로 보지 않는다.
export function hasChanges(rev: Pick<RevisionProposal, "changes" | "fact_changes">): boolean {
  return rev.changes.length > 0 || rev.fact_changes.some((f) => f.op !== "add");
}

// 기준 버전 이후 실제로 바뀐 항목(판정 근거로 넘긴다 — 변경안의 자기 설명이 아니라 실제 결과).
export function changedSince(plan: PlanContent, removed: Record<string, number> | undefined, sinceVersion: number) {
  return {
    claim_ids: allClaims(plan).filter((c) => c.updated_in_version > sinceVersion).map((c) => c.claim_id),
    removed_claim_ids: Object.entries(removed ?? {}).filter(([, v]) => v > sinceVersion).map(([id]) => id),
    fact_ids: plan.facts.filter((f) => f.updated_in_version > sinceVersion).map((f) => f.fact_id),
  };
}
