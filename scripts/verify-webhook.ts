/**
 * LINE webhook 的實測驗證：`npm run l4:verify-webhook`
 *
 * 【這支要證明的是「偽造的請求進不來」】
 * webhook 端點必須 --no-verify-jwt（LINE 不會帶 Supabase 的 JWT），
 * 因此它對全世界公開。簽章驗證是**唯一**擋住偽造紀錄的機制，
 * 而 user_records 是 append-only —— 假資料寫進去就永遠拔不掉，
 * 還會污染 G4「人工執行一致率」的評估。
 *
 * 【回應必須來自我們的函式，不是 Supabase 的閘門】
 * 兩者都會回 401，但意義完全不同：
 *   閘門 401  → --no-verify-jwt 沒生效，我們的程式根本沒跑
 *   函式 401  → 簽章驗證正常運作
 * 用 x-deno-execution-id 標頭區分，不然會把「沒部署好」誤判成「安全」。
 *
 * ⚠️ 本程式不印出任何憑證內容。
 */

import { createHmac } from 'node:crypto';
import { loadEnvFileIfPresent, loadLineConfig, loadSupabaseConfig } from '../src/lib/config/env';

loadEnvFileIfPresent();
const line = loadLineConfig();
const sb = loadSupabaseConfig();
const projectRef = new URL(sb.url).hostname.split('.')[0]!;
const WEBHOOK_URL = `https://${projectRef}.supabase.co/functions/v1/line-webhook`;

const PROBE_PREFIX = `__probe_webhook_${Date.now()}`;

const results: { name: string; passed: boolean; detail: string }[] = [];
function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✓' : '✗'} ${name}`);
  console.log(`    ${detail}\n`);
}

interface Sent {
  readonly status: number;
  readonly body: string;
  /** true 代表回應來自我們的 Deno 函式，而非 Supabase 閘門 */
  readonly fromFunction: boolean;
}

/**
 * 送出一次請求。5xx 會重試。
 *
 * ⚠️ 2026-08-16 實測：Supabase Edge Function 在連續請求下偶爾回 503
 *    （worker 回收或瞬間負載），與程式邏輯無關——
 *    同一情境連送 5 次全部 200，且去重行為完全正確。
 *    LINE 官方在收到非 200 時會重送，而重送會被 line_message_id 的
 *    唯一索引擋下，所以正式運作不受影響。
 *    這裡重試是為了不讓驗證結果被平台的瞬時狀況誤判成程式缺陷。
 *    **只重試 5xx**；4xx 是我們自己的判斷結果，一律如實回報。
 */
async function send(payload: unknown, signWith: string | null, attempt = 1): Promise<Sent> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signWith !== null) {
    headers['x-line-signature'] = createHmac('sha256', signWith).update(body, 'utf8').digest('base64');
  }
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const sent: Sent = {
    status: res.status,
    body: (await res.text()).slice(0, 80),
    fromFunction: res.headers.get('x-deno-execution-id') !== null,
  };
  if (sent.status >= 500 && attempt < 3) {
    console.log(`    （HTTP ${sent.status}，平台瞬時狀況，2 秒後重試第 ${attempt + 1} 次）`);
    await new Promise((r) => setTimeout(r, 2000));
    return send(payload, signWith, attempt + 1);
  }
  return sent;
}

function messageEvent(text: string, messageId: string, userId: string = line.userId): unknown {
  return {
    destination: 'U0',
    events: [
      {
        type: 'message',
        timestamp: Date.now(),
        replyToken: '0'.repeat(32), // 假 token，回覆會失敗但不影響寫入路徑
        source: { type: 'user', userId },
        message: { type: 'text', id: messageId, text },
      },
    ],
  };
}

async function countProbeRows(): Promise<number> {
  const res = await fetch(
    `${sb.url}/rest/v1/user_records?line_message_id=like.${PROBE_PREFIX}*&select=line_message_id`,
    { headers: { apikey: sb.serviceRoleKey, Authorization: `Bearer ${sb.serviceRoleKey}` } },
  );
  if (!res.ok) {
    throw new Error(`查詢 user_records 失敗：HTTP ${res.status}`);
  }
  return ((await res.json()) as unknown[]).length;
}

console.log('=== LINE webhook 實測 ===\n');
console.log(`端點：${WEBHOOK_URL}\n`);

