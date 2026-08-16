/**
 * L1 正規化與標的池的實測驗證：`npm run l1:verify`
 *
 * 用真實的 L0 快照驗證三件事：
 *   1. 讀取時的雜湊比對通過（帳本與儲存層一致）
 *   2. **解析零失敗**——unparsable > 0 代表官方格式變了，必須有人看
 *   3. 標的池數字合理：公司名冊 vs 行情表的交集、被排除的權證數量
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 * ⚠️ 這裡只檢視資料的「格式與涵蓋範圍」，不計算任何因子排序——
 *    因子必須先在 factor_registry 登記才能算，否則就是看到結果才決定規則。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { SupabaseStorageBodyStore } from '../src/lib/l0/supabase-storage';
import { SnapshotLoader, SupabaseLedgerReader } from '../src/lib/l1/loader';
import {
  normalizeTpexCompanyProfile,
  normalizeTpexInstitutional,
  normalizeTpexQuotes,
  normalizeTpexValuation,
  normalizeTwseCompanyProfile,
  normalizeTwseInstitutional,
  normalizeTwseQuotes,
  normalizeTwseValuation,
} from '../src/lib/l1/normalize';
import { buildUniverse, filterToUniverse, isTradable, mergeUniverses } from '../src/lib/l1/universe';
import type { ParseStats } from '../src/lib/l1/parse';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

const loader = new SnapshotLoader(
  new SupabaseLedgerReader(config.url, config.serviceRoleKey),
  new SupabaseStorageBodyStore({ url: config.url, apiKey: config.serviceRoleKey }),
);

const failures: string[] = [];
function check(name: string, passed: boolean, detail: string): void {
  console.log(`${passed ? '✓' : '✗'} ${name}`);
  console.log(`    ${detail}`);
  if (!passed) {
    failures.push(`${name}：${detail}`);
  }
}

function reportStats(label: string, stats: ParseStats): void {
  const ok = stats.unparsable === 0;
  check(
    `${label} 解析`,
    ok,
    `成功 ${stats.parsed}｜官方缺值 ${stats.blank}｜解析失敗 ${stats.unparsable}` +
      (ok ? '' : `　樣本 ${JSON.stringify(stats.unparsableSamples)}`),
  );
}

console.log('=== L1 正規化與標的池驗證 ===\n');

// ── 載入（含雜湊比對） ───────────────────────────────────────────────────────
const [twseProfile, tpexProfile, twseQuote, tpexQuote, twseVal, tpexVal, twseInst, tpexInst] =
  await Promise.all([
    loader.latest('mops_twse_company_profile'),
    loader.latest('mops_tpex_company_profile'),
    loader.latest('twse_stock_day_all'),
    loader.latest('tpex_mainboard_daily_close_quotes'),
    loader.latest('twse_bwibbu_all'),
    loader.latest('tpex_mainboard_peratio_analysis'),
    loader.latest('twse_institutional_by_stock'),
    loader.latest('tpex_institutional_by_stock'),
  ]);

const required = {
  mops_twse_company_profile: twseProfile,
  mops_tpex_company_profile: tpexProfile,
  twse_stock_day_all: twseQuote,
  tpex_mainboard_daily_close_quotes: tpexQuote,
  twse_bwibbu_all: twseVal,
  tpex_mainboard_peratio_analysis: tpexVal,
  twse_institutional_by_stock: twseInst,
  tpex_institutional_by_stock: tpexInst,
};
for (const [id, snap] of Object.entries(required)) {
  if (snap === null) {
    failures.push(`${id}：帳本中找不到快照`);
  }
}
if (failures.length > 0) {
  console.log('✗ 缺少必要快照，先跑 npm run l0:ingest');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}

check(
  '讀取時雜湊比對',
  true,
  `8 個快照全部通過（不符會在 SnapshotLoader 直接拋錯，不會走到這裡）`,
);

// ── 正規化 ───────────────────────────────────────────────────────────────────
const twseUni = normalizeTwseCompanyProfile(twseProfile!.payload);
const tpexUni = normalizeTpexCompanyProfile(tpexProfile!.payload);
const twseQ = normalizeTwseQuotes(twseQuote!.payload, twseQuote!.ref.dataAsOf ?? '');
const tpexQ = normalizeTpexQuotes(tpexQuote!.payload, tpexQuote!.ref.dataAsOf ?? '');
const twseV = normalizeTwseValuation(twseVal!.payload, twseVal!.ref.dataAsOf ?? '');
const tpexV = normalizeTpexValuation(tpexVal!.payload, tpexVal!.ref.dataAsOf ?? '');
const twseI = normalizeTwseInstitutional(twseInst!.payload, twseInst!.ref.dataAsOf ?? '');
const tpexI = normalizeTpexInstitutional(tpexInst!.payload, tpexInst!.ref.dataAsOf ?? '');

console.log('\n--- 解析品質（unparsable 必須為 0）---');
reportStats('上市公司基本資料', twseUni.stats);
reportStats('上櫃公司基本資料', tpexUni.stats);
reportStats('上市行情', twseQ.stats);
reportStats('上櫃行情', tpexQ.stats);
reportStats('上市評價', twseV.stats);
reportStats('上櫃評價', tpexV.stats);
reportStats('上市三大法人', twseI.stats);
reportStats('上櫃三大法人', tpexI.stats);

// ── 標的池 ───────────────────────────────────────────────────────────────────
console.log('\n--- 標的池（以公司名冊為準，非代號正則）---');
const twseUniverse = buildUniverse(twseUni.rows);
const tpexUniverse = buildUniverse(tpexUni.rows);
const all = mergeUniverses(twseUniverse, tpexUniverse);

const twseFiltered = filterToUniverse(twseUniverse, twseQ.rows);
const tpexFiltered = filterToUniverse(tpexUniverse, tpexQ.rows);

console.log(
  `上市：名冊 ${twseUniverse.size} 檔｜行情表 ${twseQ.rows.length} 筆｜` +
    `交集 ${twseFiltered.kept.length}｜排除 ${twseFiltered.excluded}｜` +
    `可交易 ${twseFiltered.kept.filter(isTradable).length}`,
);
console.log(
  `上櫃：名冊 ${tpexUniverse.size} 檔｜行情表 ${tpexQ.rows.length} 筆｜` +
    `交集 ${tpexFiltered.kept.length}｜排除 ${tpexFiltered.excluded}｜` +
    `可交易 ${tpexFiltered.kept.filter(isTradable).length}`,
);
console.log(`合計標的池 ${all.size} 檔\n`);

const nonFourDigit = [...twseUniverse.byCode.keys()].filter((c) => !/^\d{4}$/.test(c));
check(
  '名冊收錄非 4 碼代號（用正則判斷會漏掉的第一上市外國公司）',
  nonFourDigit.length > 0,
  `上市名冊中有 ${nonFourDigit.length} 檔非 4 碼：${nonFourDigit.slice(0, 8).join(', ')}`,
);

check(
  '上櫃行情表大量非公司標的被排除（權證等）',
  tpexFiltered.excluded > 5000,
  `排除 ${tpexFiltered.excluded} 筆（上櫃行情表含大量權證）`,
);

check(
  '名冊中絕大多數有當日行情',
  twseFiltered.kept.length / twseUniverse.size > 0.99 &&
    tpexFiltered.kept.length / tpexUniverse.size > 0.99,
  `上市 ${twseFiltered.kept.length}/${twseUniverse.size}（缺 ${twseFiltered.missingFromData.join(', ') || '無'}）｜` +
    `上櫃 ${tpexFiltered.kept.length}/${tpexUniverse.size}（缺 ${tpexFiltered.missingFromData.join(', ') || '無'}）`,
);

// ── 交叉驗證：法人與評價資料的涵蓋率 ────────────────────────────────────────
const twseInstFiltered = filterToUniverse(twseUniverse, twseI.rows);
const tpexInstFiltered = filterToUniverse(tpexUniverse, tpexI.rows);
const twseValFiltered = filterToUniverse(twseUniverse, twseV.rows);

console.log('\n--- 其他資料對標的池的涵蓋率 ---');
console.log(
  `上市三大法人：${twseInstFiltered.kept.length}/${twseUniverse.size}（原始 ${twseI.rows.length} 列，排除 ${twseInstFiltered.excluded}）`,
);
console.log(
  `上櫃三大法人：${tpexInstFiltered.kept.length}/${tpexUniverse.size}（原始 ${tpexI.rows.length} 列，排除 ${tpexInstFiltered.excluded}）`,
);
console.log(
  `上市評價    ：${twseValFiltered.kept.length}/${twseUniverse.size}（本益比缺值 ${twseV.stats.blank} 個欄位值，虧損公司無本益比屬正常）`,
);

console.log(`\n${'='.repeat(64)}`);
if (failures.length > 0) {
  console.log(`✗ ${failures.length} 項未通過：`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('✓ L1 正規化與標的池驗證通過');
process.exit(0);
