/**
 * append-only 三道鎖的實測驗證：`npm run l0:verify`
 *
 * 走的是應用程式真正會走的路徑（PostgREST + service_role / anon key），
 * 不是在資料庫裡自說自話。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 * ⚠️ 探針資料寫進去就刪不掉 —— 那正是 append-only 生效的證明。
 *    探針一律使用 source_id = '__append_only_probe__'，不會與真實來源混淆。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { RAW_SNAPSHOTS_TABLE, SOURCE_HEALTH_TABLE } from '../src/lib/l0/supabase-store';

loadEnvFileIfPresent();

const PROBE_SOURCE_ID = '__append_only_probe__';
const config = loadSupabaseConfig();

interface Check {
  readonly name: string;
  readonly expectation: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function headers(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function call(
  key: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${config.url}/rest/v1/${path}`, {
    method,
    headers: headers(key, extraHeaders),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, text: (await res.text()).slice(0, 400) };
}

function record(name: string, expectation: string, passed: boolean, detail: string): void {
  checks.push({ name, expectation, passed, detail });
  console.log(`${passed ? '✓' : '✗'} ${name}`);
  console.log(`    預期：${expectation}`);
  console.log(`    實際：${detail}\n`);
}

const probeRow = {
  source_id: PROBE_SOURCE_ID,
  url: 'https://example.invalid/probe',
  market: 'TWSE',
  source_tier: 'official_primary',
  data_as_of: null,
  data_as_of_reason: 'invalid_json',
  data_period: null,
  fetched_at: new Date().toISOString(),
  content_hash: '0'.repeat(64),
  content_length: 0,
  body_store: 'file',
  body_path: null,
  observed_fields: [],
  observed_data_dates: [],
  observed_data_periods: [],
  row_count: null,
  heterogeneous_row_count: null,
  http_status: 200,
  etag: null,
  last_modified: null,
  duration_ms: 0,
  attempt: 1,
};

console.log('=== append-only 三道鎖實測驗證 ===');
console.log(`目標：${config.url}\n`);

// ── 1. service_role 應該寫得進去（否則抓取管線根本不能運作） ───────────────────
const inserted = await call(
  config.serviceRoleKey,
  'POST',
  RAW_SNAPSHOTS_TABLE,
  [probeRow],
  { Prefer: 'return=representation' },
);
record(
  'service_role INSERT',
  'HTTP 201（寫入必須可行）',
  inserted.status === 201,
  `HTTP ${inserted.status} ${inserted.status === 201 ? '' : inserted.text}`,
);

let probeId: number | null = null;
try {
  const parsed: unknown = JSON.parse(inserted.text);
  if (Array.isArray(parsed) && typeof (parsed[0] as { id?: unknown } | undefined)?.id === 'number') {
    probeId = (parsed[0] as { id: number }).id;
  }
} catch {
  probeId = null;
}
console.log(`探針 id = ${probeId ?? '（取不到，後續改用 source_id 篩選）'}\n`);

const filter = probeId === null ? `source_id=eq.${PROBE_SOURCE_ID}` : `id=eq.${probeId}`;

// ── 2. service_role 改不動 ────────────────────────────────────────────────────
const updated = await call(config.serviceRoleKey, 'PATCH', `${RAW_SNAPSHOTS_TABLE}?${filter}`, {
  url: 'TAMPERED',
});
record(
  'service_role UPDATE',
  '被拒絕（4xx）',
  updated.status >= 400,
  `HTTP ${updated.status} ${updated.text}`,
);

// ── 3. service_role 刪不掉 ────────────────────────────────────────────────────
const deleted = await call(config.serviceRoleKey, 'DELETE', `${RAW_SNAPSHOTS_TABLE}?${filter}`);
record(
  'service_role DELETE',
  '被拒絕（4xx）',
  deleted.status >= 400,
  `HTTP ${deleted.status} ${deleted.text}`,
);

// ── 4. source_health 同樣鎖死 ─────────────────────────────────────────────────
const healthUpdate = await call(
  config.serviceRoleKey,
  'PATCH',
  `${SOURCE_HEALTH_TABLE}?source_id=eq.${PROBE_SOURCE_ID}`,
  { status: 'ok' },
);
record(
  'service_role UPDATE source_health',
  '被拒絕（4xx）',
  healthUpdate.status >= 400,
  `HTTP ${healthUpdate.status} ${healthUpdate.text}`,
);

// ── 5. 匿名身分寫不進去 ───────────────────────────────────────────────────────
if (config.anonKey === null) {
  console.log('⚠ 未提供 anon key，略過匿名身分測試\n');
} else {
  const anonInsert = await call(config.anonKey, 'POST', RAW_SNAPSHOTS_TABLE, [probeRow]);
  record(
    'anon INSERT',
    '被拒絕（4xx）',
    anonInsert.status >= 400,
    `HTTP ${anonInsert.status} ${anonInsert.text}`,
  );

  const anonSelect = await call(
    config.anonKey,
    'GET',
    `${RAW_SNAPSHOTS_TABLE}?select=id&limit=1`,
  );
  record(
    'anon SELECT',
    'HTTP 200（讀取應開放）',
    anonSelect.status === 200,
    `HTTP ${anonSelect.status}`,
  );

  const anonDelete = await call(
    config.anonKey,
    'DELETE',
    `${RAW_SNAPSHOTS_TABLE}?source_id=eq.${PROBE_SOURCE_ID}`,
  );
  record(
    'anon DELETE',
    '被拒絕（4xx）',
    anonDelete.status >= 400,
    `HTTP ${anonDelete.status} ${anonDelete.text}`,
  );
}

// ── 6. 讀回鎖三（觸發器）在 SQL Editor 的驗證結果 ─────────────────────────────
const triggerProbe = await call(
  config.serviceRoleKey,
  'GET',
  `${SOURCE_HEALTH_TABLE}?source_id=eq.__trigger_probe__&select=observed_at,row_count,heterogeneous_row_count,error&order=observed_at.desc&limit=1`,
);
if (triggerProbe.status === 200 && triggerProbe.text !== '[]') {
  console.log('--- 鎖三（觸發器）在 SQL Editor 的驗證結果 ---');
  console.log(`    ${triggerProbe.text}\n`);
} else {
  console.log('--- 鎖三（觸發器）---');
  console.log('    尚未執行 supabase/verify/verify_triggers.sql，鎖三仍未獨立驗證。\n');
}

// ── 總結 ─────────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.passed);
console.log('='.repeat(60));
console.log(`共 ${checks.length} 項檢查，通過 ${checks.length - failed.length}，失敗 ${failed.length}`);
if (failed.length > 0) {
  console.log('\n失敗項目：');
  for (const c of failed) {
    console.log(`  ✗ ${c.name}：${c.detail}`);
  }
}
process.exit(failed.length > 0 ? 1 : 0);
