/**
 * 風控設定的鎖定檢查——與因子的 lock.ts 同一套邏輯，同一個理由。
 *
 * append-only 保證「登記過的設定不會變」，但擋不住
 * 「登記時寫 A、計算時偷偷用 B」。資料庫看不到程式在算什麼。
 * 所以風控引擎跑之前必須先自證：我手上這份設定，雜湊與登記時一模一樣。
 *
 * 風控被偷改比因子被偷改嚴重得多：因子調錯只是訊號變差，風控調錯是直接爆倉。
 */

import { hashDefinition } from '../factors/definition-hash';
import type { RiskConfig } from './config';
import { validateRiskConfig } from './config';

export interface RegisteredRiskConfig {
  readonly id: number;
  readonly version: string;
  readonly config: Record<string, unknown>;
  readonly config_hash: string;
  readonly rationale: string;
  readonly registered_by: string;
  readonly registered_at: string;
}

/** 設定物件的正規化雜湊。與因子的 definition_hash 用同一個函式，鍵值順序不敏感。 */
export function hashRiskConfig(config: RiskConfig): string {
  return hashDefinition(config as unknown as Record<string, unknown>);
}

export interface RiskLockIssue {
  readonly field: string;
  readonly problem: string;
}

export function checkRiskConfigLock(
  local: RiskConfig,
  registered: readonly RegisteredRiskConfig[],
): readonly RiskLockIssue[] {
  const issues: RiskLockIssue[] = [];

  // 設定本身要先合法，再談有沒有被改
  for (const problem of validateRiskConfig(local)) {
    issues.push({ field: 'config', problem });
  }

  const row = registered.find((r) => r.version === local.version);
  if (row === undefined) {
    issues.push({
      field: 'version',
      problem:
        `風控設定 ${local.version} 尚未登記。未登記的設定不得用於產生交易訊號——` +
        '先跑 npm run l3:register。',
    });
    return issues;
  }

  const localHash = hashRiskConfig(local);
  if (localHash !== row.config_hash) {
    issues.push({
      field: 'config_hash',
      problem:
        `設定內容與登記時不符：登記=${row.config_hash.slice(0, 16)}… ` +
        `程式=${localHash.slice(0, 16)}…。要改設定請換一個 version 重新登記，` +
        '不可沿用舊版本號——否則歷史紀錄會指向錯的設定。',
    });
  }

  return issues;
}

export class RiskConfigLockError extends Error {
  readonly issues: readonly RiskLockIssue[];

  constructor(issues: readonly RiskLockIssue[]) {
    super(
      '風控設定與登記內容不符，拒絕產生交易訊號：\n' +
        issues.map((i) => `  - ${i.field}：${i.problem}`).join('\n'),
    );
    this.name = 'RiskConfigLockError';
    this.issues = issues;
  }
}
