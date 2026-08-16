/**
 * schema drift 偵測的端對端驗證：`npm run l0:verify-drift`
 *
 * 抓真實端點，但故意在註冊表基準欄位裡塞一個官方不存在的欄位，
 * 檢查整條鏈（抓取 → 比對 → 落地 source_health）是否確實把 drift 記錄下來。
 *
 * 沒有這支，drift 只有單元測試，「真的接上資料庫時會不會記錄」仍是未驗證的假設。
 *
 * 使用 source_id = '__drift_probe__'，不與真實來源混淆。
 * 探針資料寫入後無法刪除 —— append-only 的必然結果。
 */

import path from 'node:path';
import { hasSupabaseConfig, loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { FileSnapshotStore } from '../src/lib/l0/file-store';
import { createLiveDeps, ingestSource } from '../src/lib/l0/ingest';
import { TAIFEX_PUT_CALL_RATIO } from '../src/lib/l0/sources';
import { Postgrest, SupabaseSnapshotStore } from '../src/lib/l0/supabase-store';
import type { SnapshotStore, SourceDescriptor, SourceId } from '../src/lib/l0/types';

loadEnvFileIfPresent();

const PHANTOM_FIELD = 'ColumnThatOfficialApiDoesNotHave';

/** 挑最小的端點（約 3.5 KB），避免為了驗證而重複下載大檔 */
const driftSource: SourceDescriptor = {
  ...TAIFEX_PUT_CALL_RATIO,
  id: '__drift_probe__' as SourceId,
  baselineFields: [...TAIFEX_PUT_CALL_RATIO.baselineFields, PHANTOM_FIELD],
};

const fileStore = new FileSnapshotStore(
  path.resolve(process.cwd(), process.env['L0_DATA_ROOT'] ?? './data/raw'),
);

let store: SnapshotStore = fileStore;
let config: ReturnType<typeof loadSupabaseConfig> | null = null;
if (hasSupabaseConfig()) {
  config = loadSupabaseConfig();
  // drift 驗證只關心 source_health 的落地，bytes 留本機即可
  store = new SupabaseSnapshotStore(
    fileStore,
    new Postgrest({ url: config.url, apiKey: config.serviceRoleKey }),
    fileStore,
  );
}

console.log('=== schema drift 端對端驗證 ===');
console.log(`基準欄位刻意多加一個不存在的欄位：${PHANTOM_FIELD}\n`);

const result = await ingestSource(driftSource, createLiveDeps(), store);
const entry = (await fileStore.readManifest()).at(-1);

const failures: string[] = [];

console.log(`抓取結果      : ${result.status}`);
if (result.status === 'failed') {
  failures.push(`抓取失敗：${result.error ?? 'unknown'}`);
}

console.log(`fieldsRemoved : ${JSON.stringify(entry?.fieldsRemoved)}`);
if (entry?.fieldsRemoved.includes(PHANTOM_FIELD) !== true) {
  failures.push(`fieldsRemoved 未包含 ${PHANTOM_FIELD}`);
}

console.log(`fieldsAdded   : ${JSON.stringify(entry?.fieldsAdded)}`);
if ((entry?.fieldsAdded.length ?? -1) !== 0) {
  failures.push('fieldsAdded 應為空（官方沒有多出欄位）');
}

if (config === null) {
  console.log('\n⚠ 未設定 Supabase，略過資料庫落地驗證');
} else {
  const res = await fetch(
    `${config.url}/rest/v1/source_health` +
      '?source_id=eq.__drift_probe__' +
      '&select=source_id,status,fields_added,fields_removed' +
      '&order=id.desc&limit=1',
    {
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const text = await res.text();
  console.log('\nsource_health 實際寫入內容：');
  console.log(` ${text}`);

  if (!text.includes('"status":"schema_drift"')) {
    failures.push('source_health 的 status 不是 schema_drift');
  }
  if (!text.includes(PHANTOM_FIELD)) {
    failures.push('source_health 的 fields_removed 未記錄消失的欄位');
  }
}

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log('✓ drift 偵測整條鏈驗證通過');
  process.exit(0);
}
console.log('✗ drift 偵測驗證失敗：');
for (const f of failures) {
  console.log(`  - ${f}`);
}
process.exit(1);
