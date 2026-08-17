/**
 * gold_set 標註流程：
 *   `npm run llm:gold -- --export`              產生待標註的 Excel 檔
 *   `npm run llm:gold -- --import <檔案>`        檢查標註內容（dry-run）
 *   `npm run llm:gold -- --import <檔案> --write` 實際寫入 gold_set
 *
 * 【為什麼一定要人來標】
 * gold_set 是模型的考卷。讓模型標自己的考卷，考幾分都沒有意義。
 * 所以這裡只提供「把題目倒出來」與「把答案收回去」，中間那段必須是人做的。
 *
 * 【匯出的 Excel 只是標註介面，不是資料來源】
 * 說明欄很長，Excel 裡會被截斷顯示；寫入 gold_set 時**用的是資料庫裡的完整原文**，
 * 以 item_key 對回去。所以在 Excel 裡不小心改到主旨或說明，不會污染標準答案。
 * 匯入時只讀兩欄：label 與 label_reason。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';

import ExcelJS from 'exceljs';

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { Postgrest } from '../src/lib/l0/supabase-store';
import { contentKeyIgnoringDate } from '../src/lib/l2/llm/announce';
import { MIN_GOLD_SAMPLE } from '../src/lib/l2/llm/gold';

const FONT = { name: 'Arial', size: 10 } as const;

const args = process.argv.slice(2);
const EXPORT = args.includes('--export');
const IMPORT_AT = args.indexOf('--import');
const WRITE = args.includes('--write');
const LIMIT = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '60');

/** 找 gold/ 裡最新的待標註檔。讓每天的指令固定不變，不用手打日期。 */
function newestPendingFile(): string | undefined {
  if (!existsSync('gold')) return undefined;
  const files = readdirSync('gold')
    .filter((f) => f.startsWith('pending-') && f.endsWith('.xlsx'))
    .sort();
  const last = files[files.length - 1];
  return last === undefined ? undefined : `gold/${last}`;
}

/** --import 後面沒接路徑（或接的是別的選項）時，自動用最新的那個檔 */
const IMPORT_ARG = IMPORT_AT >= 0 ? args[IMPORT_AT + 1] : undefined;
const IMPORT_PATH =
  IMPORT_AT < 0
    ? undefined
    : IMPORT_ARG !== undefined && !IMPORT_ARG.startsWith('--')
      ? IMPORT_ARG
      : newestPendingFile();

if (!EXPORT && IMPORT_AT < 0) {
  console.log('用法：');
  console.log('  npm run llm:gold -- --export');
  console.log('  npm run llm:gold -- --import          （自動用 gold/ 裡最新的檔，dry-run）');
  console.log('  npm run llm:gold -- --import --write   （自動用最新的檔並寫入）');
  console.log('  npm run llm:gold -- --import gold/pending-2026-08-17.xlsx --write');
  process.exit(1);
}
if (IMPORT_AT >= 0 && IMPORT_PATH === undefined) {
  console.log('✗ gold/ 裡找不到任何 pending-*.xlsx。先跑：npm run llm:gold -- --export');
  process.exit(1);
}

loadEnvFileIfPresent();
const config = loadSupabaseConfig();
const client = new Postgrest({ url: config.url, apiKey: config.serviceRoleKey });

