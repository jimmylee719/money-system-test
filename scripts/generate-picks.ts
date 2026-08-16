/**
 * 產生每日觀察榜：`npm run l1:picks`（只算不寫）／`npm run l1:picks -- --write`
 *
 * ⚠️ **觀察榜是研究紀錄，不是買進建議**（CLAUDE.md）。
 *    觀察榜依 L1 排名產生，**不受 L2 否決與 L3 風控影響**——那正是衡量兩層的對照組。
 *    可執行的只有 trade_signal：必須同時通過 L2 與 L3，且經常是 0 檔。
 *
 * ⚠️ 預設是 dry-run。daily_picks 是 append-only，寫進去就改不掉，
 *    所以「先看數字，確認無誤才寫」是預設行為，不是選項。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import {
  hasLineConfig,
  loadEnvFileIfPresent,
  loadLineConfig,
  loadSupabaseConfig,
} from '../src/lib/config/env';
import { LineClient } from '../src/lib/l4/line/client';
import { buildDailyReport } from '../src/lib/l4/line/report';
import { DefinitionLockError, checkDefinitionLock } from '../src/lib/factors/lock';
import { FactorRegistry } from '../src/lib/factors/registry';
import { Postgrest } from '../src/lib/l0/supabase-store';
import { SupabaseStorageBodyStore } from '../src/lib/l0/supabase-storage';
import { alignDataAsOf, buildFactorContext } from '../src/lib/l1/factors/context';
import { V1_FACTORS } from '../src/lib/l1/factors/definitions';
import { WATCHLIST_SIZE, rankUniverse, watchlist } from '../src/lib/l1/factors/engine';
import { SnapshotLoader, SupabaseLedgerReader } from '../src/lib/l1/loader';
import type { LoadedSnapshot } from '../src/lib/l1/loader';
import {
  normalizeMonthlyRevenue,
  normalizeTpexCompanyProfile,
  normalizeTpexInstitutional,
  normalizeTpexMargin,
  normalizeTpexQuotes,
  normalizeTwseCompanyProfile,
  normalizeTwseInstitutional,
  normalizeTwseMargin,
  normalizeTwseQuotes,
} from '../src/lib/l1/normalize';
import { DailyPicksWriter, buildPickRows } from '../src/lib/l1/picks';
import type { DailyQuote } from '../src/lib/l1/types';
import { buildUniverse, mergeUniverses } from '../src/lib/l1/universe';
import { buildVetoContext, isSameRun } from '../src/lib/l2/context';
import { applyVetoes } from '../src/lib/l2/engine';
import { VetoEventWriter, buildVetoRows } from '../src/lib/l2/events';
import {
  normalizeTpexAlteredTrading,
  normalizeTpexAttention,
  normalizeTpexDisposition,
  normalizeTpexSuspension,
  normalizeTwseAlteredTrading,
  normalizeTwseAttention,
  normalizeTwseDisposition,
  normalizeTwseSuspension,
} from '../src/lib/l2/normalize';
import { RULE_SPEC_BY_ID } from '../src/lib/l2/rules';
import { ACTIVE_RISK_CONFIG } from '../src/lib/l3/config';
import { applyRiskLimits } from '../src/lib/l3/engine';
import { RiskConfigLockError, checkRiskConfigLock, hashRiskConfig } from '../src/lib/l3/lock';
import type { RegisteredRiskConfig } from '../src/lib/l3/lock';
import { estimateDailyVolatility } from '../src/lib/l3/volatility';
import type { DailyVolatility } from '../src/lib/l3/volatility';
import type { TradeSignalFields } from '../src/lib/l1/picks';

const args = process.argv.slice(2);
const WRITE = args.includes('--write') || process.env['PICKS_WRITE'] === 'yes';
const REVISION = Number(args.find((a) => a.startsWith('--revision='))?.split('=')[1] ?? '1');
/** --notify 才推播 LINE。日報內容直接來自本次計算結果，與寫入資料庫的是同一份。 */
const NOTIFY = args.includes('--notify');

