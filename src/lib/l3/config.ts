/**
 * L3 風控設定。**這是硬上限，無例外**（CLAUDE.md）。
 *
 * 【每一個數字都要有推導，不能是偏好】
 * 風控參數和因子一樣會被事後合理化：虧了就放寬停損、賺了就調高部位。
 * 因此這份設定與因子同樣處理——算出 SHA-256 登記到資料庫，
 * 引擎執行前先核對雜湊，對不上就拒絕出訊號。改了設定一定留下痕跡。
 *
 * 【資金是設定值，不是常數】
 * 使用者 2026-08-16 選擇「先用假設值 100 萬跑，之後再改」。
 * 每一筆訊號都記錄**當時使用的資金**，所以改了之後前後期的部位紀錄仍分得清楚。
 * 改資金會換一個 config 版本與雜湊，這是刻意的。
 */

import type { BrokerFeeConfig } from '../cost/types';

export interface RiskConfig {
  /** 設定版本。任何數字變動都必須換版本號，歷史才可回溯。 */
  readonly version: string;

  // ── 資金與單筆風險 ──────────────────────────────────────────────────────
  /** 總資金（元）。使用者可調整；每筆訊號記錄當時的值。 */
  readonly equityTwd: number;
  /** 每筆風險比例 r（%）。CLAUDE.md：1%–2%，取下限較保守。 */
  readonly riskPerTradePct: number;

  // ── 波動率估計 ──────────────────────────────────────────────────────────
  /** EWM 跨度。López de Prado《AFML》getDailyVol 的預設值 span0=100。 */
  readonly volEwmSpan: number;
  /** 估波動所需的最少交易日。不足即拒絕出訊號（fail-closed），不用固定百分比代替。 */
  readonly volMinObservations: number;

  // ── 三屏障 ──────────────────────────────────────────────────────────────
  /** 時間出場 N 個交易日。CLAUDE.md 持有期「數日至兩週」，兩週＝10 個交易日。 */
  readonly holdingDays: number;
  /** 1R 停損距離 = 此倍數 × 日波動 × √N */
  readonly stopSigmaMultiple: number;
  /** 停利倍數。CLAUDE.md：≥2R，取下限。 */
  readonly takeProfitR: number;

  // ── 曝險與換手 ──────────────────────────────────────────────────────────
  /** 同時持有部位數上限 */
  readonly maxConcurrentPositions: number;
  /** 每月進場筆數硬上限。超過即拒絕所有新訊號。 */
  readonly monthlyEntryCap: number;
  /** 單一部位金額佔總資金上限（%） */
  readonly maxSinglePositionPct: number;
  /** 總曝險佔總資金上限（%） */
  readonly maxTotalExposurePct: number;

  // ── 熔斷 ────────────────────────────────────────────────────────────────
  /** 淨值回撤達此百分比即停機，拒絕所有新訊號 */
  readonly circuitBreakerDrawdownPct: number;

  // ── 台股制度 ────────────────────────────────────────────────────────────
  /** 一張＝1000 股。零股不納入（CLAUDE.md 禁止零股沖銷，且零股流動性另計）。 */
  readonly lotSize: number;
  readonly broker: BrokerFeeConfig;
}

