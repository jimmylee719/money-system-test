/**
 * Excel 匯出：`npm run l5:export`
 *
 * 把系統至今累積的全部紀錄匯成一份 .xlsx，方便離線檢視與自行分析。
 *
 * 【為什麼不是用 Python/openpyxl】
 * CLAUDE.md 指定 xlsx skill，該 skill 的預設工具鏈是 Python + openpyxl + LibreOffice。
 * 2026-08-16 實測本機兩者皆無（Python 只有 Windows Store 的殼，無 LibreOffice），
 * 故改用 exceljs 以配合專案既有的 TypeScript 工具鏈，
 * 但 skill 的實質要求照做：專業字型、摘要用公式不寫死、標註資料來源與假設。
 *
 * ⚠️ **公式未經實際 Excel／LibreOffice 計算驗證**（本機無可用的計算器）。
 *    只用了 COUNTIF／AVERAGEIF／COUNTIFS 這類 2007 年以前就有的函式以降低風險，
 *    首次開啟時請確認摘要頁沒有 #NAME? 之類的錯誤。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import ExcelJS from 'exceljs';
import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';

const FONT = { name: 'Arial', size: 10 } as const;
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE8E8E8' },
};

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

const missingTables: string[] = [];

/**
 * 查詢一張表。**表不存在時回空陣列並記錄**，不讓整份匯出失敗。
 *
 * 各 migration 是分批執行的，匯出應該在任何階段都能跑得出來；
 * 缺哪張表會明確寫在摘要頁與終端機輸出，不會被誤讀成「這張表沒有資料」。
 */
