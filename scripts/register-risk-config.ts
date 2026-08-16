/**
 * 登記風控設定：`npm run l3:register`
 *
 * ⚠️ **這個動作不可逆。** risk_config 是 append-only：寫進去就改不掉、刪不掉。
 *    要調整任何數字，必須換一個 version 重新登記，兩份都會永久留存。
 *
 * 執行前列出全部數字並要求確認。設 RISK_REGISTER_CONFIRM=yes 可略過互動確認。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { createInterface } from 'node:readline/promises';
import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { Postgrest } from '../src/lib/l0/supabase-store';
import { ACTIVE_RISK_CONFIG, validateRiskConfig } from '../src/lib/l3/config';
import { hashRiskConfig } from '../src/lib/l3/lock';
import type { RegisteredRiskConfig } from '../src/lib/l3/lock';

const RATIONALE =
  'v2 風控設定，2026-08-16 修訂，仍在看到任何一筆損益之前。' +
  '相對 v1 改四項：(1) equityTwd 100 萬→1 萬，使用者實際資金為 1–3 萬，取下限較安全，' +
  '低估資金會讓部位偏小、高估則會讓每筆風險超出真實資金比例；' +
  '(2) riskPerTradePct 1%→2%，CLAUDE.md 允許 1%–2%，小資金應取上限：' +
  '買賣各 20 元的最低手續費是固定成本，部位越小稀釋越嚴重，' +
  '實測 1 萬×1% 的實際賠率僅 0.76:1（負期望），1 萬×2% 為 1.33:1；' +
  '(3) lotSize 1000→1 允許零股，CLAUDE.md 禁止的是零股沖銷而非零股買進，' +
  'v1 的整張限制是自加的且在小資金下使多數標的無法交易；' +
  '(4) maxConcurrentPositions 5→3、monthlyEntryCap 10→6，' +
  '因 r 加倍需維持「同時全數停損」損失遠低於熔斷門檻（3×2%=6% ≪ 15%）。' +
  '另修正部位公式：改為反解「名目風險＋來回成本 ≤ 預算」的最大股數，' +
  'v1 僅用名目風險反解，停損實際虧損每次都超出預算（實測 10 萬本金超出 6%），' +
  'r 因此不是真正的硬上限。並新增規則：扣成本後停利實得須大於停損實虧（賠率>1:1），' +
  '因目前無任何證據宣稱勝率高於 50%，賠率低於 1:1 即為負期望。' +
  '其餘（volEwmSpan=100 採 AFML getDailyVol 預設、volMinObservations=20、' +
  'holdingDays=10 為兩週交易日數、stopSigmaMultiple=2、takeProfitR=2 為 CLAUDE.md 下限、' +
  'maxSinglePositionPct=20、maxTotalExposurePct=60、circuitBreakerDrawdownPct=15、' +
  'broker 用無折讓最壞情況）維持 v1 推導不變。' +
  '使用者實際放 3 萬時須登記 risk-v3，不得沿用本版本。';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();
const client = new Postgrest({ url: config.url, apiKey: config.serviceRoleKey });

async function select<T>(pathAndQuery: string): Promise<readonly T[]> {
  const res = await fetch(`${config.url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`查詢失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as readonly T[];
}

console.log('=== 風控設定登記 ===\n');
console.log('⚠️  risk_config 為 append-only，登記後不可修改或刪除。');
console.log('⚠️  要改任何數字必須換 version 重新登記，兩份都會永久留存。\n');

const issues = validateRiskConfig(ACTIVE_RISK_CONFIG);
if (issues.length > 0) {
  console.log('✗ 設定本身未通過健全性檢查：');
  for (const i of issues) console.log(`  - ${i}`);
  process.exit(1);
}

const hash = hashRiskConfig(ACTIVE_RISK_CONFIG);
const c = ACTIVE_RISK_CONFIG;

console.log(`version           ${c.version}`);
console.log(`config_hash       ${hash}\n`);
console.log(`總資金            ${c.equityTwd.toLocaleString()} 元　（假設值，日後可換版本調整）`);
console.log(`每筆風險 r        ${c.riskPerTradePct}%　→ 每筆最多虧 ${((c.equityTwd * c.riskPerTradePct) / 100).toLocaleString()} 元`);
console.log(`波動率            EWM span=${c.volEwmSpan}，最少 ${c.volMinObservations} 個交易日`);
console.log(`停損 1R           ${c.stopSigmaMultiple}σ × √${c.holdingDays}`);
console.log(`停利              ${c.takeProfitR}R`);
console.log(`時間出場          ${c.holdingDays} 個交易日`);
console.log(`同時部位上限      ${c.maxConcurrentPositions} 檔　→ 全數停損 ${c.maxConcurrentPositions * c.riskPerTradePct}%`);
console.log(`每月進場上限      ${c.monthlyEntryCap} 筆`);
console.log(`單一部位上限      ${c.maxSinglePositionPct}%`);
console.log(`總曝險上限        ${c.maxTotalExposurePct}%`);
console.log(`熔斷門檻          回撤 ${c.circuitBreakerDrawdownPct}%`);
console.log(`手續費            ${c.broker.commissionRatePpm} ppm，折讓 ${c.broker.discountBps / 100}%（無折讓＝最壞情況），最低 ${c.broker.minCommissionTwd} 元\n`);

const existing = await select<RegisteredRiskConfig>('risk_config?select=*');
const already = existing.find((r) => r.version === c.version);
if (already !== undefined) {
  if (already.config_hash === hash) {
    console.log(`= ${c.version} 已登記且雜湊一致，無需動作。`);
    process.exit(0);
  }
  console.log(`✗ ${c.version} 已登記，但雜湊不同：`);
  console.log(`    登記=${already.config_hash}`);
  console.log(`    程式=${hash}`);
  console.log('  append-only 不允許覆蓋。要用新設定請把 version 改成 risk-v2。');
  process.exit(1);
}

if (process.env['RISK_REGISTER_CONFIRM'] !== 'yes') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('確認登記？輸入 yes 繼續：');
  rl.close();
  if (answer.trim() !== 'yes') {
    console.log('已取消，未寫入任何資料。');
    process.exit(1);
  }
}

await client.insert('risk_config', [
  {
    version: c.version,
    config: c,
    config_hash: hash,
    rationale: RATIONALE,
    registered_by: 'jimmy',
    // 刻意不送 registered_at —— 資料庫沒有給應用程式該欄位的 INSERT 權限
  },
]);

const readBack = await select<RegisteredRiskConfig>(
  `risk_config?version=eq.${encodeURIComponent(c.version)}&select=*`,
);
const row = readBack[0];
if (row === undefined || row.config_hash !== hash) {
  console.log('✗ 寫入後讀回複驗失敗，雜湊不符。');
  process.exit(1);
}

console.log(`\n✓ 已登記 ${c.version}，讀回複驗雜湊一致：${row.config_hash.slice(0, 16)}…`);
console.log(`  登記時點由資料庫蓋章：${row.registered_at}`);
console.log('  此後不可修改或刪除。');
process.exit(0);
