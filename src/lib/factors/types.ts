/**
 * P4 — 因子預先登記型別。
 *
 * 每個欄位都對應 supabase/migrations/0002_factor_registry.sql 的一條 constraint。
 * 程式端驗證只是為了給出好的錯誤訊息；**真正的守門在資料庫**，
 * 因為程式可以被改，append-only 表上的 constraint 改不了。
 */

/** 假設方向。必須在看到結果之前宣告，事後不得翻轉。 */
export type HypothesisDirection = 'higher_is_better' | 'lower_is_better';

export type Universe = 'TWSE' | 'TPEx' | 'BOTH';

export type FactorStatus = 'registered' | 'testing' | 'passed' | 'archived';

/**
 * 檢定方法。
 * CLAUDE.md：標準 k-fold 在金融資料必然洩漏，禁用。
 */
export type TestMethod = 'purged_kfold_embargo' | 'walk_forward' | 'full_sample_descriptive';

/** 因子定義。任意 JSON，但一經登記即鎖定（以 definition_hash 綁定）。 */
export type FactorDefinition = Record<string, unknown>;

/** 登記申請（尚未寫入資料庫） */
export interface FactorRegistrationInput {
  readonly factorKey: string;
  readonly displayName: string;
  readonly definition: FactorDefinition;
  /** 經濟理由。空白即拒絕；至少 50 字元。 */
  readonly economicRationale: string;
  readonly hypothesisDirection: HypothesisDirection;
  /** 檢定期間，'YYYY-MM-DD' */
  readonly testPeriodStart: string;
  readonly testPeriodEnd: string;
  /** t 值門檻，須 ≥ 3.0 */
  readonly tThreshold: number;
  readonly universe: Universe;
  readonly registeredBy: string;
}

/** 已登記的因子（自資料庫讀回） */
export interface RegisteredFactor {
  readonly id: number;
  readonly factor_key: string;
  readonly display_name: string;
  readonly definition: FactorDefinition;
  readonly definition_hash: string;
  readonly economic_rationale: string;
  readonly hypothesis_direction: HypothesisDirection;
  readonly test_period_start: string;
  readonly test_period_end: string;
  readonly t_threshold: string;
  readonly universe: Universe;
  readonly registered_by: string;
  /** 由資料庫蓋章，應用程式無寫入權限 */
  readonly registered_at: string;
}

/** 檢定結果申請 */
export interface FactorTestResultInput {
  readonly factorKey: string;
  /** 必須與登記時相同，否則資料庫拒絕 */
  readonly definitionHash: string;
  readonly tStatistic: number;
  /** 樣本數，須 ≥ 30（CLAUDE.md：樣本 < 30 不得下結論） */
  readonly sampleSize: number;
  readonly observedDirection: HypothesisDirection;
  readonly method: TestMethod;
  readonly notes?: string;
}

/** DSR 呈報用的試驗次數摘要 */
export interface FactorTrialSummary {
  readonly total_registrations: number;
  /** 守門驗證用的探針因子（factor_key 以 probe_ 開頭），append-only 刪不掉 */
  readonly probe_registrations: number;
  /** 呈報 DSR 時該用的試驗次數 */
  readonly real_registrations: number;
  readonly total_tests: number;
  readonly passed_tests: number;
  readonly archived_factors: number;
}

/** 驗證失敗的單一問題 */
export interface ValidationIssue {
  readonly field: string;
  readonly message: string;
}

export class FactorValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(`因子登記被拒絕：\n${issues.map((i) => `  - ${i.field}：${i.message}`).join('\n')}`);
    this.name = 'FactorValidationError';
    this.issues = issues;
  }
}