async function select<T>(table: string, query: string): Promise<readonly T[]> {
  const res = await fetch(`${config.url}/rest/v1/${query}`, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 404) {
    missingTables.push(table);
    return [];
  }
  if (!res.ok) {
    throw new Error(`查詢 ${table} 失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as readonly T[];
}

interface Column {
  readonly header: string;
  readonly key: string;
  readonly width: number;
  readonly numFmt?: string;
}

function addSheet(
  book: ExcelJS.Workbook,
  name: string,
  note: string,
  columns: readonly Column[],
  rows: readonly Record<string, unknown>[],
): ExcelJS.Worksheet {
  const sheet = book.addWorksheet(name);

  // 每一頁最上方寫明這頁是什麼、資料怎麼來的 —— 讀的人不必回頭問
  sheet.mergeCells(1, 1, 1, Math.max(columns.length, 1));
  const noteCell = sheet.getCell(1, 1);
  noteCell.value = note;
  noteCell.font = { ...FONT, italic: true, color: { argb: 'FF555555' } };
  noteCell.alignment = { wrapText: true, vertical: 'middle' };
  sheet.getRow(1).height = 30;

  const headerRow = sheet.getRow(2);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { ...FONT, bold: true };
    cell.fill = HEADER_FILL;
    sheet.getColumn(i + 1).width = col.width;
    if (col.numFmt !== undefined) {
      sheet.getColumn(i + 1).numFmt = col.numFmt;
    }
  });

  rows.forEach((row, r) => {
    const excelRow = sheet.getRow(r + 3);
    columns.forEach((col, c) => {
      const cell = excelRow.getCell(c + 1);
      const value = row[col.key];
      cell.value =
        value === null || value === undefined
          ? null
          : typeof value === 'boolean'
            ? value
              ? '是'
              : '否'
            : col.numFmt !== undefined && typeof value === 'string' && value.trim() !== ''
              ? Number(value)
              : (value as ExcelJS.CellValue);
      cell.font = FONT;
    });
  });

  sheet.views = [{ state: 'frozen', ySplit: 2 }];
  if (rows.length > 0) {
    sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: columns.length } };
  }
  return sheet;
}

console.log('=== Excel 匯出 ===\n');

// 探針列一律排除：revision ≥ 1000、pick_id ≥ 900000000、code 以 __probe 開頭
type Row = Record<string, unknown>;
const [picks, vetoes, records, outcomes, factors, riskConfigs] = await Promise.all([
  select<Row>(
    'daily_picks',
    'daily_picks?revision=lt.1000&select=*&order=data_as_of.desc,list_kind.asc,rank.asc',
  ),
  select<Row>(
    'veto_events',
    'veto_events?code=not.like.__probe*&select=*&order=data_as_of.desc,rank_at_signal.asc',
  ),
  select<Row>(
    'user_records',
    'user_records?line_message_id=not.like.__probe*&select=*&order=recorded_at.desc',
  ),
  select<Row>('outcomes', 'outcomes?pick_id=lt.900000000&select=*&order=data_as_of.desc,horizon.asc'),
  select<Row>(
    'factor_registry',
    'factor_registry?factor_key=not.like.probe_*&select=*&order=registered_at.asc',
  ),
  select<Row>(
    'risk_config',
    'risk_config?select=version,config_hash,rationale,registered_at&order=registered_at.asc',
  ),
]);

console.log(
  `觀察榜／訊號 ${picks.length}｜否決 ${vetoes.length}｜人工紀錄 ${records.length}｜` +
    `結果 ${outcomes.length}｜因子 ${factors.length}｜風控設定 ${riskConfigs.length}`,
);
if (missingTables.length > 0) {
  console.log(`⚠️ 尚未建立的資料表（該頁為空）：${missingTables.join('、')}`);
}

const book = new ExcelJS.Workbook();
book.creator = '台股分析交易助手（v1，不下單）';
book.created = new Date();

// ── 摘要 ────────────────────────────────────────────────────────────────────
const summary = book.addWorksheet('摘要');
summary.getColumn(1).width = 34;
summary.getColumn(2).width = 20;
summary.getColumn(3).width = 62;

const summaryRows: readonly (readonly [string, ExcelJS.CellValue, string])[] = [
  ['台股分析交易助手　紀錄匯出', null, ''],
  ['匯出時間', new Date().toISOString().slice(0, 19).replace('T', ' '), '系統時鐘'],
  ['', null, ''],
  ['── 資料筆數 ──', null, ''],
  ['觀察榜（研究紀錄，非買進建議）', { formula: `COUNTIF(觀察榜與訊號!E:E,"watchlist")` }, '每日固定 5 檔，依 L1 排名產生，不受 L2／L3 影響'],
  ['交易訊號（通過 L2＋L3）', { formula: `COUNTIF(觀察榜與訊號!E:E,"trade_signal")` }, '經常是 0 檔，那是正常且健康的'],
  ['L2 否決事件', { formula: `COUNTA(L2否決紀錄!A:A)-2` }, '一檔可能同時觸發多條規則'],
  ['人工紀錄', { formula: `COUNTA(人工紀錄!A:A)-2` }, '你自己在券商 App 做了什麼'],
  ['已到期的結果', { formula: `COUNTA(結果outcomes!A:A)-2` }, 'T+5／T+10／T+20 各算一列'],
  ['', null, ''],
  ['── 含息報酬（已到期者）──', null, ''],
  ['T+5　平均', { formula: `IFERROR(AVERAGEIFS(結果outcomes!K:K,結果outcomes!F:F,5),"尚無資料")` }, '單位 %，已還原除權息'],
  ['T+10 平均', { formula: `IFERROR(AVERAGEIFS(結果outcomes!K:K,結果outcomes!F:F,10),"尚無資料")` }, '單位 %，已還原除權息'],
  ['T+20 平均', { formula: `IFERROR(AVERAGEIFS(結果outcomes!K:K,結果outcomes!F:F,20),"尚無資料")` }, '單位 %，已還原除權息'],
  ['', null, ''],
  ['── 閘門進度（G1–G5）──', null, ''],
  ['G1　訊號數 ≥ 100 筆', { formula: `COUNTIF(觀察榜與訊號!E:E,"trade_signal")` }, '且需累積 ≥6 個月'],
  ['G2　期望值 >0、獲利因子 >1.3', '待 outcomes 累積', '樣本 < 30 筆不得下結論（CLAUDE.md）'],
  ['G3　勝過 0050 買入持有', '待 P10', '須為風險調整後淨報酬'],
  ['G4　人工執行一致率 >90%', '待 user_records 累積', 'daily_picks 與 user_records 比對'],
  ['G5　資料管線連續 60 日零故障', '見 ops/ingest-log.jsonl', ''],
  ['', null, ''],
  ['── 重要說明 ──', null, ''],
  ['本檔案由 AI 系統自動產生', null, '歐盟 AI Act 第 50 條、台灣 AI 基本法'],
  ['不構成投資建議', null, 'v1 只通知與紀錄，不具備下單功能'],
  ['觀察榜不是買進建議', null, '它是用來檢驗排序有無預測力的研究紀錄'],
  ['報酬已還原除權息', null, '未還原的帳面報酬另存一欄，兩者差額即除權息影響'],
  ['探針列已排除', null, '守門驗證用的測試列不計入任何統計'],
  ...(missingTables.length > 0
    ? ([['⚠️ 尚未建立的資料表', missingTables.join('、'), '該頁為空白，不代表沒有資料']] as const)
    : []),
];

summaryRows.forEach(([label, value, note], i) => {
  const row = summary.getRow(i + 1);
  row.getCell(1).value = label;
  row.getCell(1).font = { ...FONT, bold: label.startsWith('──') || i === 0 };
  row.getCell(2).value = value;
  row.getCell(2).font = FONT;
  row.getCell(3).value = note;
  row.getCell(3).font = { ...FONT, color: { argb: 'FF555555' } };
});
summary.getRow(1).font = { ...FONT, bold: true, size: 14 };

// ── 各資料頁 ────────────────────────────────────────────────────────────────
addSheet(
  book,
  '觀察榜與訊號',
  '系統每日產出。list_kind=watchlist 是研究紀錄（不是買進建議）；trade_signal 才是通過 L2 否決與 L3 風控的可執行訊號。來源：daily_picks（append-only，不可修改）。',
  [
    { header: '資料日', key: 'data_as_of', width: 12 },
    { header: '名次', key: 'rank', width: 6 },
    { header: '代號', key: 'code', width: 10 },
    { header: '名稱', key: 'name', width: 14 },
    { header: '清單類型', key: 'list_kind', width: 14 },
    { header: '市場', key: 'market', width: 8 },
    { header: '推播價', key: 'price_at_push', width: 10, numFmt: '0.00' },
    { header: '合成分數', key: 'composite_score', width: 11, numFmt: '0.0000' },
    { header: '真實因子數', key: 'real_factor_count', width: 11 },
    { header: '進場價', key: 'entry_price', width: 10, numFmt: '0.00' },
    { header: '停損價', key: 'stop_price', width: 10, numFmt: '0.00' },
    { header: '停利價', key: 'take_profit_price', width: 10, numFmt: '0.00' },
    { header: '股數', key: 'shares', width: 9 },
    { header: '部位金額', key: 'position_value_twd', width: 13, numFmt: '#,##0' },
    { header: '名目風險', key: 'risk_amount_twd', width: 11, numFmt: '#,##0' },
    { header: '時間出場(日)', key: 'time_exit_days', width: 12 },
    { header: '當時資金', key: 'equity_at_signal_twd', width: 12, numFmt: '#,##0' },
    { header: '風控版本', key: 'risk_config_version', width: 12 },
    { header: '訊號時間', key: 'signal_at', width: 24 },
  ],
  picks,
);

addSheet(
  book,
  'L2否決紀錄',
  'L2 只能否決，不能產生訊號。rank_at_signal 是該檔當時在排序中的名次——用來回答「擋掉的是前段班還是後段班」。evidence 是交易所公告原文，逐字保留。',
  [
    { header: '資料日', key: 'data_as_of', width: 12 },
    { header: '代號', key: 'code', width: 10 },
    { header: '市場', key: 'market', width: 8 },
    { header: '規則', key: 'rule_id', width: 18 },
    { header: '當時名次', key: 'rank_at_signal', width: 10 },
    { header: '合成分數', key: 'composite_score', width: 11, numFmt: '0.0000' },
    { header: '理由', key: 'reason', width: 40 },
    { header: '官方原文', key: 'evidence', width: 70 },
  ],
  vetoes,
);

addSheet(
  book,
  '人工紀錄',
  '你透過 LINE /rec 記下的決策。append-only：打錯不能改，補一筆即可，同一天同一檔以最後一筆為準。與 daily_picks 比對即為 G4 的人工執行一致率。',
  [
    { header: '記錄時間', key: 'recorded_at', width: 24 },
    { header: '對應清單日', key: 'data_as_of', width: 12 },
    { header: '動作', key: 'action', width: 10 },
    { header: '代號', key: 'code', width: 10 },
    { header: '股數', key: 'shares', width: 9 },
    { header: '價格', key: 'price', width: 10, numFmt: '0.00' },
    { header: '備註', key: 'note', width: 30 },
    { header: '原始訊息', key: 'raw_text', width: 40 },
  ],
  records,
);

addSheet(
  book,
  '結果outcomes',
  '訊號發出後的實際結果，僅系統可寫、人工不可改。含息報酬已還原除權息；帳面報酬未還原，兩者差額即除權息的影響。未到期者不會出現在這裡。',
  [
    { header: '資料日', key: 'data_as_of', width: 12 },
    { header: '代號', key: 'code', width: 10 },
    { header: '市場', key: 'market', width: 8 },
    { header: '清單類型', key: 'list_kind', width: 14 },
    { header: '出場日', key: 'exit_date', width: 12 },
    { header: '觀察期(交易日)', key: 'horizon', width: 14 },
    { header: '進場價', key: 'entry_price', width: 10, numFmt: '0.00' },
    { header: '出場價', key: 'exit_price', width: 10, numFmt: '0.00' },
    { header: '帳面報酬%', key: 'raw_return_pct', width: 12, numFmt: '0.00' },
    { header: '除權息次數', key: 'ex_right_count', width: 11 },
    { header: '含息報酬%', key: 'adjusted_return_pct', width: 12, numFmt: '0.00' },
    { header: '股數係數', key: 'share_factor', width: 11, numFmt: '0.0000' },
    { header: '每股配息', key: 'cash_dividend_per_share', width: 11, numFmt: '0.0000' },
    { header: '有現金增資', key: 'has_rights_issue', width: 11 },
    { header: '屏障觸及', key: 'barrier_touched', width: 11 },
    { header: '觸及日', key: 'barrier_touch_date', width: 12 },
  ],
  outcomes,
);

addSheet(
  book,
  '因子登記',
  '因子必須在看到結果之前登記，definition_hash 鎖定定義。失敗即封存，不得改條件重測。',
  [
    { header: '因子代號', key: 'factor_key', width: 26 },
    { header: '名稱', key: 'display_name', width: 22 },
    { header: '假設方向', key: 'hypothesis_direction', width: 18 },
    { header: 't 門檻', key: 't_threshold', width: 8 },
    { header: '檢定起', key: 'test_period_start', width: 12 },
    { header: '檢定迄', key: 'test_period_end', width: 12 },
    { header: '登記時間', key: 'registered_at', width: 24 },
    { header: 'definition_hash', key: 'definition_hash', width: 68 },
    { header: '經濟理由', key: 'economic_rationale', width: 90 },
  ],
  factors,
);

addSheet(
  book,
  '風控設定',
  '風控設定與因子同樣鎖定：改任何數字都必須換版本重新登記，兩份都永久留存。',
  [
    { header: '版本', key: 'version', width: 12 },
    { header: '登記時間', key: 'registered_at', width: 24 },
    { header: 'config_hash', key: 'config_hash', width: 68 },
    { header: '訂定理由', key: 'rationale', width: 120 },
  ],
  riskConfigs,
);

const outPath = `exports/money-system-${new Date().toISOString().slice(0, 10)}.xlsx`;
await import('node:fs/promises').then((fs) => fs.mkdir('exports', { recursive: true }));
await book.xlsx.writeFile(outPath);

console.log(`\n✓ 已匯出：${outPath}`);
console.log(`  工作表：${book.worksheets.map((w) => w.name).join('、')}`);
console.log('\n⚠️ 摘要頁的公式未經 Excel／LibreOffice 實際計算驗證（本機無可用的計算器）。');
console.log('   只用了 COUNTIF／COUNTIFS／AVERAGEIFS／IFERROR 這類相容性高的函式，');
console.log('   首次開啟時請確認摘要頁沒有 #NAME? 之類的錯誤。');