async function select<T>(pathAndQuery: string): Promise<readonly T[]> {
  const res = await fetch(`${config.url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`查詢失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as readonly T[];
}

interface QueueRow {
  readonly task_key: string;
  readonly source_id: string;
  readonly code: string;
  readonly market: string;
  readonly speak_date: string;
  readonly clause: string;
  readonly subject: string;
  readonly detail: string;
  readonly content_hash: string;
}

// ── 匯出 ────────────────────────────────────────────────────────────────────
if (EXPORT) {
  const queued = await select<QueueRow>(
    'llm_queue?task_key=not.like.__probe*&select=*&order=speak_date.desc,id.desc&limit=2000',
  );
  const goldRows = await select<{
    item_key: string;
    code: string;
    market: string;
    clause: string;
    subject: string;
    detail: string;
  }>('gold_set?item_key=not.like.__probe*&select=item_key,code,market,clause,subject,detail&limit=5000');

  const labeledKeys = new Set(goldRows.map((r) => r.item_key));
  // 忽略發言日期的內容鍵：連續公告三個月的公告每天都會回來一次，
  // 那是同一題，不是新題。詳見 announce.ts 的 contentKeyIgnoringDate。
  const labeledContent = new Set(goldRows.map((r) => contentKeyIgnoringDate(r)));

  const todo: QueueRow[] = [];
  const seenInBatch = new Set<string>();
  let skippedSameKey = 0;
  let skippedSameContent = 0;

  for (const row of queued) {
    if (labeledKeys.has(row.task_key)) {
      skippedSameKey += 1;
      continue;
    }
    const contentKey = contentKeyIgnoringDate(row);
    if (labeledContent.has(contentKey) || seenInBatch.has(contentKey)) {
      skippedSameContent += 1;
      continue;
    }
    seenInBatch.add(contentKey);
    todo.push(row);
    if (todo.length >= LIMIT) break;
  }

  console.log('=== gold_set 待標註匯出 ===\n');
  console.log(`佇列 ${queued.length} 則　已標註 ${labeledKeys.size} 題　本次匯出 ${todo.length} 題`);
  if (skippedSameKey > 0) {
    console.log(`  ├ 略過 ${skippedSameKey} 則：同一則已經標過`);
  }
  if (skippedSameContent > 0) {
    console.log(
      `  └ 略過 ${skippedSameContent} 則：**內容相同、只有發言日期不同**\n` +
        '     （更名／面額變更依規定連續公告三個月，會天天回來。同一題只問一次。）',
    );
  }
  console.log('');

  if (todo.length === 0) {
    console.log('沒有新的題目要標。');
    console.log('若今天還沒抓資料，先跑：npm run llm:enqueue -- --write');
    process.exit(0);
  }

  const book = new ExcelJS.Workbook();
  book.creator = '台股分析交易助手 P11';

  const guide = book.addWorksheet('怎麼標');
  guide.columns = [{ width: 100 }];
  for (const line of [
    'gold_set 標註說明',
    '',
    '你要回答的是一個是非題，不是投資判斷：',
    '',
    '　　這則公告有沒有陳述一件「已經發生」、且對公司營運或財務明顯不利的具體事實？',
    '',
    '　有 → label 填 veto',
    '　沒有 → label 填 no_veto',
    '',
    '判斷原則（跟給模型的提示詞完全一致，否則等於用不同標準考它）：',
    '　1. 只看公告原文。不要用你對這家公司的印象。',
    '　2. 例行公告（財報公告、法說會、董事會通過一般議案、更正格式、',
    '　　 例行人事異動、股利發放）一律 no_veto。',
    '　3. 不確定就填 no_veto。',
    '　4. 這裡不問「會不會跌」，只問「有沒有發生壞事」。',
    '',
    'label_reason 一定要填（至少 4 個字），寫你為什麼這樣判。',
    '空白的那一列會被拒絕——理由是日後要覆核的就是這一欄。',
    '',
    `至少要標 ${MIN_GOLD_SAMPLE} 題，而且不能全部同一個答案，否則考卷沒有鑑別度。`,
    '',
    '⚠️ 主旨與說明欄在這裡可能顯示不全，那沒關係：',
    '　 寫入資料庫時用的是資料庫裡的完整原文，這個檔案只負責收 label 與 label_reason 兩欄。',
  ]) {
    guide.addRow([line]).font = FONT;
  }

  const sheet = book.addWorksheet('待標註');
  sheet.columns = [
    { header: 'item_key', key: 'item_key', width: 34 },
    { header: 'label（veto / no_veto）', key: 'label', width: 20 },
    { header: 'label_reason（為什麼）', key: 'label_reason', width: 40 },
    { header: '市場', key: 'market', width: 7 },
    { header: '代號', key: 'code', width: 8 },
    { header: '發言日', key: 'speak_date', width: 12 },
    { header: '條款', key: 'clause', width: 9 },
    { header: '主旨', key: 'subject', width: 52 },
    { header: '說明（節錄）', key: 'detail', width: 90 },
  ];
  sheet.getRow(1).font = { ...FONT, bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const row of todo) {
    const added = sheet.addRow({
      item_key: row.task_key,
      label: '',
      label_reason: '',
      market: row.market,
      code: row.code,
      speak_date: row.speak_date,
      clause: row.clause,
      subject: row.subject.replace(/\s+/g, ' '),
      detail: row.detail.replace(/\s+/g, ' ').slice(0, 900),
    });
    added.font = FONT;
    added.alignment = { vertical: 'top', wrapText: true };
    // 下拉選單，避免打錯字。填錯的字在匯入時一樣會被擋下。
    added.getCell('label').dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"veto,no_veto"'],
    };
  }

  if (!existsSync('gold')) {
    mkdirSync('gold');
  }
  const stamp = todo[0]?.speak_date ?? 'latest';
  const path = `gold/pending-${stamp}.xlsx`;
  await book.xlsx.writeFile(path);

  console.log(`✓ 已寫出 ${path}`);
  console.log('  用 Excel 打開，先看「怎麼標」那一頁，把 label 與 label_reason 兩欄填完，');
  console.log(`  存檔後跑：npm run llm:gold -- --import ${path} --write`);
  process.exit(0);
}