// ── 部署狀態 ────────────────────────────────────────────────────────────────
const unsigned = await send({ destination: 'U0', events: [] }, null);
record(
  '函式已部署且 --no-verify-jwt 生效（回應來自我們的程式，不是 Supabase 閘門）',
  unsigned.fromFunction,
  unsigned.fromFunction
    ? `HTTP ${unsigned.status}，含 x-deno-execution-id 標頭`
    : `HTTP ${unsigned.status} "${unsigned.body}" —— 沒有 x-deno-execution-id。` +
        '404 代表未部署；401 代表 --no-verify-jwt 沒生效。',
);
if (!unsigned.fromFunction) {
  console.log('✗ 函式沒跑起來，後續測試無意義。');
  console.log('  部署：npx supabase functions deploy line-webhook --no-verify-jwt --use-api --project-ref ' + projectRef);
  process.exit(1);
}

// ── 簽章驗證 ────────────────────────────────────────────────────────────────
record('無簽章 → 401', unsigned.status === 401, `HTTP ${unsigned.status} "${unsigned.body}"`);

const wrongSig = await send({ destination: 'U0', events: [] }, 'definitely-not-the-channel-secret');
record('錯誤簽章 → 401', wrongSig.status === 401, `HTTP ${wrongSig.status} "${wrongSig.body}"`);

const correctSig = await send({ destination: 'U0', events: [] }, line.channelSecret);
record(
  '正確簽章 → 200（LINE 的 Verify 按鈕送的就是這種空事件）',
  correctSig.status === 200,
  `HTTP ${correctSig.status} "${correctSig.body}"` +
    (correctSig.status === 200
      ? ''
      : '　⚠️ 部署端的 LINE_CHANNEL_SECRET 與本機不符，跑 npm run l4:sync-secrets'),
);

// ── 偽造的紀錄寫不進去 ──────────────────────────────────────────────────────
const before = await countProbeRows();
await send(messageEvent('/rec 備註 這是偽造的', `${PROBE_PREFIX}_forged`), 'attacker-secret');
await new Promise((r) => setTimeout(r, 1000));
record(
  '簽章錯誤的指令**沒有**寫進 user_records（append-only，寫進去就拔不掉）',
  (await countProbeRows()) === before,
  `寫入前 ${before} 列，送出偽造請求後仍為 ${await countProbeRows()} 列`,
);

// ── 合法指令的完整路徑 ──────────────────────────────────────────────────────
const validId = `${PROBE_PREFIX}_valid`;
const ok = await send(messageEvent('/rec 備註 webhook 驗證探針', validId), line.channelSecret);
await new Promise((r) => setTimeout(r, 1000));
record(
  '合法指令 → 200 且寫入 user_records',
  ok.status === 200 && (await countProbeRows()) === before + 1,
  `HTTP ${ok.status}，user_records 新增 ${(await countProbeRows()) - before} 列`,
);

const dup = await send(messageEvent('/rec 備註 webhook 驗證探針', validId), line.channelSecret);
await new Promise((r) => setTimeout(r, 1000));
record(
  '同一則訊息重送 → 去重，不會記兩次（LINE webhook 會重送）',
  dup.status === 200 && (await countProbeRows()) === before + 1,
  `HTTP ${dup.status}，user_records 仍為 ${(await countProbeRows()) - before} 列`,
);

const badFormat = await send(
  messageEvent('/rec 觀望 台積電', `${PROBE_PREFIX}_badformat`),
  line.channelSecret,
);
await new Promise((r) => setTimeout(r, 1000));
record(
  '格式錯誤的指令不寫入（解析失敗一律回覆用法，不猜）',
  badFormat.status === 200 && (await countProbeRows()) === before + 1,
  `HTTP ${badFormat.status}，user_records 仍為 ${(await countProbeRows()) - before} 列`,
);

const otherUser = await send(
  messageEvent('/rec 備註 別人送的', `${PROBE_PREFIX}_other`, `U${'f'.repeat(32)}`),
  line.channelSecret,
);
await new Promise((r) => setTimeout(r, 1000));
record(
  '非指定使用者的指令被忽略（v1 是單人系統）',
  otherUser.status === 200 && (await countProbeRows()) === before + 1,
  `HTTP ${otherUser.status}，user_records 仍為 ${(await countProbeRows()) - before} 列`,
);

console.log('='.repeat(64));
const failed = results.filter((r) => !r.passed);
console.log(`${results.length - failed.length}/${results.length} 通過`);
if (failed.length > 0) {
  for (const f of failed) {
    console.log(`  ✗ ${f.name}：${f.detail}`);
  }
  process.exit(1);
}
console.log('✓ webhook 簽章驗證與寫入路徑全部正確');
console.log(`  註：探針列留在 user_records（line_message_id 以 __probe_webhook_ 開頭）。`);
process.exit(0);
