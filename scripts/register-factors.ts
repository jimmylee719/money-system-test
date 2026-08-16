/**
 * 登記 v1 因子：`npm run factors:register`
 *
 * ⚠️ **這個動作不可逆。** factor_registry 是 append-only，三道鎖已實測：
 * 寫進去就改不掉、刪不掉；檢定失敗只能封存，不得改條件重測。
 *
 * 執行前先印出將要登記的內容並要求確認，避免手滑。
 * 已登記過的因子會回 409，視為「先前已登記」而非錯誤（本腳本可重複執行）。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { createInterface } from 'node:readline/promises';
import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { hashDefinition } from '../src/lib/factors/definition-hash';
import { FACTOR_REGISTRY_TABLE, FactorRegistry } from '../src/lib/factors/registry';
import { FactorValidationError } from '../src/lib/factors/types';
import { Postgrest } from '../src/lib/l0/supabase-store';
import { V1_FACTORS } from '../src/lib/l1/factors/definitions';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

const client = new Postgrest({ url: config.url, apiKey: config.serviceRoleKey });
const reader = {
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
};
const registry = new FactorRegistry(client, reader);

console.log('=== v1 因子登記 ===\n');
console.log('⚠️  factor_registry 為 append-only，登記後定義、門檻、假設方向皆不可更改。');
console.log('⚠️  檢定失敗只能封存，不得改條件重測。\n');

const existing = await registry.list();
const existingKeys = new Set(existing.map((f) => f.factor_key));

for (const factor of V1_FACTORS) {
  const hash = hashDefinition(factor.definition);
  const already = existingKeys.has(factor.factorKey);
  console.log(`${already ? '=' : '+'} ${factor.factorKey}  ${already ? '（已登記）' : ''}`);
  console.log(`    ${factor.displayName}`);
  console.log(`    方向：${factor.hypothesisDirection}｜門檻：t ≥ ${factor.tThreshold}`);
  console.log(`    檢定期間：${factor.testPeriodStart} ~ ${factor.testPeriodEnd}`);
  console.log(`    definition_hash：${hash.slice(0, 16)}…`);
  console.log('');
}

const pending = V1_FACTORS.filter((f) => !existingKeys.has(f.factorKey));
if (pending.length === 0) {
  console.log('全部因子皆已登記，無需動作。');
  process.exit(0);
}

if (process.env['FACTORS_REGISTER_CONFIRM'] !== 'yes') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `即將登記 ${pending.length} 個因子，此動作不可逆。輸入「登記」以繼續：`,
  );
  rl.close();
  if (answer.trim() !== '登記') {
    console.log('已取消，未寫入任何資料。');
    process.exit(1);
  }
}

console.log('');
let ok = 0;
for (const factor of pending) {
  try {
    const { definitionHash } = await registry.register(factor);
    ok += 1;
    console.log(`✓ ${factor.factorKey}  definition_hash=${definitionHash}`);
  } catch (error) {
    if (error instanceof FactorValidationError) {
      console.log(`✗ ${factor.factorKey} 程式端驗證未過：`);
      for (const issue of error.issues) {
        console.log(`    ${issue.field}：${issue.message}`);
      }
    } else {
      console.log(`✗ ${factor.factorKey} 資料庫拒絕：${String(error).slice(0, 300)}`);
    }
  }
}

console.log(`\n登記完成 ${ok}/${pending.length}`);

// 讀回資料庫實際內容複驗，不採信寫入時的回應
const after = await registry.list();
const summary = await registry.trialSummary();
console.log(`\n--- 資料庫實際內容（讀回複驗）---`);
for (const f of after.filter((x) => !x.factor_key.startsWith('probe_'))) {
  console.log(
    `${f.factor_key.padEnd(28)} ${f.hypothesis_direction.padEnd(17)} t≥${f.t_threshold}  ` +
      `登記於 ${f.registered_at}`,
  );
}
console.log(
  `\n試驗次數（DSR 呈報用）：真實因子 ${summary.real_registrations}｜` +
    `探針 ${summary.probe_registrations}｜檢定結果 ${summary.total_tests}`,
);

const registered = new Set(after.map((f) => f.factor_key));
const missing = V1_FACTORS.filter((f) => !registered.has(f.factorKey));
if (missing.length > 0) {
  console.log(`\n✗ 仍有 ${missing.length} 個未登記：${missing.map((f) => f.factorKey).join(', ')}`);
  process.exit(1);
}

// 逐一比對資料庫存的 definition_hash 與程式算出的是否一致
let mismatched = 0;
for (const factor of V1_FACTORS) {
  const stored = after.find((f) => f.factor_key === factor.factorKey);
  const expected = hashDefinition(factor.definition);
  if (stored?.definition_hash !== expected) {
    mismatched += 1;
    console.log(`\n✗ ${factor.factorKey} 的 definition_hash 與程式不符`);
  }
}
if (mismatched > 0) {
  console.log(`\n✗ ${mismatched} 個因子的定義雜湊不符，計算結果將無法寫入`);
  process.exit(1);
}

console.log(`\n✓ 全部 ${V1_FACTORS.length} 個因子已登記，definition_hash 與程式一致`);
console.log(`  ${FACTOR_REGISTRY_TABLE} 現在鎖定了這些定義，計算引擎必須依此執行`);
process.exit(0);