/**
 * twse_margin_balance 的 payload 沒有日期欄位（L0 實測），
 * 依已登記的 as_of_rule，L1 以**同一次抓取**的行情 data_as_of 對應。
 * 「同一次抓取」以 fetched_at 相距不超過此值判定；每日排程相隔 24 小時，
 * 因此 6 小時足以涵蓋重試，又不可能誤把前一天的檔案當成今天的。
 */
const SAME_RUN_TOLERANCE_MS = 6 * 60 * 60 * 1000;

/**
 * 需要回溯幾個交易日。取兩個需求的較大者：
 *   - 五日反轉因子：6 天（t 與 t−5）
 *   - L3 波動率估計：volMinObservations + 1 天
 * 由設定推導，不寫死——改了設定就自動跟著改。
 */
const HISTORY_DAYS = Math.max(6, ACTIVE_RISK_CONFIG.volMinObservations + 1);

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

const loader = new SnapshotLoader(
  new SupabaseLedgerReader(config.url, config.serviceRoleKey),
  new SupabaseStorageBodyStore({ url: config.url, apiKey: config.serviceRoleKey }),
);

function required(snapshot: LoadedSnapshot | null, id: string): LoadedSnapshot {
  if (snapshot === null) {
    throw new Error(`帳本中找不到 ${id} 的快照。先跑 npm run l0:ingest。`);
  }
  return snapshot;
}

console.log('=== L1 觀察榜 ===');
console.log(WRITE ? '模式：寫入 daily_picks\n' : '模式：dry-run（只算不寫）\n');

