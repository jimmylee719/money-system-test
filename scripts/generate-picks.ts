/**
 * 產生每日觀察榜：`npm run l1:picks`（只算不寫）／`npm run l1:picks -- --write`
 *
 * ⚠️ **觀察榜是研究紀錄，不是買進建議**（CLAUDE.md）。
 *    交易訊號必須另外通過 L2 否決與 L3 風控，那兩層還沒做，
 *    因此本腳本目前只產生 watchlist，不產生任何 trade_signal。
 *
 * ⚠️ 預設是 dry-run。daily_picks 是 append-only，寫進去就改不掉，
 *    所以「先看數字，確認無誤才寫」是預設行為，不是選項。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
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

const args = process.argv.slice(2);
const WRITE = args.includes('--write') || process.env['PICKS_WRITE'] === 'yes';
const REVISION = Number(args.find((a) => a.startsWith('--revision='))?.split('=')[1] ?? '1');

/**
 * twse_margin_balance 的 payload 沒有日期欄位（L0 實測），
 * 依已登記的 as_of_rule，L1 以**同一次抓取**的行情 data_as_of 對應。
 * 「同一次抓取」以 fetched_at 相距不超過此值判定；每日排程相隔 24 小時，
 * 因此 6 小時足以涵蓋重試，又不可能誤把前一天的檔案當成今天的。
 */
const SAME_RUN_TOLERANCE_MS = 6 * 60 * 60 * 1000;

/** 五日反轉需要 6 個交易日（t 與 t-5） */
const HISTORY_DAYS = 6;

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

const top = watchlist(result, WATCHLIST_SIZE);

console.log(`\n--- 觀察榜 Top ${top.length}（${dataAsOf}）---`);
console.log('⚠️  這是研究紀錄，不是買進建議。交易訊號須通過 L2 否決與 L3 風控（尚未實作）。\n');
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
console.log('  append-only，此後不可修改或刪除。');
process.exit(0);
