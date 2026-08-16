/**
 * 模型試跑：`npm run llm:smoke`（選項 --limit=N，預設 3）
 *
 * 拿**本機 data/raw 裡真實抓到的重大訊息**，用正式的 prompt 跑一次，
 * 把原始回應與解析結果整個攤開來看。
 *
 * 【為什麼要有這一步】
 * 標 30 題 gold_set 是要花時間的。在投入之前，先花幾分鐘看看這個模型
 * 到底會不會輸出 JSON、會不會逐字引用、速度能不能接受。
 * 不行就換一個模型，不用等到考完試才發現。
 *
 * 不讀資料庫、不寫任何東西、不需要 .env.local。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';

import { loadLlmConfig } from '../src/lib/l2/llm/config';
import { parseAnnouncements } from '../src/lib/l2/llm/announce';
import { SYSTEM_PROMPT, buildUserPrompt } from '../src/lib/l2/llm/prompt';
import { OpenAiCompatibleProvider } from '../src/lib/l2/llm/provider';
import type { Announcement } from '../src/lib/l2/llm/types';
import { parseResponse, toVerdict } from '../src/lib/l2/llm/verdict';

const LIMIT = Number(process.argv.slice(2).find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '3');

const SOURCES = [
  { id: 'mops_twse_material_announcements', market: 'TWSE' },
  { id: 'mops_tpex_material_announcements', market: 'TPEx' },
] as const;

/** 取某來源最新一天的本機快照檔 */
function latestLocalPayload(sourceId: string): unknown | null {
  const base = `data/raw/${sourceId}`;
  if (!existsSync(base)) return null;
  const days = readdirSync(base).sort();
  const day = days[days.length - 1];
  if (day === undefined) return null;
  const files = readdirSync(`${base}/${day}`).filter((f) => f.endsWith('.json'));
  const file = files[files.length - 1];
  if (file === undefined) return null;
  return JSON.parse(readFileSync(`${base}/${day}/${file}`, 'utf8'));
}

const items: Announcement[] = [];
for (const source of SOURCES) {
  const payload = latestLocalPayload(source.id);
  if (payload === null) continue;
  items.push(...parseAnnouncements(payload, source.market, source.id).items);
}

const config = loadLlmConfig();
console.log('=== 模型試跑（不碰資料庫）===\n');
console.log(`模型　${config.challenger.modelKey}`);
console.log(`端點　${config.challenger.endpoint}`);
console.log(`題目　本機真實公告 ${items.length} 則，本次試跑前 ${Math.min(LIMIT, items.length)} 則\n`);

if (items.length === 0) {
  console.log('✗ data/raw 裡找不到重大訊息快照。先跑 npm run l0:ingest -- --write');
  process.exit(1);
}

const provider = new OpenAiCompatibleProvider(config.challenger);
let jsonOk = 0;
/** 判否決且引用通過原文比對的則數 */
let vetoQuoteOk = 0;
/** 判否決但引用是幻覺而被作廢的則數 */
let vetoQuoteBad = 0;
let vetoCount = 0;
/** 判不否決卻仍填了引用的則數。不影響判定，但看得出模型有沒有照格式走 */
let strayQuote = 0;
const latencies: number[] = [];

for (const [i, item] of items.slice(0, LIMIT).entries()) {
  console.log('─'.repeat(72));
  console.log(`[${i + 1}] ${item.market} ${item.code}　${item.clause}　${item.speakDate}`);
  console.log(`主旨　${item.subject.replace(/\s+/g, ' ').slice(0, 60)}`);
  console.log(`說明長度　${item.detail.length} 字\n`);

  try {
    const completion = await provider.complete(SYSTEM_PROMPT, buildUserPrompt(item));
    const verdict = toVerdict(item.itemKey, item, completion.content, completion.latencyMs);
    latencies.push(completion.latencyMs);
    if (verdict.parseOk) jsonOk += 1;
    if (verdict.verdict === 'veto') {
      vetoCount += 1;
      vetoQuoteOk += 1; // toVerdict 只有引用驗證通過才會回 veto
    } else if (verdict.parseOk && !verdict.evidenceVerified) {
      // 判否決但引用驗不過 → 已被作廢改判 no_veto
      vetoQuoteBad += 1;
    } else if (parseResponse(completion.content).quote.trim() !== '') {
      strayQuote += 1;
    }

    console.log(`原始回應（${(completion.latencyMs / 1000).toFixed(1)} 秒）：`);
    console.log(completion.content.trim().slice(0, 600));
    console.log('');
    console.log(`→ 判定 ${verdict.verdict}｜JSON ${verdict.parseOk ? '✓' : '✗'}｜引用 ${verdict.evidenceVerified ? '✓' : '✗'}`);
    if (verdict.reason !== '') {
      console.log(`  ${verdict.reason.slice(0, 160)}`);
    }
  } catch (error) {
    console.log(`✗ 呼叫失敗：${(error as Error).message.slice(0, 200)}`);
  }
  console.log('');
}

const n = latencies.length;
console.log('═'.repeat(72));
console.log(`成功呼叫 ${n} 則`);
if (n > 0) {
  const avg = latencies.reduce((s, v) => s + v, 0) / n / 1000;
  console.log(`平均 ${avg.toFixed(1)} 秒／則　（每日約 12 則 → 約 ${(avg * 12 / 60).toFixed(1)} 分鐘）`);
  console.log(`輸出合法 JSON　${jsonOk}/${n}`);
  console.log(`判否決　　　　${vetoCount} 則（引用通過原文比對 ${vetoQuoteOk} 則）`);
  console.log(`判否決但引用是幻覺而作廢　${vetoQuoteBad} 則`);
  if (strayQuote > 0) {
    console.log(
      `判不否決卻仍填了引用　${strayQuote} 則（不影響判定，no_veto 本來就不需要引用）`,
    );
  }
  if (jsonOk < n) {
    console.log('\n⚠️ 有回應不是合法 JSON。解析不出來一律判 no_veto，不會亂擋，但這個模型的可用度存疑。');
  }
  if (vetoCount === 0) {
    console.log(
      '\n註：這幾則全部判不否決。引用驗證這條路徑**沒有被走到**，' +
        '\n　　所以這次試跑不能說明它擋不擋得住幻覺。',
    );
  }
}
console.log('\n這只是試跑，不代表判斷正確。正確與否要靠 gold_set 對答案。');
