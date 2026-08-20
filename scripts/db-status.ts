/**
 * 檢查每一個 migration 到底有沒有跑過：`npm run db:status`
 *
 * 【為什麼需要這支】
 * 2026-08-20 使用者問「我的紀錄只跑到 0011」，但資料庫裡明明讀得到 0012 才建的
 * gold_set / llm_queue / llm_results。人工紀錄和實際狀態對不上，
 * 而在此之前**沒有任何辦法查證**——只能靠回想，或等到寫入失敗才發現。
 *
 * 這支不看任何紀錄，直接問資料庫本身：
 *   表在不在（select limit 0 → PGRST205 代表沒有這張表）
 *   欄位在不在（select 該欄位 → 42703 代表沒有這個欄位）
 *   Storage bucket 在不在
 *
 * 【三個 migration 無法從外部偵測，會如實標示】
 * 0003 是純權限（欄位級 GRANT），REST 讀不到權限表；
 * 0004 除了 bucket 之外還有 constraint；
 * 鎖有沒有真的鎖上一律由 `npm run l0:verify` 等驗證指令負責。
 * **查得到表，不等於鎖是對的。** 這支只回答「跑了沒」，不回答「鎖對了沒」。
 *
 * ⚠️ 本程式唯讀，不寫入任何資料，也不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

const headers = {
  apikey: config.serviceRoleKey,
  Authorization: `Bearer ${config.serviceRoleKey}`,
};

type ProbeResult = { ok: boolean; detail: string };

/** 表在不在。limit=0 不取任何列，只看伺服器認不認得這個名字。 */
async function probeTable(table: string): Promise<ProbeResult> {
  const res = await fetch(`${config.url}/rest/v1/${table}?select=*&limit=0`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) {
    return { ok: true, detail: `表 ${table}` };
  }
  const body = await res.text();
  // PGRST205 = 找不到這張表
  if (res.status === 404 || body.includes('PGRST205')) {
    return { ok: false, detail: `表 ${table} 不存在` };
  }
  return { ok: false, detail: `表 ${table} 查詢異常 HTTP ${res.status}` };
}

/** 欄位在不在。42703 = undefined_column。 */
async function probeColumn(table: string, column: string): Promise<ProbeResult> {
  const res = await fetch(`${config.url}/rest/v1/${table}?select=${column}&limit=0`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) {
    return { ok: true, detail: `${table}.${column}` };
  }
  const body = await res.text();
  if (body.includes('42703')) {
    return { ok: false, detail: `${table}.${column} 欄位不存在` };
  }
  if (res.status === 404 || body.includes('PGRST205')) {
    return { ok: false, detail: `${table} 這張表都還沒建` };
  }
  return { ok: false, detail: `${table}.${column} 查詢異常 HTTP ${res.status}` };
}

