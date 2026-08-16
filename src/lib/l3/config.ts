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
  /**
   * 下單單位（股）。1 = 允許零股，1000 = 只買整張。
   *
   * ⚠️ CLAUDE.md 禁止的是「零股**沖銷**」（零股當沖），不是零股買進。
   *    risk-v1 寫死 1000 是我加的限制，比規定嚴，且在小資金下會讓
   *    絕大多數標的變成「買不起」。v2 起改為 1（允許零股）。
   */
  readonly lotSize: number;
  /**
   * 每日買進金額上限（元）。null = 不設限（風險公式本身已在管）。
   *
   * 這是**額外**的上限，不是取代風險公式：
   * 風險公式先算出該買多少 → 超過當日剩餘預算就砍到預算為止 → 買少是安全的。
   * ❌ 不可反過來「不管什麼股票都買滿預算」——停損距離不同，
   *    同樣金額在低波動股賠 6%、高波動股賠 25%，每筆風險差 4 倍，
   *    R 倍數就無法互相比較，G2 的期望值與獲利因子整套算不出來。
   */
  readonly dailyBuyBudgetTwd: number | null;
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
const BROKER_WORST_CASE: BrokerFeeConfig = {
  commissionRatePpm: 1425, // 法定上限
  discountBps: 10_000, // 無折讓＝最壞情況
  minCommissionTwd: 20, // 查無法規依據，券商自訂，常見值
  commissionRounding: 'floor',
  taxRounding: 'floor',
};

/**
 * ⚠️ **已被 risk-v2 取代，保留僅供歷史紀錄比對。**
 * 兩個問題：部位公式未計入成本（r 因此不是真正的硬上限）、
 * 以及 lotSize=1000 是比 CLAUDE.md 更嚴的自訂限制。
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
  dailyBuyBudgetTwd: null,
  broker: BROKER_WORST_CASE,
};

/**
 * v2 風控設定。2026-08-16 修訂，仍在看到任何一筆損益之前。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 相對 v1 改了四項，每一項都有理由
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `equityTwd` 1,000,000 → 10,000
 *   使用者實際資金為 1–3 萬。**取下限 1 萬**：低估資金會讓部位偏小（安全），
 *   高估則會讓每筆風險超出真實資金的比例（危險）。
 *   實際放 3 萬時請登記 risk-v3，不要沿用此版本。
 *
 * `riskPerTradePct` 1.0 → 2.0
 *   CLAUDE.md 允許 1%–2%。小資金應取**上限**而非下限：
 *   買賣各 20 元的最低手續費是固定成本，部位越小稀釋越嚴重。
 *   實測（進場 50 元、日波動 2%）：
 *     1 萬 × 1% → 約 9 股、450 元部位 → 實際賠率 0.76 : 1（負期望）
 *     1 萬 × 2% → 約 25 股、1,250 元部位 → 實際賠率 1.35 : 1
 *   取下限反而讓每一筆都不值得做——保守的參數配上固定成本，結果並不保守。
 *
 * `lotSize` 1000 → 1（允許零股）
 *   CLAUDE.md 禁止的是零股**沖銷**，不是零股買進。v1 的整張限制是我自己加的，
 *   在小資金下會讓絕大多數標的變成「買不起」而完全無法運作。
 *   ⚠️ 盤中零股的實際撮合頻率與流動性尚未查證；v1 不下單故不影響紀錄，
 *      但 v2 自動下單前必須實測，不可假設「算得出來就買得到」。
 *
 * `maxConcurrentPositions` 5 → 3
 *   r 從 1% 升到 2%，同時全數停損的損失會變成 部位數 × 2%。
 *   維持「可容忍最壞同時損失」在熔斷門檻的一半以下：3 × 2% = 6% ≪ 15%。
 *   小資金本來也分散不了太多檔。
 *
 * `monthlyEntryCap` 10 → 6
 *   維持原推導：持有 10 日 ≈ 半月，一個月週轉 2 次 × 3 檔 = 6。
 *
 * 其餘（volEwmSpan / volMinObservations / holdingDays / stopSigmaMultiple /
 * takeProfitR / maxSinglePositionPct / maxTotalExposurePct /
 * circuitBreakerDrawdownPct / broker）維持 v1 的推導不變。
 * ─────────────────────────────────────────────────────────────────────────
 */
export const RISK_CONFIG_V2: RiskConfig = {
  version: 'risk-v2',

  equityTwd: 10_000,
  riskPerTradePct: 2.0,

  volEwmSpan: 100,
  volMinObservations: 20,

  holdingDays: 10,
  stopSigmaMultiple: 2.0,
  takeProfitR: 2.0,

  maxConcurrentPositions: 3,
  monthlyEntryCap: 6,
  maxSinglePositionPct: 20,
  maxTotalExposurePct: 60,

  circuitBreakerDrawdownPct: 15,

  lotSize: 1,
  dailyBuyBudgetTwd: null,
  broker: BROKER_WORST_CASE,
};

/** 目前生效的設定。換版本只改這一行，其餘程式不必動。 */
export const ACTIVE_RISK_CONFIG: RiskConfig = RISK_CONFIG_V2;

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
  if (config.lotSize < 1 || !Number.isInteger(config.lotSize)) {
    issues.push('lotSize 必須是 ≥ 1 的整數');
  }
  if (config.dailyBuyBudgetTwd !== null && config.dailyBuyBudgetTwd <= 0) {
    issues.push('dailyBuyBudgetTwd 若有設定必須為正數；不設限請用 null');
  }
  return issues;
}
