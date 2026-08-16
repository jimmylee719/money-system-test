/**
 * L0 抓取 CLI：`npm run l0:ingest`
 *
 * 真的連線到 TWSE / TPEx，把原始回應 append-only 存到 ./data/raw。
 * 只存不判斷——不做任何資料清洗、篩選或修正。
 */

import path from 'node:path';
import { FileSnapshotStore } from '../src/lib/l0/file-store';
import { createLiveDeps, ingestAll } from '../src/lib/l0/ingest';
import { diffFields } from '../src/lib/l0/snapshot';
import { ALL_SOURCES } from '../src/lib/l0/sources';

const DATA_ROOT = path.resolve(process.cwd(), 'data', 'raw');

const store = new FileSnapshotStore(DATA_ROOT);
const results = await ingestAll(createLiveDeps(), store);

console.log(`\nL0 ingest → ${store.root}\n`);

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
  console.log(`    fetched_at   : ${s.fetchedAt}`);
  console.log(`    content_hash : ${s.contentHash.slice(0, 16)}…`);
  console.log(`    bytes / rows : ${s.contentLength} / ${s.rowCount ?? 'n/a'}`);
  console.log(`    http / ms    : ${s.httpStatus} / ${s.durationMs}  attempt ${s.attempt}`);
  console.log(`    last-modified: ${s.lastModified ?? 'null'}`);

  if (source !== undefined) {
    const drift = diffFields(source.baselineFields, s.observedFields);
    if (drift.added.length > 0 || drift.removed.length > 0) {
      driftDetected += 1;
      console.log(
        `    ⚠ SCHEMA DRIFT  added=[${drift.added.join(', ')}] removed=[${drift.removed.join(', ')}]`,
      );
    }
  }
  if ((s.heterogeneousRowCount ?? 0) > 0) {
    console.log(`    ⚠ 列結構不一致：${s.heterogeneousRowCount} 列`);
  }
  console.log(`    → ${result.bodyPath}`);
}

const manifest = await store.readManifest();
console.log(
  `\nmanifest.jsonl 累計 ${manifest.length} 筆｜本次 ${results.length} 來源，失敗 ${failed}，drift ${driftDetected}\n`,
);

process.exit(failed > 0 ? 1 : 0);