/** Storage bucket 在不在。 */
async function probeBucket(bucket: string): Promise<ProbeResult> {
  const res = await fetch(`${config.url}/storage/v1/bucket/${bucket}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  return res.ok
    ? { ok: true, detail: `bucket ${bucket}` }
    : { ok: false, detail: `bucket ${bucket} 不存在（HTTP ${res.status}）` };
}

interface Migration {
  readonly file: string;
  readonly what: string;
  readonly probes: readonly (() => Promise<ProbeResult>)[];
  /** 無法從外部偵測時寫這裡，會如實標示而不是猜一個結果 */
  readonly undetectable?: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    file: '0001_l0_append_only',
    what: 'L0 原始快照與來源健康度',
    probes: [() => probeTable('raw_snapshots'), () => probeTable('source_health')],
  },
  {
    file: '0002_factor_registry',
    what: '因子預先登記',
    probes: [
      () => probeTable('factor_registry'),
      () => probeTable('factor_status_events'),
      () => probeTable('factor_test_results'),
    ],
  },
  {
    file: '0003_restrict_insert_columns',
    what: '欄位級 INSERT 權限收斂',
    probes: [],
    undetectable: '純權限變更，REST 讀不到權限表。請用 npm run l0:verify 與 factors:verify 驗證。',
  },
  {
    file: '0004_l0_body_storage',
    what: '原始 bytes 改存 Storage',
    probes: [() => probeBucket('l0-raw')],
  },
  {
    file: '0005_body_bytes',
    what: 'raw_snapshots 記錄原始大小',
    probes: [() => probeColumn('raw_snapshots', 'body_bytes')],
  },
  { file: '0006_daily_picks', what: '每日清單', probes: [() => probeTable('daily_picks')] },
  { file: '0007_veto_events', what: 'L2 否決紀錄', probes: [() => probeTable('veto_events')] },
  {
    file: '0008_risk_config_and_trade_signals',
    what: 'L3 風控設定與交易訊號欄位',
    probes: [() => probeTable('risk_config'), () => probeColumn('daily_picks', 'entry_price')],
  },
  { file: '0009_user_records', what: '你的紀錄（/rec）', probes: [() => probeTable('user_records')] },
  { file: '0010_outcomes', what: 'T+5／T+10／T+20 績效', probes: [() => probeTable('outcomes')] },
  {
    file: '0011_benchmark_daily',
    what: '0050 基準（G3）',
    probes: [() => probeTable('benchmark_daily')],
  },
  {
    file: '0012_llm',
    what: 'P11 本機 LLM 否決層四張表',
    probes: [
      () => probeTable('llm_queue'),
      () => probeTable('llm_results'),
      () => probeTable('gold_set'),
      () => probeTable('model_registry'),
    ],
  },
  {
    file: '0013_daily_picks_quote',
    what: '清單留存當日漲跌與成交量',
    probes: [
      () => probeColumn('daily_picks', 'change_amount'),
      () => probeColumn('daily_picks', 'volume_shares'),
    ],
  },
  {
    file: '0014_veto_margin_suspension',
    what: 'L2 允許停資停券否決規則',
    probes: [],
    undetectable:
      'check constraint 的內容 REST 讀不到。驗證方式：npm run l2:verify，' +
      '或直接跑 npm run l1:picks -- --write（含停資停券否決時會寫入 veto_events）。',
  },
];

console.log('=== migration 執行狀態（直接問資料庫，不看任何紀錄）===\n');
console.log(`專案　${new URL(config.url).hostname}\n`);

let pending = 0;
let partial = 0;

for (const m of MIGRATIONS) {
  if (m.undetectable !== undefined) {
    console.log(`?  ${m.file.padEnd(36)} ${m.what}`);
    console.log(`   ↳ 無法偵測：${m.undetectable}`);
    continue;
  }

  const results = await Promise.all(m.probes.map((p) => p()));
  const passed = results.filter((r) => r.ok).length;

  if (passed === results.length) {
    console.log(`✓  ${m.file.padEnd(36)} ${m.what}`);
    continue;
  }

  // 部分通過最危險：看起來跑過了，其實少一半。要單獨標出來。
  if (passed > 0) {
    partial += 1;
    console.log(`⚠  ${m.file.padEnd(36)} ${m.what}　—— 只跑了一部分（${passed}/${results.length}）`);
  } else {
    pending += 1;
    console.log(`✗  ${m.file.padEnd(36)} ${m.what}　—— 尚未執行`);
  }
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`   ↳ ${r.detail}`);
  }
}

console.log('');
if (partial > 0) {
  console.log(`⚠️ 有 ${partial} 個 migration 只跑了一部分。`);
  console.log('   那通常代表 SQL 中途出錯而前半段已生效 —— 重跑整份即可（都寫成可重複執行）。');
}
if (pending > 0) {
  console.log(`✗ 有 ${pending} 個 migration 尚未執行。`);
  console.log('  Supabase Dashboard → SQL Editor → 貼上該檔全文 → Run。');
}
if (pending === 0 && partial === 0) {
  console.log('✓ 所有可偵測的 migration 都已執行。');
}

console.log('');
console.log('⚠️ 本檢查只回答「跑了沒」，不回答「三道鎖對不對」。');
console.log('   鎖的正確性請跑：npm run l0:verify、l1:verify-picks、l2:verify、');
console.log('   l3:verify、l4:verify、l5:verify、llm:verify、factors:verify');
process.exit(pending > 0 || partial > 0 ? 1 : 0);