/**
 * v1 風控設定。**在看到任何一筆損益之前訂定**，與因子同樣不得事後調整。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 每個數字的推導（不是偏好，是算出來的）
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `riskPerTradePct = 1.0`
 *   CLAUDE.md 明訂 r = 1%–2%。取下限。
 *
 * `holdingDays = 10`
 *   CLAUDE.md 定義持有期為「數日至兩週」。兩週恰為 10 個交易日，
 *   取上限作為時間出場點——時間出場是資金週轉引擎，不是預測。
 *
 * `volEwmSpan = 100`
 *   López de Prado《Advances in Financial Machine Learning》(2018) 第 3 章
 *   getDailyVol 的預設跨度。採用已發表的標準值，而不是我挑一個。
 *
 * `volMinObservations = 20`
 *   約一個月的交易日。少於此，EWM 標準差由極少數幾天主導，估出來的
 *   停損距離不可信。不足時**拒絕出訊號**，不退回固定百分比——
 *   CLAUDE.md 明文「屏障用報酬 EWMA 動態調整，不用固定百分比」。
 *
 * `stopSigmaMultiple = 2.0`
 *   1R = 2σ√N。在無漂移的常態近似下，1σ 停損約有 32% 機率單純被雜訊掃到，
 *   2σ 約 5%。取 2 是「不被日常波動掃出場」與「虧損有界」的標準折衷。
 *
 * `takeProfitR = 2.0`
 *   CLAUDE.md 明訂停利 ≥2R。取下限（最低合規值）。
 *
 * `maxConcurrentPositions = 5`
 *   由「可容忍的最壞同時損失」反推：每筆風險 1%，若同時持有的部位
 *   在同一天全部觸及停損，總損失 = 部位數 × 1%。設定可容忍值 5% → 5 檔。
 *   這不是「我覺得 5 檔剛好」，是 5% ÷ 1% 的結果。
 *
 * `monthlyEntryCap = 10`
 *   持有 10 個交易日 ≈ 半個月，故同一個部位額度一個月最多週轉 2 次。
 *   上限 = maxConcurrentPositions × 2 = 10。超過即拒絕所有新訊號。
 *
 * `maxSinglePositionPct = 20`
 *   單一個股腰斬（−50%）時的總損失上限訂為 10% → 20% × 50% = 10%。
 *   低波動股的停損距離很短，部位公式會算出極大張數，這道上限就是為了擋它。
 *
 * `maxTotalExposurePct = 60`
 *   保留 40% 現金。理由不是市場判斷，是制度：熔斷觸發後仍須有資金
 *   承接既有部位的出場成本與可能的追繳，滿倉會讓風控無法執行。
 *
 * `circuitBreakerDrawdownPct = 15`
 *   「同時 5 檔全數停損」= 5%，那是正常最壞情況。熔斷應在明顯超出正常
 *   最壞情況時才觸發 → 連續三批部位全滅 = 15%。
 *
 * `broker` 刻意用**無折讓**的最壞情況（discountBps = 10000）。
 *   高估成本是安全的方向：若連無折讓都能通過損益兩平檢查，有折讓必然也能。
 *   實際折讓由使用者日後填入，那會換一個 config 版本。
 * ─────────────────────────────────────────────────────────────────────────
 */
export const RISK_CONFIG_V1: RiskConfig = {
  version: 'risk-v1',

  equityTwd: 1_000_000,
  riskPerTradePct: 1.0,

  volEwmSpan: 100,
  volMinObservations: 20,

  holdingDays: 10,
  stopSigmaMultiple: 2.0,
  takeProfitR: 2.0,

  maxConcurrentPositions: 5,
  monthlyEntryCap: 10,
  maxSinglePositionPct: 20,
  maxTotalExposurePct: 60,

  circuitBreakerDrawdownPct: 15,

  lotSize: 1000,
  broker: {
    commissionRatePpm: 1425, // 法定上限
    discountBps: 10_000, // 無折讓＝最壞情況
    minCommissionTwd: 20, // 查無法規依據，券商自訂，常見值
    commissionRounding: 'floor',
    taxRounding: 'floor',
  },
};

/** 設定的健全性檢查。違反者代表設定本身寫錯，不是市場問題。 */
export function validateRiskConfig(config: RiskConfig): readonly string[] {
  const issues: string[] = [];

  if (config.riskPerTradePct < 1 || config.riskPerTradePct > 2) {
    issues.push(`riskPerTradePct=${config.riskPerTradePct} 超出 CLAUDE.md 規定的 1%–2%`);
  }
  if (config.takeProfitR < 2) {
    issues.push(`takeProfitR=${config.takeProfitR} 低於 CLAUDE.md 規定的 ≥2R`);
  }
  if (config.equityTwd <= 0) {
    issues.push('equityTwd 必須為正數');
  }
  if (config.holdingDays < 1) {
    issues.push('holdingDays 必須 ≥ 1');
  }
  if (config.volMinObservations < 2) {
    issues.push('volMinObservations 至少要 2 才算得出標準差');
  }
  if (config.stopSigmaMultiple <= 0) {
    issues.push('stopSigmaMultiple 必須為正數');
  }
  // 同時全部停損的總損失不得超過熔斷門檻，否則熔斷永遠來不及生效
  const worstCase = config.maxConcurrentPositions * config.riskPerTradePct;
  if (worstCase >= config.circuitBreakerDrawdownPct) {
    issues.push(
      `同時 ${config.maxConcurrentPositions} 檔全數停損損失 ${worstCase}%，` +
        `已達熔斷門檻 ${config.circuitBreakerDrawdownPct}% —— 熔斷會在正常情況下就觸發`,
    );
  }
  if (config.maxSinglePositionPct > config.maxTotalExposurePct) {
    issues.push('單一部位上限不得高於總曝險上限');
  }
  if (config.lotSize < 1) {
    issues.push('lotSize 必須 ≥ 1');
  }
  return issues;
}
