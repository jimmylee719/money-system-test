/**
 * 因子登記本的資料庫用戶端。重用 L0 的 Postgrest（零執行期依賴）。
 *
 * 這一層刻意「薄」：不做業務判斷，只負責把驗證過的資料送進資料庫，
 * 並把資料庫的拒絕原因原樣拋出。真正的規則在 SQL constraint 與觸發器。
 */

import type { PostgrestClient } from '../l0/supabase-store';
import { hashDefinition } from './definition-hash';
import type {
  FactorRegistrationInput,
  FactorStatus,
  FactorTestResultInput,
  FactorTrialSummary,
  RegisteredFactor,
} from './types';
import { FactorValidationError } from './types';
import { validateRegistration, validateTestResult } from './validation';

export const FACTOR_REGISTRY_TABLE = 'factor_registry';
export const FACTOR_STATUS_EVENTS_TABLE = 'factor_status_events';
export const FACTOR_TEST_RESULTS_TABLE = 'factor_test_results';
export const FACTOR_TRIAL_SUMMARY_VIEW = 'factor_trial_summary';

/** 讀取用的最小介面，方便測試替身 */
export interface FactorRegistryReader {
  select<T>(pathAndQuery: string): Promise<readonly T[]>;
}

export class FactorRegistry {
  readonly #client: PostgrestClient;
  readonly #reader: FactorRegistryReader;

  constructor(client: PostgrestClient, reader: FactorRegistryReader) {
    this.#client = client;
    this.#reader = reader;
  }

  /**
   * 登記因子。
   * definition_hash 由本函式計算，呼叫端無法指定——避免送出與定義不符的雜湊。
   */
  async register(input: FactorRegistrationInput): Promise<{ definitionHash: string }> {
    const issues = validateRegistration(input);
    if (issues.length > 0) {
      throw new FactorValidationError(issues);
    }

    const definitionHash = hashDefinition(input.definition);

    await this.#client.insert(FACTOR_REGISTRY_TABLE, [
      {
        factor_key: input.factorKey,
        display_name: input.displayName,
        definition: input.definition,
        definition_hash: definitionHash,
        economic_rationale: input.economicRationale.trim(),
        hypothesis_direction: input.hypothesisDirection,
        test_period_start: input.testPeriodStart,
        test_period_end: input.testPeriodEnd,
        t_threshold: input.tThreshold,
        universe: input.universe,
        registered_by: input.registeredBy,
        // 刻意不送 registered_at —— 資料庫沒有給應用程式該欄位的 INSERT 權限
      },
    ]);

    return { definitionHash };
  }

  /**
   * 記錄檢定結果。
   * `passed` 不由呼叫端決定：本函式依登記時的門檻與方向計算，
   * 資料庫的觸發器會再獨立覆核一次，兩邊不符即拒絕寫入。
   */
  async recordTestResult(input: FactorTestResultInput): Promise<{ passed: boolean }> {
    const issues = validateTestResult(input);
    if (issues.length > 0) {
      throw new FactorValidationError(issues);
    }

    const factor = await this.get(input.factorKey);
    if (factor === null) {
      throw new FactorValidationError([
        { field: 'factorKey', message: `因子 ${input.factorKey} 尚未登記` },
      ]);
    }

    const passed =
      input.tStatistic >= Number(factor.t_threshold) &&
      input.observedDirection === factor.hypothesis_direction;

    await this.#client.insert(FACTOR_TEST_RESULTS_TABLE, [
      {
        factor_key: input.factorKey,
        definition_hash: input.definitionHash,
        t_statistic: input.tStatistic,
        sample_size: input.sampleSize,
        observed_direction: input.observedDirection,
        passed,
        method: input.method,
        notes: input.notes ?? null,
      },
    ]);

    return { passed };
  }

  /** 記錄狀態事件。封存後資料庫會拒絕任何後續事件。 */
  async recordStatus(factorKey: string, status: FactorStatus, reason: string): Promise<void> {
    if (reason.trim().length < 10) {
      throw new FactorValidationError([
        { field: 'reason', message: '狀態變更理由至少 10 字元，須可追溯' },
      ]);
    }
    await this.#client.insert(FACTOR_STATUS_EVENTS_TABLE, [
      { factor_key: factorKey, status, reason: reason.trim() },
    ]);
  }

  async get(factorKey: string): Promise<RegisteredFactor | null> {
    const rows = await this.#reader.select<RegisteredFactor>(
      `${FACTOR_REGISTRY_TABLE}?factor_key=eq.${encodeURIComponent(factorKey)}&select=*&limit=1`,
    );
    return rows[0] ?? null;
  }

  async list(): Promise<readonly RegisteredFactor[]> {
    return this.#reader.select<RegisteredFactor>(
      `${FACTOR_REGISTRY_TABLE}?select=*&order=registered_at.asc`,
    );
  }

  /**
   * 已封存的 factor_key。
   * 封存是終局狀態——資料庫會拒絕封存之後的任何狀態事件，
   * 因此「出現過 archived 事件」即等於「現在是封存狀態」。
   */
  async archivedKeys(): Promise<ReadonlySet<string>> {
    const rows = await this.#reader.select<{ factor_key: string }>(
      `${FACTOR_STATUS_EVENTS_TABLE}?status=eq.archived&select=factor_key`,
    );
    return new Set(rows.map((r) => r.factor_key));
  }

  /** DSR 呈報用。試驗次數含失敗與封存者。 */
  async trialSummary(): Promise<FactorTrialSummary> {
    const rows = await this.#reader.select<FactorTrialSummary>(
      `${FACTOR_TRIAL_SUMMARY_VIEW}?select=*`,
    );
    return (
      rows[0] ?? {
        total_registrations: 0,
        probe_registrations: 0,
        real_registrations: 0,
        total_tests: 0,
        passed_tests: 0,
        archived_factors: 0,
      }
    );
  }
}
