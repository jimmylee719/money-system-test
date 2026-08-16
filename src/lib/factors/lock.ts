/**
 * 定義鎖定檢查：**程式手上的因子定義**與**資料庫登記的**必須完全一致。
 *
 * 【為什麼光有 append-only 還不夠】
 * factor_registry 改不掉是真的，但那只保證「登記過的內容不會變」。
 * 它擋不住另一種作弊：登記時寫 A，計算時偷偷用 B。
 * 資料庫看不到程式在算什麼，只有在寫檢定結果時才會比對 definition_hash——
 * 那已經是幾個月後的事，中間每天推播的清單全都是用 B 算的。
 *
 * 所以排序引擎在跑之前必須先自證：我手上這份定義，雜湊與登記時一模一樣。
 * 對不上就拒絕出榜。寧可今天沒有清單，也不要一份來路不明的清單。
 *
 * 【封存的因子不得再產生訊號】
 * 檢定失敗即封存（CLAUDE.md：不得改條件重測）。封存後還拿來排序，
 * 等於「測不過就當作沒測過」，那比沒檢定更糟。
 */

import { hashDefinition } from './definition-hash';
import type { FactorRegistrationInput, RegisteredFactor } from './types';

export interface LockIssue {
  readonly factorKey: string;
  readonly problem: string;
}

/**
 * @param local      程式手上的定義（V1_FACTORS）
 * @param registered 自 factor_registry 讀回的登記內容
 * @param archived   已封存的 factor_key
 */
export function checkDefinitionLock(
  local: readonly FactorRegistrationInput[],
  registered: readonly RegisteredFactor[],
  archived: ReadonlySet<string>,
): readonly LockIssue[] {
  const byKey = new Map(registered.map((r) => [r.factor_key, r]));
  const issues: LockIssue[] = [];

  for (const factor of local) {
    const row = byKey.get(factor.factorKey);
    if (row === undefined) {
      issues.push({
        factorKey: factor.factorKey,
        problem: '尚未登記。未登記的因子不得參與排序（CLAUDE.md：進 L1 前須先登記）',
      });
      continue;
    }

    const localHash = hashDefinition(factor.definition);
    if (localHash !== row.definition_hash) {
      issues.push({
        factorKey: factor.factorKey,
        problem:
          `definition_hash 不符：登記=${row.definition_hash.slice(0, 16)}… ` +
          `程式=${localHash.slice(0, 16)}…（定義鎖定後不得調參）`,
      });
    }

    if (factor.hypothesisDirection !== row.hypothesis_direction) {
      issues.push({
        factorKey: factor.factorKey,
        problem: `假設方向不符：登記=${row.hypothesis_direction} 程式=${factor.hypothesisDirection}`,
      });
    }

    if (Number(row.t_threshold) !== factor.tThreshold) {
      issues.push({
        factorKey: factor.factorKey,
        problem: `t 門檻不符：登記=${row.t_threshold} 程式=${factor.tThreshold}`,
      });
    }

    if (archived.has(factor.factorKey)) {
      issues.push({
        factorKey: factor.factorKey,
        problem: '已封存。封存的因子不得再產生訊號（檢定失敗不得改條件重測）',
      });
    }
  }

  return issues;
}

export class DefinitionLockError extends Error {
  readonly issues: readonly LockIssue[];

  constructor(issues: readonly LockIssue[]) {
    super(
      '因子定義與登記內容不符，拒絕出榜：\n' +
        issues.map((i) => `  - ${i.factorKey}：${i.problem}`).join('\n') +
        '\n寧可今天沒有清單，也不要一份來路不明的清單。',
    );
    this.name = 'DefinitionLockError';
    this.issues = issues;
  }
}
