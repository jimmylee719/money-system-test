/**
 * P11 — 把 LLM 判定套用到候選清單。
 *
 * 【走的是與 P6 完全相同的閘門】
 * 這裡不另外寫一套「只減不增」的檢查，而是直接呼叫 `assertOnlySubtracts`。
 * 用同一個函式的意義在於：要繞過它，得同時騙過規則式否決層的檢查，
 * 而那個檢查每次執行都會跑。
 *
 * 【LLM 這一層刻意不 fail-closed，理由必須寫在程式裡而不是只寫在報告裡】
 * P6 的規則式否決缺資料時全面否決，因為那是官方事實，查不到就是無法判斷交易狀態。
 * LLM 不同：它是選配的、不可回測的。若「worker 沒跑」等於「今天全部不准進場」，
 * 就等於把系統的停機權交給一個沒人能驗證的元件。
 *
 * 所以沒有判定結果時＝維持 P6 的結果，不加也不減。
 * 但**未判定的筆數會被回報**，日報與 Dashboard 都看得到，
 * 不會變成一個安靜的洞。
 */

import { assertOnlySubtracts } from '../engine';
import type { VetoDecision, VetoResult } from '../types';
import type { LlmVerdict, LlmTask } from './types';

export interface LlmVetoInput {
  /** 當日已入佇列的任務 */
  readonly tasks: readonly LlmTask[];
  /** task_key → 現役模型的判定。沒有結果的任務就是還沒判 */
  readonly verdictsByTaskKey: ReadonlyMap<string, LlmVerdict>;
  /** 現役模型的識別，寫進 evidence 供日後回溯 */
  readonly modelKey: string;
  readonly promptVersion: string;
}

export interface LlmVetoOutcome<T> extends VetoResult<T> {
  /** 已入佇列但尚無判定結果的任務數。> 0 代表 worker 沒跑完 */
  readonly pendingTasks: number;
  /** 解析失敗的筆數 */
  readonly parseFailures: number;
  /** 判否決但引用驗不過而被作廢的筆數 */
  readonly evidenceFailures: number;
}

/**
 * @param candidates 已通過 P6 規則式否決的候選
 */
export function applyLlmVetoes<T extends { readonly code: string }>(
  candidates: readonly T[],
  input: LlmVetoInput,
): LlmVetoOutcome<T> {
  const vetoedCodes = new Map<string, VetoDecision>();
  let pendingTasks = 0;
  let parseFailures = 0;
  let evidenceFailures = 0;

  for (const task of input.tasks) {
    const result = input.verdictsByTaskKey.get(task.taskKey);
    if (result === undefined) {
      pendingTasks += 1;
      continue;
    }
    if (!result.parseOk) {
      parseFailures += 1;
    } else if (!result.evidenceVerified) {
      evidenceFailures += 1;
    }
    if (result.verdict !== 'veto') {
      continue;
    }
    // 同一檔可能有多則公告都被判否決；保留第一則即可，
    // 因為 veto_events 以 (run_id, code, rule_id) 為唯一鍵。
    if (vetoedCodes.has(task.code)) {
      continue;
    }
    vetoedCodes.set(task.code, {
      code: task.code,
      ruleId: 'llm_material_news',
      reason: `重大訊息判定為負面事件（${input.modelKey} / ${input.promptVersion}）：${result.reason}`.slice(
        0,
        500,
      ),
      // evidence 存的是**官方公告原文的逐字片段**，不是模型的話。
      // 日後覆核這條否決對不對，看的必須是原文。
      evidence:
        `【${task.speakDate} ${task.clause}】${task.subject.trim()}\n` +
        `模型引用原文：${result.quotedEvidence}`,
    });
  }

  const passed = candidates.filter((c) => !vetoedCodes.has(c.code));
  const vetoed = candidates
    .filter((c) => vetoedCodes.has(c.code))
    .map((c) => vetoedCodes.get(c.code)!);

  const result: VetoResult<T> = {
    passed,
    vetoed,
    countsByRule: vetoed.length > 0 ? { llm_material_news: vetoed.length } : {},
    failedClosed: false,
  };
  assertOnlySubtracts(candidates, result);

  return { ...result, pendingTasks, parseFailures, evidenceFailures };
}