// ── 匯入 ────────────────────────────────────────────────────────────────────
console.log('=== gold_set 標註匯入 ===\n');

const book = new ExcelJS.Workbook();
await book.xlsx.readFile(IMPORT_PATH!);
const sheet = book.getWorksheet('待標註');
if (sheet === undefined) {
  console.log('✗ 檔案裡找不到「待標註」工作表。請用 --export 產生的檔案。');
  process.exit(1);
}

function cellText(row: ExcelJS.Row, col: number): string {
  const value = row.getCell(col).value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'result' in value) return String(value.result ?? '').trim();
  if (typeof value === 'object' && 'text' in value) return String(value.text ?? '').trim();
  return String(value).trim();
}

interface Labeled {
  readonly itemKey: string;
  readonly label: string;
  readonly reason: string;
  readonly rowNumber: number;
}

const entered: Labeled[] = [];
let blank = 0;
sheet.eachRow((row, rowNumber) => {
  if (rowNumber === 1) return;
  const itemKey = cellText(row, 1);
  const label = cellText(row, 2);
  const reason = cellText(row, 3);
  if (itemKey === '') return;
  if (label === '' && reason === '') {
    blank += 1;
    return;
  }
  entered.push({ itemKey, label, reason, rowNumber });
});

console.log(`檔案共有 ${entered.length} 列已填、${blank} 列留白（留白的不匯入）\n`);

// ── 逐列檢查 ────────────────────────────────────────────────────────────────
const problems: string[] = [];
for (const item of entered) {
  if (item.label !== 'veto' && item.label !== 'no_veto') {
    problems.push(`第 ${item.rowNumber} 列：label「${item.label}」不是 veto 或 no_veto`);
  }
  if (item.reason.replace(/\s/g, '').length < 4) {
    problems.push(`第 ${item.rowNumber} 列：label_reason 太短（至少 4 個字）`);
  }
}

const queueRows = await select<QueueRow>(
  'llm_queue?task_key=not.like.__probe*&select=*&limit=5000',
);
const byKey = new Map(queueRows.map((r) => [r.task_key, r]));
for (const item of entered) {
  if (!byKey.has(item.itemKey)) {
    problems.push(`第 ${item.rowNumber} 列：item_key 在 llm_queue 裡找不到（${item.itemKey}）`);
  }
}

// 已標過的題目要寫成新 revision，不是覆蓋
const existing = await select<{
  item_key: string;
  revision: number;
  code: string;
  market: string;
  clause: string;
  subject: string;
  detail: string;
}>(
  'gold_set?item_key=not.like.__probe*&select=item_key,revision,code,market,clause,subject,detail&limit=5000',
);
const maxRevision = new Map<string, number>();
for (const row of existing) {
  maxRevision.set(row.item_key, Math.max(maxRevision.get(row.item_key) ?? 0, row.revision));
}

