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

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { hasSupabaseConfig, loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { FileSnapshotStore } from '../src/lib/l0/file-store';
import { createLiveDeps, ingestAll } from '../src/lib/l0/ingest';
import { ALL_SOURCES } from '../src/lib/l0/sources';
import { SupabaseStorageBodyStore } from '../src/lib/l0/supabase-storage';
import { Postgrest, SupabaseSnapshotStore } from '../src/lib/l0/supabase-store';
import type { SnapshotStore } from '../src/lib/l0/types';

loadEnvFileIfPresent();

const DATA_ROOT = path.resolve(process.cwd(), process.env['L0_DATA_ROOT'] ?? './data/raw');
const fileStore = new FileSnapshotStore(DATA_ROOT);

/** CI 的檔案系統是拋棄式的，本機 manifest 沒有意義也留不住 */
const isCI = process.env['CI'] === 'true';

let store: SnapshotStore = fileStore;
let bodyLabel = fileStore.root;
let ledgerLabel = '本機 manifest.jsonl（未設定 Supabase）';

if (hasSupabaseConfig()) {
  const config = loadSupabaseConfig();
  const bodyStore = new SupabaseStorageBodyStore({
    url: config.url,
    apiKey: config.serviceRoleKey,
  });
  store = new SupabaseSnapshotStore(
    bodyStore,
    new Postgrest({ url: config.url, apiKey: config.serviceRoleKey }),
    isCI ? null : fileStore,
  );
  bodyLabel = `Supabase Storage bucket「${bodyStore.bucket}」（gzip 壓縮）`;
  ledgerLabel = isCI
    ? `Supabase raw_snapshots / source_health（CI：不留本機 manifest）`
    : `Supabase raw_snapshots / source_health + 本機 manifest.jsonl`;
}

console.log(`\nL0 ingest`);
console.log(`  原始 bytes : ${bodyLabel}`);
console.log(`  帳本       : ${ledgerLabel}\n`);

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

const manifest = await store.readManifest();
console.log(
  `\n本次 ${results.length} 來源，失敗 ${failed}，drift ${driftDetected}` +
    (manifest.length > 0 ? `｜本機 manifest 累計 ${manifest.length} 筆` : '') +
    '\n',
);

// ── 執行紀錄 ─────────────────────────────────────────────────────────────────
// 進版控，一次執行一行。兩個用途：
//   1. G5「資料管線連續 60 日零故障」的證據鏈，人與程式都查得到
//   2. 產生 repository activity —— GitHub 官方明示 public repo 若 60 天無活動
//      會自動停用排程，那正好會讓 G5 永遠達不成
const logLine = `${JSON.stringify({
  ran_at: new Date().toISOString(),
  sources: results.length,
  stored: results.filter((r) => r.status === 'stored').length,
  duplicate: results.filter((r) => r.status === 'duplicate').length,
  failed,
  drift: driftDetected,
  data_as_of: [...new Set(results.map((r) => r.snapshot?.dataAsOf).filter(Boolean))].sort(),
})}\n`;

const LOG_PATH = path.resolve(process.cwd(), 'ops', 'ingest-log.jsonl');
await mkdir(path.dirname(LOG_PATH), { recursive: true });
await appendFile(LOG_PATH, logLine, 'utf8');
console.log(`執行紀錄已追加：${LOG_PATH}\n`);

process.exit(failed > 0 ? 1 : 0);
