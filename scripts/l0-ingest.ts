/**
 * L0 抓取 CLI：`npm run l0:ingest`
 *
 * 真的連線到 TWSE / TPEx / TAIFEX，把原始回應 append-only 存下來。
 * 只存不判斷——不做任何資料清洗、篩選或修正。
 *
 * 儲存位置：
 *   原始 bytes  → 一律落地到 ./data/raw（內容定址，日後可搬 Cloudflare R2）
 *   帳本／健康度 → 若 .env.local 有 Supabase 設定則寫入資料庫，否則只留本機 manifest
 */

import path from 'node:path';
import { hasSupabaseConfig, loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { FileSnapshotStore } from '../src/lib/l0/file-store';
import { createLiveDeps, ingestAll } from '../src/lib/l0/ingest';
import { ALL_SOURCES } from '../src/lib/l0/sources';
import { Postgrest, SupabaseSnapshotStore } from '../src/lib/l0/supabase-store';
import type { SnapshotStore } from '../src/lib/l0/types';

loadEnvFileIfPresent();

const DATA_ROOT = path.resolve(process.cwd(), process.env['L0_DATA_ROOT'] ?? './data/raw');
const fileStore = new FileSnapshotStore(DATA_ROOT);

let store: SnapshotStore = fileStore;
let storeLabel = '本機檔案（未設定 Supabase）';

if (hasSupabaseConfig()) {
  const config = loadSupabaseConfig();
  store = new SupabaseSnapshotStore(
    fileStore,
    new Postgrest({ url: config.url, apiKey: config.serviceRoleKey }),
    'file',
  );
  storeLabel = `本機檔案 + Supabase 帳本（${config.url}）`;
}

console.log(`\nL0 ingest`);
console.log(`  原始 bytes : ${fileStore.root}`);
console.log(`  帳本       : ${storeLabel}\n`);

const results = await ingestAll(createLiveDeps(), store);

let failed = 0;
let driftDetected = 0;

for (const result of results) {
  const source = ALL_SOURCES.find((s) => s.id === result.sourceId);
  if (result.status === 'failed' || result.snapshot === null) {
    failed += 1;
    console.log(`✗ ${result.sourceId}\n    error: ${result.error ?? 'unknown'}`);
    continue;
  }

  const s = result.snapshot;
  console.log(`${result.status === 'stored' ? '✓' : '=' } ${s.sourceId}  [${result.status}]`);
  console.log(`    data_as_of   : ${s.dataAsOf ?? 'null'}  (${s.dataAsOfReason})`);
  if (s.dataPeriod !== null) {
    console.log(`    data_period  : ${s.dataPeriod}`);
  }
  console.log(`    fetched_at   : ${s.fetchedAt}`);
  console.log(`    content_hash : ${s.contentHash.slice(0, 16)}…`);
  console.log(`    bytes / rows : ${s.contentLength} / ${s.rowCount ?? 'n/a'}`);
  console.log(`    http / ms    : ${s.httpStatus} / ${s.durationMs}  attempt ${s.attempt}`);

  if (source !== undefined) {
    const added = s.observedFields?.filter((f) => !source.baselineFields.includes(f)) ?? [];
    const removed = source.baselineFields.filter((f) => !(s.observedFields ?? []).includes(f));
    if (added.length > 0 || removed.length > 0) {
      driftDetected += 1;
      console.log(`    ⚠ SCHEMA DRIFT  added=[${added.join(', ')}] removed=[${removed.join(', ')}]`);
    }
  }
  if ((s.heterogeneousRowCount ?? 0) > 0) {
    console.log(`    ⚠ 列結構不一致：${s.heterogeneousRowCount} 列`);
  }
}

const manifest = await fileStore.readManifest();
console.log(
  `\nmanifest.jsonl 累計 ${manifest.length} 筆｜本次 ${results.length} 來源，失敗 ${failed}，drift ${driftDetected}\n`,
);

process.exit(failed > 0 ? 1 : 0);