// ⚠️ 先檢查再去重，順序不可對調：
// 去重要用 byKey.get(item_key) 取原文，而「item_key 找不到」正是上面那組檢查在擋的。
// 反過來排，遇到打錯的 item_key 會直接拋 undefined 而不是給出可讀的錯誤。
if (problems.length > 0) {
  console.log('✗ 檔案有問題，未寫入任何資料：');
  for (const p of problems.slice(0, 30)) {
    console.log(`    ${p}`);
  }
  if (problems.length > 30) console.log(`    …另外 ${problems.length - 30} 個問題`);
  process.exit(1);
}

/**
 * 內容重複的擋在這裡。匯出端已經濾過一次，這裡是第二道——
 * 使用者可能重新匯入舊檔，或手動貼上列。
 * 同一則公告混進考卷兩次，會稀釋 veto 比例並把 baseline 推高，
 * 而且**題數看起來還變多了**，比題目不足更難察覺。
 */
const contentToItemKey = new Map<string, string>();
for (const row of existing) {
  contentToItemKey.set(contentKeyIgnoringDate(row), row.item_key);
}
const dupes: Labeled[] = [];
const accepted: Labeled[] = [];
for (const item of entered) {
  const source = byKey.get(item.itemKey)!;
  const contentKey = contentKeyIgnoringDate(source);
  const already = contentToItemKey.get(contentKey);
  // 同一個 item_key 是重標（允許，寫新 revision）；
  // 不同 item_key 但內容相同，才是要擋的重複題。
  if (already !== undefined && already !== item.itemKey) {
    dupes.push(item);
    continue;
  }
  contentToItemKey.set(contentKey, item.itemKey);
  accepted.push(item);
}

if (dupes.length > 0) {
  console.log(`\n⚠️ 略過 ${dupes.length} 列：內容與已標過的題目相同，只有發言日期不同`);
  for (const d of dupes.slice(0, 10)) {
    console.log(`    第 ${d.rowNumber} 列（${d.itemKey}）`);
  }
  console.log('   同一則公告只算一題，重複計入會稀釋考卷的鑑別度。\n');
}
if (accepted.length === 0) {
  console.log('沒有可寫入的新題目。');
  process.exit(0);
}

const vetoCount = accepted.filter((e) => e.label === 'veto').length;
console.log(`標為 veto：${vetoCount} 題　標為 no_veto：${accepted.length - vetoCount} 題`);

// 這兩個檢查只警告不阻擋——考卷是慢慢累積的，
// 但要讓你現在就知道還差多少，而不是等到 llm:eval 才發現不能用。
if (accepted.length + maxRevision.size < MIN_GOLD_SAMPLE) {
  console.log(
    `⚠️ 加上既有的 ${maxRevision.size} 題，總共仍不足 ${MIN_GOLD_SAMPLE} 題，` +
      '評測會被拒絕（CLAUDE.md：樣本 < 30 不下結論）。',
  );
}
if (vetoCount === 0) {
  console.log('⚠️ 這批全部標成 no_veto。若整份考卷都是同一個答案，考幾分都沒有意義。');
}

const updates = accepted.filter((e) => maxRevision.has(e.itemKey));
if (updates.length > 0) {
  console.log(`\n其中 ${updates.length} 題先前標註過，將寫成新的 revision（舊的保留可稽核）`);
}

if (!WRITE) {
  console.log('\n（dry-run，未寫入 gold_set。要實際寫入請加 --write）');
  process.exit(0);
}

const labeledAt = new Date().toISOString();
const labeledBy = process.env['USERNAME'] ?? process.env['USER'] ?? 'owner';
await client.insert(
  'gold_set',
  accepted.map((item) => {
    const source = byKey.get(item.itemKey)!;
    return {
      item_key: item.itemKey,
      revision: (maxRevision.get(item.itemKey) ?? 0) + 1,
      source_id: source.source_id,
      code: source.code,
      market: source.market,
      speak_date: source.speak_date,
      // 原文一律取自資料庫，不取 Excel——Excel 那份是節錄過的
      clause: source.clause,
      subject: source.subject,
      detail: source.detail,
      content_hash: source.content_hash,
      label: item.label,
      label_reason: item.reason,
      labeled_by: labeledBy,
      labeled_at: labeledAt,
    };
  }),
);

console.log(`\n✓ 已寫入 ${accepted.length} 題標註（標註者記為 ${labeledBy}）。`);
console.log('  下一步：npm run llm:eval');
process.exit(0);
