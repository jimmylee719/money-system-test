/**
 * L2 否決引擎。
 *
 * 【只能否決，這件事由程式結構保證，不靠自律】
 * `applyVetoes` 的輸出在回傳前會實際比對一次：
 * 每一個通過者都必須是輸入裡的同一個物件，且不得重複。
 * 不符就拋 `VetoLayerViolationError` 而不是靜默回傳——
 * 一個會偷偷新增標的的「否決層」，比沒有否決層危險得多。
 *
 * 【fail-closed：查不到就否決】
 * 資料缺漏時不是「今天沒有限制」，而是「今天無法判斷」。
 * 無法判斷卻照樣進場，等於把不知道當成沒問題。
 * 因此任一必要來源缺漏，全部候選一律否決，並標記 failedClosed。
 * 這是故障狀態，會在報表上明確顯示，不會被誤讀成「今天剛好沒訊號」。
 */

import type { VetoContext } from './rules';
import { VETO_CHECKS } from './rules';
import type { VetoDecision, VetoResult } from './types';

export class VetoLayerViolationError extends Error {
  constructor(detail: string) {
    super(
      `L2 否決層違反「只能否決」的鐵則：${detail}。` +
        'L2 的輸出必須是輸入的子集合，這是 CLAUDE.md 的第四條鐵則。',
    );
    this.name = 'VetoLayerViolationError';
  }
}

/** 必要來源的可用性。任一為 false 即全面否決。 */
export interface SourceAvailability {
  readonly attention: boolean;
  readonly disposition: boolean;
  readonly suspension: boolean;
  readonly alteredTrading: boolean;
}

export function missingSources(availability: SourceAvailability): readonly string[] {
  const missing: string[] = [];
  if (!availability.attention) missing.push('注意股');
  if (!availability.disposition) missing.push('處置股');
  if (!availability.suspension) missing.push('暫停交易');
  if (!availability.alteredTrading) missing.push('變更交易');
  return missing;
}

/**
 * 對候選清單套用全部否決規則。
 *
 * @param candidates 任何帶 `code` 的候選（通常是 L1 的排序結果）
 * @param ctx        當日的交易狀態事實
 * @param availability 必要來源是否齊備。缺一即 fail-closed。
 */
export function applyVetoes<T extends { readonly code: string }>(
  candidates: readonly T[],
  ctx: VetoContext,
  availability: SourceAvailability,
): VetoResult<T> {
  const missing = missingSources(availability);

  if (missing.length > 0) {
    // fail-closed：無法判斷時全部否決，一檔都不放行
    const vetoed = candidates.map<VetoDecision>((c) => ({
      code: c.code,
      ruleId: 'source_unavailable',
      reason: `否決所需資料缺漏：${missing.join('、')}`,
      evidence: `無法確認是否處於注意／處置／暫停／變更交易狀態，依 fail-closed 原則全面否決`,
    }));
    return {
      passed: [],
      vetoed,
      countsByRule: { source_unavailable: candidates.length },
      failedClosed: true,
    };
  }

  const passed: T[] = [];
  const vetoed: VetoDecision[] = [];
  const counts: Record<string, number> = {};

  for (const candidate of candidates) {
    // 同一檔可能同時觸發多條規則，全部記錄，不只記第一條——
    // 只記第一條會讓「這檔到底有多少問題」在資料上消失。
    const hits: VetoDecision[] = [];
    for (const check of VETO_CHECKS) {
      const decision = check(candidate.code, ctx);
      if (decision !== null) {
        hits.push(decision);
      }
    }
    if (hits.length === 0) {
      passed.push(candidate);
      continue;
    }
    for (const hit of hits) {
      vetoed.push(hit);
      counts[hit.ruleId] = (counts[hit.ruleId] ?? 0) + 1;
    }
  }

  const result: VetoResult<T> = { passed, vetoed, countsByRule: counts, failedClosed: false };
  assertOnlySubtracts(candidates, result);
  return result;
}

/**
 * 實際驗證「只減不增」。這不是註解也不是測試，是每次執行都會跑的檢查。
 * 測試可以被改，這一行在正式執行時也擋得住。
 */
export function assertOnlySubtracts<T extends { readonly code: string }>(
  input: readonly T[],
  result: VetoResult<T>,
): void {
  if (result.passed.length > input.length) {
    throw new VetoLayerViolationError(
      `通過數 ${result.passed.length} 大於輸入數 ${input.length}`,
    );
  }

  const inputSet = new Set<T>(input);
  const seen = new Set<T>();
  for (const item of result.passed) {
    if (!inputSet.has(item)) {
      throw new VetoLayerViolationError(`通過清單中的 ${item.code} 不在輸入清單裡（L2 不得產生新標的）`);
    }
    if (seen.has(item)) {
      throw new VetoLayerViolationError(`${item.code} 在通過清單中重複出現`);
    }
    seen.add(item);
  }

  // 通過數 + 被否決的相異代號數 必須等於輸入數
  const vetoedCodes = new Set(result.vetoed.map((v) => v.code));
  if (result.passed.length + vetoedCodes.size !== input.length) {
    throw new VetoLayerViolationError(
      `通過 ${result.passed.length} + 被否決 ${vetoedCodes.size} ≠ 輸入 ${input.length}，有標的憑空消失或出現`,
    );
  }
}
