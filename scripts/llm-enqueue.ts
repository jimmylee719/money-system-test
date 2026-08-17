/**
 * 把當日重大訊息排入 LLM 佇列：
 *   `npm run llm:enqueue`            只看要排哪些（dry-run）
 *   `npm run llm:enqueue -- --write` 實際寫入 llm_queue
 *
 * 【訊號日不從系統時鐘推定】（CLAUDE.md）
 * 任務的 data_as_of 取自 `twse_stock_day_all` 快照自己宣告的交易日——
 * 與 L1 排序用的是同一個日期。用系統時鐘會撞到週末、國定假日與颱風假。
 *
 * 【發言日「晚於訊號日」是正常的，不是前視】
 * 8/14（週五）收盤的行情產生訊號，公司 8/15（週六）發布重大訊息，
 * 這筆訊號最快 8/17（週一）開盤才進場——8/15 的公告在進場前就公開了。
 * 用它來否決不是前視，是本來就該知道的事。
 *
 * 真正要擋的前視是「拿好幾天後才抓到的新聞，回頭否決一筆舊訊號」。
 * 那由下面的同批抓取檢查負責（與 L2 既有的 isSameRun 同一套規則、同一個門檻）：
 * 重大訊息快照必須與行情快照屬於同一次抓取，否則整批不排並如實報告原因。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { Postgrest } from '../src/lib/l0/supabase-store';
import { SupabaseStorageBodyStore } from '../src/lib/l0/supabase-storage';
import { SnapshotLoader, SupabaseLedgerReader } from '../src/lib/l1/loader';
import { fetchGapMs, isSameRun } from '../src/lib/l2/context';
import { parseAnnouncements } from '../src/lib/l2/llm/announce';
import type { Announcement } from '../src/lib/l2/llm/types';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();
const WRITE = process.argv.slice(2).includes('--write');

const loader = new SnapshotLoader(
  new SupabaseLedgerReader(config.url, config.serviceRoleKey),
  new SupabaseStorageBodyStore({ url: config.url, apiKey: config.serviceRoleKey }),
);
const client = new Postgrest({ url: config.url, apiKey: config.serviceRoleKey });

console.log('=== P11 LLM 佇列排入 ===\n');

// ── 訊號日：與 L1 用同一個來源宣告的交易日 ──────────────────────────────────
const quotes = await loader.latest('twse_stock_day_all');
if (quotes === null || quotes.ref.dataAsOf === null) {
  console.log('✗ 取不到 twse_stock_day_all 的交易日，無法決定訊號日。先跑 npm run l0:ingest。');
  process.exit(1);
}
const signalDate = quotes.ref.dataAsOf;
console.log(`訊號日 data_as_of = ${signalDate}（取自 twse_stock_day_all 自身宣告）\n`);

// ── 讀兩市的重大訊息 ────────────────────────────────────────────────────────
const sources = [
  { id: 'mops_twse_material_announcements', market: 'TWSE' },
  { id: 'mops_tpex_material_announcements', market: 'TPEx' },
] as const;

const all: Announcement[] = [];
let parseSkipped = 0;
let staleSources = 0;

for (const source of sources) {
  const snapshot = await loader.latest(source.id);
  if (snapshot === null) {
    console.log(`⚠️ ${source.id}：查無快照，本次略過（不是「今天沒有公告」）`);
    continue;
  }
  // 同批抓取檢查：新聞快照必須與行情快照是同一次抓來的。
  // 不然就是拿後來才抓到的新聞回頭否決舊訊號——那才是真正的前視。
  if (!isSameRun(snapshot.ref, quotes.ref)) {
    staleSources += 1;
    const gapHours = (fetchGapMs(snapshot.ref, quotes.ref) / 3_600_000).toFixed(1);
    console.log(
      `⚠️ ${source.id}：與行情快照相差 ${gapHours} 小時，不屬於同一次抓取，整批不排。\n` +
        '   （拿後來才抓到的新聞回頭否決舊訊號＝前視偏誤。先重跑 npm run l0:ingest。）',
    );
    continue;
  }
  const { items, skipped } = parseAnnouncements(snapshot.payload, source.market, source.id);
  parseSkipped += skipped;
  all.push(...items);
  console.log(
    `${source.id}：data_as_of=${snapshot.ref.dataAsOf ?? '—'}　解析 ${items.length} 則` +
      (skipped > 0 ? `　（${skipped} 則因日期或代號無法解析而略過）` : ''),
  );
}

// ── 唯一要擋的是「排入當下還沒發生」的公告 ─────────────────────────────────
const todayTaipei = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
const future = all.filter((a) => a.speakDate > todayTaipei);
const usable = all.filter((a) => a.speakDate <= todayTaipei);
const afterSignal = usable.filter((a) => a.speakDate > signalDate).length;

console.log(
  `\n合計 ${all.length} 則：可用 ${usable.length} 則` +
    (afterSignal > 0
      ? `（其中 ${afterSignal} 則發言日晚於訊號日 ${signalDate}，那是收盤後／假日發布的新聞，進場前就已公開）`
      : '') +
    (future.length > 0 ? `、發言日晚於今日 ${future.length} 則（尚未發生，不排）` : '') +
    (parseSkipped > 0 ? `、解析失敗 ${parseSkipped} 則` : ''),
);
if (staleSources > 0) {
  console.log(`⚠️ 有 ${staleSources} 個來源因非同批抓取而整批略過。`);
}

// ── 去重：已經在佇列裡的不重排 ─────────────────────────────────────────────
async function existingTaskKeys(): Promise<ReadonlySet<string>> {
  const res = await fetch(
    // 排除 llm:verify 留下的探針列，否則會被算成「已在佇列中」而報錯數字
    `${config.url}/rest/v1/llm_queue?data_as_of=eq.${signalDate}` +
      '&task_key=not.like.__probe*&select=task_key&limit=5000',
    { headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` } },
  );
  if (res.status === 404) {
    console.log('\n✗ 資料庫裡還沒有 llm_queue 這張表。');
    console.log('  請先在 Supabase → SQL Editor 執行 supabase/migrations/0012_llm.sql。');
    process.exit(1);
  }
  if (!res.ok) {
    console.log(`\n✗ 查詢既有任務失敗：HTTP ${res.status}`);
    process.exit(1);
  }
  return new Set(((await res.json()) as { task_key: string }[]).map((r) => r.task_key));
}

const existing = await existingTaskKeys();
const fresh = usable.filter((a) => !existing.has(a.itemKey));
console.log(`其中 ${existing.size} 則已在佇列中，本次新增 ${fresh.length} 則\n`);

if (fresh.length > 0) {
  console.log('── 本次要排入的公告 ────────────────────────────────────────────');
  for (const item of fresh.slice(0, 20)) {
    const subject = item.subject.replace(/\s+/g, ' ').slice(0, 46);
    console.log(`  ${item.market} ${item.code}  ${item.clause.padEnd(7)}  ${subject}`);
  }
  if (fresh.length > 20) {
    console.log(`  …另外 ${fresh.length - 20} 則`);
  }
  console.log('');
}

if (!WRITE) {
  console.log('（dry-run，未寫入任何資料。要實際排入請加 --write）');
  process.exit(0);
}

if (fresh.length === 0) {
  console.log('沒有新任務，不寫入。');
  process.exit(0);
}

const enqueuedAt = new Date().toISOString();
await client.insert(
  'llm_queue',
  fresh.map((a) => ({
    task_key: a.itemKey,
    data_as_of: signalDate,
    source_id: a.sourceId,
    code: a.code,
    market: a.market,
    speak_date: a.speakDate,
    clause: a.clause,
    subject: a.subject,
    detail: a.detail,
    content_hash: a.contentHash,
    enqueued_at: enqueuedAt,
  })),
);
console.log(`✓ 已排入 ${fresh.length} 則任務。`);
console.log('  下一步：npm run llm:worker -- --write（需要本機 Ollama / LM Studio 已啟動）');
process.exit(0);
