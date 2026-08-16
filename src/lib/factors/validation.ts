/**
 * 因子登記的程式端驗證。純函式。
 *
 * ⚠️ 這一層只是為了給出好讀的錯誤訊息。**真正的守門在資料庫**——
 * 程式可以被改（包括被我改），append-only 表上的 constraint 改不了。
 * 每條規則都對應 0002_factor_registry.sql 的一條 constraint，兩邊必須同步。
 */

import { isValidIsoDate } from '../shared/calendar';
import type {
  FactorRegistrationInput,
  FactorTestResultInput,
  ValidationIssue,
} from './types';

/** 對應 factor_registry_rationale_not_blank */
export const MIN_RATIONALE_LENGTH = 50;
/** 對應 factor_registry_threshold_check（CLAUDE.md 明訂 t > 3.0） */
export const MIN_T_THRESHOLD = 3.0;
/** 對應 factor_test_results_sample_size_check（CLAUDE.md：樣本 < 30 不得下結論） */
export const MIN_SAMPLE_SIZE = 30;
/** 對應 factor_registry_key_format */
export const FACTOR_KEY_RE = /^[a-z][a-z0-9_]{2,63}$/;

const DIRECTIONS = ['higher_is_better', 'lower_is_better'] as const;
const UNIVERSES = ['TWSE', 'TPEx', 'BOTH'] as const;
const METHODS = ['purged_kfold_embargo', 'walk_forward', 'full_sample_descriptive'] as const;

export function validateRegistration(
  input: FactorRegistrationInput,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!FACTOR_KEY_RE.test(input.factorKey)) {
    issues.push({
      field: 'factorKey',
      message: '須為小寫英文開頭、僅含小寫英數與底線、長度 3–64（例：rev_yoy_momentum_v1）',
    });
  }

  if (input.displayName.trim().length === 0) {
    issues.push({ field: 'displayName', message: '不可空白' });
  }

  const rationale = input.economicRationale.trim();
  if (rationale.length < MIN_RATIONALE_LENGTH) {
    issues.push({
      field: 'economicRationale',
      message:
        `經濟理由至少 ${MIN_RATIONALE_LENGTH} 字元，目前 ${rationale.length}。` +
        'CLAUDE.md 明訂空白即拒絕——寫不出機制的因子就是資料探勘，不該進入 L1。',
    });
  }

  if (!DIRECTIONS.includes(input.hypothesisDirection)) {
    issues.push({
      field: 'hypothesisDirection',
      message: `須為 ${DIRECTIONS.join(' 或 ')}，且必須在看到結果之前宣告`,
    });
  }

  if (!isValidIsoDate(input.testPeriodStart)) {
    issues.push({ field: 'testPeriodStart', message: "須為真實存在的 'YYYY-MM-DD' 日期" });
  }
  if (!isValidIsoDate(input.testPeriodEnd)) {
    issues.push({ field: 'testPeriodEnd', message: "須為真實存在的 'YYYY-MM-DD' 日期" });
  }
  if (
    isValidIsoDate(input.testPeriodStart) &&
    isValidIsoDate(input.testPeriodEnd) &&
    input.testPeriodStart >= input.testPeriodEnd
  ) {
    issues.push({ field: 'testPeriodEnd', message: '檢定期間結束日必須晚於起始日' });
  }

  if (!Number.isFinite(input.tThreshold) || input.tThreshold < MIN_T_THRESHOLD) {
    issues.push({
      field: 'tThreshold',
      message: `門檻須 ≥ ${MIN_T_THRESHOLD}（CLAUDE.md 明訂 t > 3.0，不得事後放寬）`,
    });
  }

  if (!UNIVERSES.includes(input.universe)) {
    issues.push({ field: 'universe', message: `須為 ${UNIVERSES.join(' / ')}` });
  }

  if (input.registeredBy.trim().length === 0) {
    issues.push({ field: 'registeredBy', message: '不可空白，登記人須可追溯' });
  }

  if (Object.keys(input.definition).length === 0) {
    issues.push({ field: 'definition', message: '定義不可為空物件，須完整寫出參數' });
  }

  return issues;
}

export function validateTestResult(input: FactorTestResultInput): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!FACTOR_KEY_RE.test(input.factorKey)) {
    issues.push({ field: 'factorKey', message: '格式不符' });
  }
  if (!/^[0-9a-f]{64}$/.test(input.definitionHash)) {
    issues.push({ field: 'definitionHash', message: '須為 64 碼小寫 hex（SHA-256）' });
  }
  if (!Number.isFinite(input.tStatistic)) {
    issues.push({ field: 'tStatistic', message: '須為有限數值' });
  }
  if (!Number.isSafeInteger(input.sampleSize) || input.sampleSize < MIN_SAMPLE_SIZE) {
    issues.push({
      field: 'sampleSize',
      message: `樣本數須 ≥ ${MIN_SAMPLE_SIZE}（CLAUDE.md：樣本 < 30 筆不得下結論）`,
    });
  }
  if (!DIRECTIONS.includes(input.observedDirection)) {
    issues.push({ field: 'observedDirection', message: `須為 ${DIRECTIONS.join(' 或 ')}` });
  }
  if (!METHODS.includes(input.method)) {
    issues.push({
      field: 'method',
      message:
        `須為 ${METHODS.join(' / ')}。` +
        'CLAUDE.md：標準 k-fold 在金融資料必然洩漏，禁用。',
    });
  }

  return issues;
}

/**
 * 依「登記時」宣告的門檻與方向判定是否通過。
 * 與 SQL 的 factor_test_results_guard() 邏輯一致——資料庫會覆核，兩邊不符即拒絕寫入。
 */
export function computePassed(
  tStatistic: number,
  observedDirection: string,
  registeredThreshold: number,
  registeredDirection: string,
): boolean {
  return tStatistic >= registeredThreshold && observedDirection === registeredDirection;
}