// ── 定義鎖定檢查：程式手上的定義必須與登記的完全一致 ────────────────────────
// append-only 保證登記內容不會變，但擋不住「登記時寫 A、計算時用 B」。
// 排序引擎跑之前必須先自證雜湊一致，對不上就拒絕出榜。
const registryClient = new Postgrest({ url: config.url, apiKey: config.serviceRoleKey });
const registry = new FactorRegistry(registryClient, {
  async select<T>(pathAndQuery: string): Promise<readonly T[]> {
    const res = await fetch(`${config.url}/rest/v1/${pathAndQuery}`, {
      headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`查詢失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as readonly T[];
  },
});

const lockIssues = checkDefinitionLock(
  V1_FACTORS,
  await registry.list(),
  await registry.archivedKeys(),
);
if (lockIssues.length > 0) {
  throw new DefinitionLockError(lockIssues);
}
console.log(
  `定義鎖定檢查：${V1_FACTORS.length}/${V1_FACTORS.length} 個因子的 definition_hash、` +
    '假設方向、t 門檻與登記內容完全一致，且皆未封存',
);

// 風控設定同樣要自證未被動過。風控被偷改比因子被偷改嚴重得多：
// 因子調錯只是訊號變差，風控調錯是直接爆倉。
const registeredRiskConfigs = (await (async (): Promise<readonly RegisteredRiskConfig[]> => {
  const res = await fetch(`${config.url}/rest/v1/risk_config?select=*`, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`讀取 risk_config 失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as readonly RegisteredRiskConfig[];
})());

const riskIssues = checkRiskConfigLock(ACTIVE_RISK_CONFIG, registeredRiskConfigs);
if (riskIssues.length > 0) {
  throw new RiskConfigLockError(riskIssues);
}
const riskConfigHash = hashRiskConfig(ACTIVE_RISK_CONFIG);
console.log(
  `風控設定鎖定檢查：${ACTIVE_RISK_CONFIG.version} 的雜湊與登記內容一致` +
    `（${riskConfigHash.slice(0, 16)}…）｜資金 ${ACTIVE_RISK_CONFIG.equityTwd.toLocaleString()} 元、` +
    `每筆風險 ${ACTIVE_RISK_CONFIG.riskPerTradePct}%`,
);

// ── 載入當日快照（載入時會重算 content_hash，不符即拋錯） ────────────────────
const [twseProfile, tpexProfile, twseQuote, tpexQuote, twseInst, tpexInst, twseMargin, tpexMargin, twseRev, tpexRev] =
  await Promise.all([
    loader.latest('mops_twse_company_profile'),
    loader.latest('mops_tpex_company_profile'),
    loader.latest('twse_stock_day_all'),
    loader.latest('tpex_mainboard_daily_close_quotes'),
    loader.latest('twse_institutional_by_stock'),
    loader.latest('tpex_institutional_by_stock'),
    loader.latest('twse_margin_balance'),
    loader.latest('tpex_margin_balance'),
    loader.latest('mops_twse_monthly_revenue'),
    loader.latest('mops_tpex_monthly_revenue'),
  ]);

const quoteSnap = required(twseQuote, 'twse_stock_day_all');
const dataAsOf = quoteSnap.ref.dataAsOf;
if (dataAsOf === null) {
  throw new Error('上市行情快照沒有 data_as_of，無法決定交易日。不從系統時鐘推定。');
}

// ── 日期對齊：不同交易日的資料混在一起排序即為前視偏誤 ──────────────────────
alignDataAsOf(dataAsOf, [
  { label: 'tpex_mainboard_daily_close_quotes', actual: required(tpexQuote, 'tpex 行情').ref.dataAsOf },
  { label: 'twse_institutional_by_stock', actual: required(twseInst, 'twse 法人').ref.dataAsOf },
  { label: 'tpex_institutional_by_stock', actual: required(tpexInst, 'tpex 法人').ref.dataAsOf },
  { label: 'tpex_margin_balance', actual: required(tpexMargin, 'tpex 融資').ref.dataAsOf },
]);
console.log(`資料日期（data_as_of）：${dataAsOf}　—— 取自交易所 payload，非系統時鐘`);

// twse_margin_balance 無日期欄位，改以「同一次抓取」判定
const twseMarginSnap = required(twseMargin, 'twse_margin_balance');
const gapMs = Math.abs(
  Date.parse(twseMarginSnap.ref.fetchedAt) - Date.parse(quoteSnap.ref.fetchedAt),
);
if (gapMs > SAME_RUN_TOLERANCE_MS) {
  throw new Error(
    `twse_margin_balance 的抓取時間與行情相差 ${(gapMs / 3_600_000).toFixed(1)} 小時，` +
      '無法認定為同一次抓取。該來源 payload 沒有日期欄位，對不上就不能用——不猜。',
  );
}
console.log(
  `twse_margin_balance 無日期欄位，依登記的 as_of_rule 對應到 ${dataAsOf}` +
    `（與行情同一次抓取，相差 ${(gapMs / 60_000).toFixed(1)} 分鐘）`,
);

// ── 正規化 ───────────────────────────────────────────────────────────────────
const twseUni = normalizeTwseCompanyProfile(required(twseProfile, 'twse 名冊').payload);
const tpexUni = normalizeTpexCompanyProfile(required(tpexProfile, 'tpex 名冊').payload);
const universe = mergeUniverses(buildUniverse(twseUni.rows), buildUniverse(tpexUni.rows));

const quotes: DailyQuote[] = [
  ...normalizeTwseQuotes(quoteSnap.payload, dataAsOf).rows,
  ...normalizeTpexQuotes(tpexQuote!.payload, dataAsOf).rows,
];
const institutional = [
  ...normalizeTwseInstitutional(twseInst!.payload, dataAsOf).rows,
  ...normalizeTpexInstitutional(tpexInst!.payload, dataAsOf).rows,
];
const margin = [
  ...normalizeTwseMargin(twseMarginSnap.payload, dataAsOf).rows,
  ...normalizeTpexMargin(tpexMargin!.payload, dataAsOf).rows,
];

const revSnaps = [
  { snap: twseRev, market: 'TWSE' as const, id: 'mops_twse_monthly_revenue' },
  { snap: tpexRev, market: 'TPEx' as const, id: 'mops_tpex_monthly_revenue' },
];
const monthlyRevenue = revSnaps.flatMap(({ snap, market, id }) => {
  if (snap === null) {
    console.log(`⚠️  ${id} 無快照，該市場的營收因子將無值`);
    return [];
  }
  const reportDate = snap.ref.dataAsOf;
  const period = snap.ref.dataPeriod;
  if (reportDate === null || period === null) {
    console.log(`⚠️  ${id} 缺 data_as_of 或 data_period，不使用（不猜期別）`);
    return [];
  }
  return normalizeMonthlyRevenue(snap.payload, market, reportDate, period).rows;
});

// ── 歷史行情（五日反轉用） ───────────────────────────────────────────────────
const twseHistory = await loader.recentDays('twse_stock_day_all', HISTORY_DAYS);
const tpexHistory = await loader.recentDays('tpex_mainboard_daily_close_quotes', HISTORY_DAYS);
const tpexByDate = new Map(tpexHistory.map((s) => [s.ref.dataAsOf!, s]));

// 交易日以上市行情為準（櫃買若某日缺快照，該日就只有上市資料，
// 上櫃個股當期的反轉因子會因缺值而排除——如實反映，不補、不猜）
const history = twseHistory.map((snap) => {
  const date = snap.ref.dataAsOf!;
  const tpex = tpexByDate.get(date);
  return {
    date,
    quotes: [
      ...normalizeTwseQuotes(snap.payload, date).rows,
      ...(tpex === undefined ? [] : normalizeTpexQuotes(tpex.payload, date).rows),
    ],
  };
});
const missingTpexDays = history.filter((d) => !tpexByDate.has(d.date)).map((d) => d.date);

console.log(
  `\n歷史交易日：${history.length} 天（${history.map((d) => d.date).join(', ') || '無'}）` +
    (missingTpexDays.length > 0 ? `\n⚠️  櫃買缺快照的日子：${missingTpexDays.join(', ')}` : ''),
);

// ── 計算 ─────────────────────────────────────────────────────────────────────
const ctx = buildFactorContext({
  dataAsOf,
  quotes,
  institutional,
  margin,
  monthlyRevenue,
  history,
});
const result = rankUniverse(universe, ctx);

console.log('\n--- 因子狀態 ---');
for (const key of result.activeFactors) {
  const pct = ((result.coverage[key]! / result.tradableCount) * 100).toFixed(1);
  console.log(`啟用  ${key}　涵蓋 ${result.coverage[key]}/${result.tradableCount}（${pct}%）`);
}
for (const inactive of result.inactiveFactors) {
  console.log(`停用  ${inactive.factorKey}　${inactive.reason}`);
}

console.log('\n--- 標的池 ---');
console.log(
  `公司名冊 ${result.universeSize} 檔｜當日可交易 ${result.tradableCount} 檔｜` +
    `進入排序 ${result.rankedCount} 檔｜五因子全無資料而排除 ${result.excludedNoFactorData} 檔`,
);

// ── L2 否決層 ────────────────────────────────────────────────────────────────
//
// ⚠️ 觀察榜**不受 L2 影響**（CLAUDE.md：觀察榜是研究紀錄，依排名產生）。
//    那正是衡量 L2 的對照組：被否決的標的照樣有報酬資料可比，
//    若被擋掉的後續表現持續勝過通過的，就是 L2 在扣分，該砍掉重練。
//
// L2 套用在**整個排序池**而不是只有前幾名：全記錄才能回答
// 「被擋掉的是前段班還是後段班」。擋掉後段班沒什麼，擋掉前段班才是成本。
const [twseAtt, tpexAtt, twseDisp, tpexDisp, twseSusp, tpexSusp, twseAlt, tpexAlt] =
  await Promise.all([
    loader.latest('twse_attention'),
    loader.latest('tpex_attention'),
    loader.latest('twse_disposition'),
    loader.latest('tpex_disposition'),
    loader.latest('twse_suspended'),
    loader.latest('tpex_suspended'),
    loader.latest('twse_altered_trading'),
    loader.latest('tpex_altered_trading'),
  ]);

/**
 * L2 來源的日期認定分三種（實測結果，見 src/lib/l2/context.ts）：
 *   - 有交易日日期者：必須等於訊號日
 *   - 滾動視窗（處置公告一次回傳多日）：只要是本次抓取的即可，期間比對交給規則
 *   - 無日期欄位或當日僅有佔位列：只能以「與行情同一次抓取」判定
 */
function l2SourceUsable(
  snap: typeof twseAtt,
  label: string,
  requireSignalDate: boolean,
): boolean {
  if (snap === null) {
    console.log(`  ✗ ${label}：帳本中找不到快照`);
    return false;
  }
  if (!isSameRun(snap.ref, quoteSnap.ref)) {
    const hours = (Math.abs(Date.parse(snap.ref.fetchedAt) - Date.parse(quoteSnap.ref.fetchedAt)) / 3_600_000).toFixed(1);
    console.log(`  ✗ ${label}：與行情非同一次抓取（相差 ${hours} 小時）`);
    return false;
  }
  if (requireSignalDate && snap.ref.dataAsOf !== dataAsOf) {
    console.log(`  ✗ ${label}：data_as_of ${snap.ref.dataAsOf} ≠ 訊號日 ${dataAsOf}`);
    return false;
  }
  return true;
}

console.log('\n--- L2 否決層資料來源 ---');
const availability = {
  attention:
    l2SourceUsable(twseAtt, 'twse_attention（無公告時僅有佔位列，故不要求日期）', false) &&
    l2SourceUsable(tpexAtt, 'tpex_attention', true),
  disposition:
    l2SourceUsable(twseDisp, 'twse_disposition（滾動視窗）', false) &&
    l2SourceUsable(tpexDisp, 'tpex_disposition（滾動視窗）', false),
  suspension:
    l2SourceUsable(twseSusp, 'twse_suspended（payload 無日期欄位）', false) &&
    l2SourceUsable(tpexSusp, 'tpex_suspended（日期為日曆日非交易日）', false),
  alteredTrading:
    l2SourceUsable(twseAlt, 'twse_altered_trading（payload 無日期欄位）', false) &&
    l2SourceUsable(tpexAlt, 'tpex_altered_trading', true),
};

const attentionRows = [
  ...normalizeTwseAttention(twseAtt?.payload).rows,
  ...normalizeTpexAttention(tpexAtt?.payload).rows,
];
const dispositionRows = [
  ...normalizeTwseDisposition(twseDisp?.payload).rows,
  ...normalizeTpexDisposition(tpexDisp?.payload).rows,
];
const suspensionRows = [
  ...normalizeTwseSuspension(twseSusp?.payload).rows,
  ...normalizeTpexSuspension(tpexSusp?.payload).rows,
];
const alteredRows = [
  ...normalizeTwseAlteredTrading(twseAlt?.payload).rows,
  ...normalizeTpexAlteredTrading(tpexAlt?.payload).rows,
];

console.log(
  `  公告筆數：注意 ${attentionRows.length}｜處置 ${dispositionRows.length}｜` +
    `暫停 ${suspensionRows.length}｜變更交易 ${alteredRows.length}`,
);

const vetoResult = applyVetoes(
  result.ranked,
  buildVetoContext({
    signalDate: dataAsOf,
    attention: attentionRows,
    disposition: dispositionRows,
    suspension: suspensionRows,
    alteredTrading: alteredRows,
  }),
  availability,
);

console.log('\n--- L2 否決結果 ---');
if (vetoResult.failedClosed) {
  console.log('✗ 否決所需資料缺漏，依 fail-closed 原則全面否決。');
  console.log('  這是故障狀態，不是「今天沒訊號」。');
} else {
  const vetoedCodes = new Set(vetoResult.vetoed.map((v) => v.code));
  console.log(
    `排序池 ${result.ranked.length} 檔 → 通過 ${vetoResult.passed.length} 檔｜` +
      `被否決 ${vetoedCodes.size} 檔（否決事件 ${vetoResult.vetoed.length} 筆，一檔可能觸發多條）`,
  );
  for (const [ruleId, count] of Object.entries(vetoResult.countsByRule)) {
    const spec = RULE_SPEC_BY_ID.get(ruleId as never);
    console.log(
      `  ${ruleId.padEnd(18)} ${String(count).padStart(4)} 檔　把握程度：${spec?.confidence ?? '?'}`,
    );
  }
}

const top = watchlist(result, WATCHLIST_SIZE);

// 最關鍵的一個數字：L2 擋掉的是不是前段班
const passedCodes = new Set(vetoResult.passed.map((s) => s.code));
const topVetoed = top.filter((s) => !passedCodes.has(s.code));
console.log(
  `\n觀察榜 Top ${top.length} 之中會被 L2 擋下的：${topVetoed.length} 檔` +
    (topVetoed.length === 0 ? '' : `（${topVetoed.map((s) => s.code).join(', ')}）`),
);
for (const decision of vetoResult.vetoed.filter((v) => top.some((s) => s.code === v.code))) {
  console.log(`  ${decision.code} [${decision.ruleId}] ${decision.reason}`);
  console.log(`      官方原文：${decision.evidence.slice(0, 120)}`);
}

// ── L3 風控層 ────────────────────────────────────────────────────────────────
//
// 硬上限，無例外。輸入是 L2 通過者，且**依排名順序**——額度有限時先給名次高的。
console.log('\n--- L3 風控層 ---');

// 波動率由對齊交易日的歷史序列估計；停牌造成的缺口不會被當成一日報酬
const volatilityByCode = new Map<string, DailyVolatility>();
for (const [code, series] of ctx.historyByCode) {
  volatilityByCode.set(
    code,
    estimateDailyVolatility(
      series.map((q) => q?.close ?? null),
      ACTIVE_RISK_CONFIG.volEwmSpan,
      ACTIVE_RISK_CONFIG.volMinObservations,
    ),
  );
}
const withVol = [...volatilityByCode.values()].filter((v) => v.sigmaDaily !== null).length;
console.log(
  `波動率可估的檔數：${withVol}/${volatilityByCode.size}` +
    `（需要 ${ACTIVE_RISK_CONFIG.volMinObservations} 筆日報酬，目前系統有 ${history.length} 個交易日）`,
);

// 當月已進場筆數：直接由 daily_picks 的 trade_signal 統計，不另外維護一張表
const monthStart = `${dataAsOf.slice(0, 7)}-01`;
const entriesThisMonth = await (async (): Promise<number> => {
  const res = await fetch(
    `${config.url}/rest/v1/daily_picks?select=id&list_kind=eq.trade_signal` +
      `&data_as_of=gte.${monthStart}&data_as_of=lte.${dataAsOf}&revision=lt.1000`,
    {
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        Prefer: 'count=exact',
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) {
    throw new Error(`統計當月進場筆數失敗：HTTP ${res.status}`);
  }
  return ((await res.json()) as unknown[]).length;
})();

// ⚠️ v1 不下單，尚無實際部位與淨值，故持倉數與回撤傳 0。
//    熔斷規則已實作並測試，但要等 P9 有 outcomes 之後才真正生效。
const riskResult = applyRiskLimits(
  vetoResult.passed,
  {
    signalDate: dataAsOf,
    volatilityByCode,
    entriesThisMonth,
    openPositions: 0,
    currentExposurePct: 0,
    drawdownPct: 0,
  },
  ACTIVE_RISK_CONFIG,
);

console.log(
  `當月已進場 ${entriesThisMonth}/${ACTIVE_RISK_CONFIG.monthlyEntryCap} 筆｜` +
    '持倉數與淨值回撤傳 0（v1 不下單，熔斷待 P9 outcomes 才生效）',
);

if (riskResult.haltedGlobally) {
  console.log(`✗ 全域限制觸發：${riskResult.haltReason}`);
  console.log('  當日一律 0 檔，沒有例外。');
} else {
  console.log(
    `L2 通過 ${vetoResult.passed.length} 檔 → L3 核准 ${riskResult.approved.length} 檔`,
  );
  const order: string[] = Object.keys(riskResult.countsByReason).sort(
    (a, b) => (riskResult.countsByReason[b] ?? 0) - (riskResult.countsByReason[a] ?? 0),
  );
  for (const reason of order) {
    console.log(`  ${reason.padEnd(28)} ${String(riskResult.countsByReason[reason]).padStart(5)} 檔`);
  }
}

console.log(`\n--- 交易訊號（${dataAsOf}）---`);
if (riskResult.approved.length === 0) {
  console.log('0 檔。');
  console.log('⚠️  0 檔是正常且健康的（CLAUDE.md），但要分清楚是「沒有標的通過」還是「資料不足」：');
  const volUnavailable = riskResult.countsByReason['volatility_unavailable'] ?? 0;
  if (volUnavailable > 0) {
    console.log(
      `    本次 ${volUnavailable} 檔是因為波動率估不出來——` +
        `系統目前只有 ${history.length} 個交易日，需要 ${ACTIVE_RISK_CONFIG.volMinObservations + 1} 個。`,
    );
    console.log('    這是資料累積不足，不是市場沒有機會。屏障不得用固定百分比代替。');
  }
} else {
  for (const [i, s] of riskResult.approved.entries()) {
    console.log(
      `${i + 1}. ${s.stock.code} ${s.stock.name}（${s.stock.market}）　進場 ${s.barrier.entryPrice}`,
    );
    console.log(
      `     停損 ${s.barrier.stopPrice.toFixed(2)}　停利 ${s.barrier.takeProfitPrice.toFixed(2)}　` +
        `時間出場 ${s.barrier.timeExitDays} 個交易日`,
    );
    console.log(
      `     ${s.position.lots} 張｜部位 ${Math.round(s.position.positionValueTwd).toLocaleString()} 元` +
        `（${s.position.positionPct.toFixed(1)}%）｜名目風險 ${Math.round(s.position.riskAmountTwd).toLocaleString()} 元` +
        `｜日波動 ${(s.sigmaDaily * 100).toFixed(2)}%`,
    );
    console.log(
      `     扣成本後：停利 ${s.position.outcome.takeProfit.rMultiple.toFixed(2)}R　` +
        `停損 ${s.position.outcome.stopLoss.rMultiple.toFixed(2)}R`,
    );
  }
}

console.log(`\n--- 觀察榜 Top ${top.length}（${dataAsOf}）---`);
console.log('⚠️  這是研究紀錄，不是買進建議。觀察榜依排名產生，不受 L2 否決與 L3 風控影響——');
console.log('    那正是衡量 L2／L3 的對照組。可執行的東西只有上面那份交易訊號。\n');
for (const [i, stock] of top.entries()) {
  console.log(
    `${i + 1}. ${stock.code} ${stock.name}（${stock.market}）　收盤 ${stock.close}　` +
      `合成分數 ${stock.compositeScore.toFixed(4)}　真實因子 ${stock.realFactorCount}/${result.activeFactors.length}`,
  );
  for (const f of stock.factorScores) {
    if (!result.activeFactors.includes(f.factorKey)) {
      continue;
    }
    const raw = f.rawValue === null ? '（無資料，補 0.5）' : f.rawValue.toPrecision(6);
    console.log(`     ${f.factorKey.padEnd(28)} 分數 ${f.score.toFixed(4)}　原始值 ${raw}`);
  }
}

// 合成分數的分布，用來看排序有沒有真的分出高下
const scores = result.ranked.map((s) => s.compositeScore);
if (scores.length > 0) {
  const tiedAtTop = scores.filter((s) => s === scores[0]).length;
  console.log(
    `\n合成分數：最高 ${scores[0]!.toFixed(4)}｜中位 ${scores[Math.floor(scores.length / 2)]!.toFixed(4)}｜` +
      `最低 ${scores[scores.length - 1]!.toFixed(4)}｜與最高分同分者 ${tiedAtTop} 檔`,
  );
}

// ── LINE 日報 ────────────────────────────────────────────────────────────────
//
// 內容直接來自本次計算結果，與寫進資料庫的是**同一份**——
// 若改成事後從資料庫重讀重算，兩邊就可能不一致而沒人發現。
const reportText = buildDailyReport({
  dataAsOf,
  ranking: result,
  watchlist: top,
  veto: vetoResult,
  risk: riskResult,
  historyDays: history.length,
  volMinObservations: ACTIVE_RISK_CONFIG.volMinObservations,
  entriesThisMonth,
  monthlyEntryCap: ACTIVE_RISK_CONFIG.monthlyEntryCap,
});

console.log('\n--- LINE 日報內容 ---');
console.log(reportText);
console.log(`--- 共 ${reportText.length} 字 ---`);

if (NOTIFY) {
  if (!hasLineConfig()) {
    console.log('\n✗ 未設定 LINE 環境變數，略過推播。');
    console.log('  需要 LINE_CHANNEL_ACCESS_TOKEN／LINE_CHANNEL_SECRET／LINE_USER_ID');
  } else {
    const line = loadLineConfig();
    await new LineClient({ channelAccessToken: line.channelAccessToken }).pushText(
      line.userId,
      reportText,
    );
    console.log('\n✓ 已推播 LINE 日報');
  }
}

// ── 寫入 ─────────────────────────────────────────────────────────────────────
if (!WRITE) {
  console.log('\n（dry-run，未寫入資料庫。確認無誤後加 --write）');
  process.exit(0);
}

if (top.length === 0) {
  console.log('\n沒有任何可排序的股票，不寫入。');
  process.exit(1);
}

const runId = crypto.randomUUID();
const signalAt = new Date().toISOString();
const rows = buildPickRows({
  result,
  stocks: top,
  listKind: 'watchlist',
  runId,
  revision: REVISION,
  signalAt,
});

const writer = new DailyPicksWriter(registryClient);
try {
  await writer.insert(rows);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('daily_picks_slot_uniq') || message.includes('23505')) {
    console.log(
      `\n✗ ${dataAsOf} 的 watchlist revision ${REVISION} 已存在，被唯一索引擋下。\n` +
        '  這是刻意的：已推出去的清單不能悄悄覆蓋。\n' +
        `  真的要出修正版請用：npm run l1:picks -- --write --revision=${REVISION + 1}\n` +
        '  兩個版本都會永久留存。',
    );
    process.exit(1);
  }
  throw error;
}

console.log(`\n✓ 已寫入 daily_picks：${rows.length} 列，run_id ${runId}，revision ${REVISION}`);

// 否決紀錄與觀察榜共用同一個 run_id，日後可對照同一次執行的兩份輸出
const vetoRows = buildVetoRows({
  result: vetoResult,
  ranked: result.ranked,
  runId,
  dataAsOf,
  signalAt,
  engineVersion: result.engineVersion,
});
await new VetoEventWriter(registryClient).insert(vetoRows);
console.log(`✓ 已寫入 veto_events：${vetoRows.length} 筆否決紀錄`);

// 交易訊號：0 檔時不寫任何列，那是正常狀態
if (riskResult.approved.length > 0) {
  const signalFields = new Map<string, TradeSignalFields>(
    riskResult.approved.map((s) => [
      s.stock.code,
      {
        entryPrice: s.barrier.entryPrice,
        stopPrice: s.barrier.stopPrice,
        takeProfitPrice: s.barrier.takeProfitPrice,
        timeExitDays: s.barrier.timeExitDays,
        lots: s.position.lots,
        shares: s.position.shares,
        positionValueTwd: s.position.positionValueTwd,
        riskAmountTwd: s.position.riskAmountTwd,
        sigmaDaily: s.sigmaDaily,
        volObservations: s.volObservations,
        equityAtSignalTwd: ACTIVE_RISK_CONFIG.equityTwd,
        riskConfigVersion: ACTIVE_RISK_CONFIG.version,
        riskConfigHash: riskConfigHash,
      },
    ]),
  );
  const signalRows = buildPickRows({
    result,
    stocks: riskResult.approved.map((s) => s.stock),
    listKind: 'trade_signal',
    runId,
    revision: REVISION,
    signalAt,
    signalFields,
  });
  await writer.insert(signalRows);
  console.log(`✓ 已寫入 daily_picks 交易訊號：${signalRows.length} 列`);
} else {
  console.log('· 交易訊號 0 檔，未寫入任何列（0 檔是正常狀態）');
}

console.log('  以上皆為 append-only，此後不可修改或刪除。');
process.exit(0);
