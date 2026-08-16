/**
 * LINE webhook —— Supabase Edge Function（Deno）。
 *
 * 部署：
 *   supabase functions deploy line-webhook --no-verify-jwt
 *   supabase secrets set LINE_CHANNEL_SECRET=... LINE_CHANNEL_ACCESS_TOKEN=...
 *
 * ⚠️ `--no-verify-jwt` 是必要的：LINE 的伺服器不會帶 Supabase 的 JWT。
 *    因此**這個端點對全世界公開**，安全完全依賴 LINE 簽章驗證。
 *
 * 【簽章驗證不可省略，也不可「失敗就放行」】
 * user_records 是 append-only：假資料寫進去就永遠拔不掉，
 * 而它正是 G4「人工執行一致率」的依據。任何人都能對這個端點送 POST，
 * 不驗簽章等於任何人都能偽造你的交易紀錄。
 * 驗證失敗一律回 401，不記錄、不回覆、不重試。
 *
 * 【只寫紀錄，永遠不下單】
 * 這支程式沒有任何下單能力，也不呼叫任何券商 API。
 * v1 的定位是「通知與紀錄，不下單」（CLAUDE.md）。
 *
 * ⚠️ 本程式不印出任何憑證內容。
 *
 * 註：Deno 環境，與 src/ 的 Node 程式不共用模組。指令解析邏輯在此處重寫一份，
 *     並以 src/lib/l4/__tests__/commands.test.ts 的案例為準——
 *     兩邊行為若不一致，webhook-parity.test.ts 會紅。
 */

// @ts-nocheck -- Deno 執行環境，非本專案 tsconfig 的編譯目標

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

const CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET') ?? '';
const CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
/** 只接受這個使用者的指令。留空表示不限制（不建議）。 */
const ALLOWED_USER_ID = Deno.env.get('LINE_USER_ID') ?? '';

const ACTION_WORDS = new Map([
  ['買', 'buy'],
  ['買進', 'buy'],
  ['賣', 'sell'],
  ['賣出', 'sell'],
  ['觀望', 'watch'],
  ['略過', 'skip'],
  ['跳過', 'skip'],
  ['備註', 'note'],
]);

const ACTION_LABEL = {
  buy: '買進',
  sell: '賣出',
  watch: '觀望',
  skip: '略過',
  note: '備註',
};

const HELP_TEXT = [
  '📖 指令說明',
  '',
  '【紀錄你自己做了什麼】',
  '/rec 買 2330 100 580.5',
  '/rec 賣 2330 100 610',
  '/rec 觀望 6121 想再等等',
  '/rec 略過 1560 沒錢了',
  '/rec 備註 今天大盤怪怪的',
  '',
  '格式：/rec 動作 代號 股數 價格',
  '　　　觀望／略過：/rec 動作 代號 [原因]',
  '　　　備註：/rec 備註 內容',
  '',
  '【其他】',
  '/today　重看今天的清單',
  '/status　系統狀態',
  '/help　這則說明',
  '',
  '⚠️ 這些指令只做紀錄，不會下單。',
  'v1 不具備任何下單功能。',
].join('\n');

const USAGE_HINT = '格式：/rec 買 2330 100 580.5\n輸入 /help 看完整說明';
const CODE_RE = /^[0-9A-Z]{4,6}$/;

function parseNumber(token) {
  if (token === undefined) return null;
  const value = Number(String(token).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function parseCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'ignored' };

  const parts = trimmed.split(/\s+/);
  const command = (parts[0] ?? '').toLowerCase();
  const rest = parts.slice(1);

  if (command === '/help') return { kind: 'help' };
  if (command === '/today') return { kind: 'today' };
  if (command === '/status') return { kind: 'status' };
  if (command !== '/rec') {
    return { kind: 'error', message: `不認得指令 ${parts[0]}。\n輸入 /help 看可用指令。` };
  }

  const actionWord = rest[0];
  if (actionWord === undefined) {
    return { kind: 'error', message: `/rec 後面要接動作。\n${USAGE_HINT}` };
  }
  const action = ACTION_WORDS.get(actionWord);
  if (action === undefined) {
    return {
      kind: 'error',
      message: `不認得動作「${actionWord}」。\n可用：買、賣、觀望、略過、備註\n${USAGE_HINT}`,
    };
  }

  if (action === 'note') {
    const note = rest.slice(1).join(' ').trim();
    if (note === '') {
      return { kind: 'error', message: '備註內容不可空白。\n例：/rec 備註 今天大盤怪怪的' };
    }
    return { kind: 'rec', action, code: null, shares: null, price: null, note };
  }

  const code = rest[1] === undefined ? undefined : String(rest[1]).toUpperCase();
  if (code === undefined) {
    return { kind: 'error', message: `「${actionWord}」後面要接股票代號。\n${USAGE_HINT}` };
  }
  if (!CODE_RE.test(code)) {
    return {
      kind: 'error',
      message: `「${code}」看起來不像股票代號（應為 4～6 碼英數）。\n${USAGE_HINT}`,
    };
  }

  if (action === 'watch' || action === 'skip') {
    const note = rest.slice(2).join(' ').trim();
    return { kind: 'rec', action, code, shares: null, price: null, note: note === '' ? null : note };
  }

  const shares = parseNumber(rest[2]);
  const price = parseNumber(rest[3]);
  if (shares === null || price === null) {
    return { kind: 'error', message: `「${actionWord}」需要股數與價格。\n${USAGE_HINT}` };
  }
  if (!Number.isInteger(shares) || shares <= 0) {
    return { kind: 'error', message: `股數要是正整數，收到「${rest[2]}」。` };
  }
  if (price <= 0) {
    return { kind: 'error', message: `價格要大於 0，收到「${rest[3]}」。` };
  }
  const note = rest.slice(4).join(' ').trim();
  return { kind: 'rec', action, code, shares, price, note: note === '' ? null : note };
}

function confirmationText(cmd, dataAsOf) {
  const lines = [`✅ 已記錄：${ACTION_LABEL[cmd.action]}`];
  if (cmd.code !== null) lines.push(`代號　${cmd.code}`);
  if (cmd.shares !== null && cmd.price !== null) {
    lines.push(`數量　${cmd.shares.toLocaleString()} 股 @ ${cmd.price}`);
    lines.push(`金額　約 ${Math.round(cmd.shares * cmd.price).toLocaleString()} 元（未計手續費）`);
  }
  if (cmd.note !== null) lines.push(`備註　${cmd.note}`);
  if (dataAsOf !== null) lines.push(`對應清單　${dataAsOf}`);
  lines.push('');
  lines.push('紀錄不可修改。打錯的話再送一次，');
  lines.push('同一天同一檔以最後一筆為準。');
  return lines.join('\n');
}

function verifySignature(rawBody, signature) {
  if (!signature || CHANNEL_SECRET === '') return false;
  const expected = createHmac('sha256', CHANNEL_SECRET).update(rawBody, 'utf8').digest();
  let received;
  try {
    received = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}

async function supabase(path, init = {}) {
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

/** 最新一份真實清單的資料日（探針 revision ≥ 1000 一律排除） */
async function latestDataAsOf() {
  const res = await supabase(
    'daily_picks?select=data_as_of&revision=lt.1000&order=data_as_of.desc&limit=1',
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.data_as_of ?? null;
}

async function todayText() {
  const dataAsOf = await latestDataAsOf();
  if (dataAsOf === null) return '目前還沒有任何清單。';

  const [signalsRes, watchRes] = await Promise.all([
    supabase(
      `daily_picks?select=rank,code,name,market,entry_price,stop_price,take_profit_price,shares` +
        `&data_as_of=eq.${dataAsOf}&list_kind=eq.trade_signal&revision=lt.1000&order=rank.asc`,
    ),
    supabase(
      `daily_picks?select=rank,code,name,market,price_at_push,composite_score` +
        `&data_as_of=eq.${dataAsOf}&list_kind=eq.watchlist&revision=lt.1000&order=rank.asc`,
    ),
  ]);
  const signals = signalsRes.ok ? await signalsRes.json() : [];
  const watch = watchRes.ok ? await watchRes.json() : [];

  const lines = [`📊 ${dataAsOf} 的清單`, '', '━━━ 交易訊號 ━━━'];
  if (signals.length === 0) {
    lines.push('0 檔。（0 檔是正常的）');
  } else {
    for (const s of signals) {
      lines.push(
        `${s.rank}. ${s.code} ${s.name}　${s.shares} 股`,
        `　進 ${s.entry_price}　損 ${s.stop_price}　利 ${s.take_profit_price}`,
      );
    }
  }
  lines.push('', '━━━ 觀察榜 ━━━', '⚠️ 研究紀錄，不是買進建議');
  for (const w of watch) {
    lines.push(`${w.rank}. ${w.code} ${w.name}　${w.price_at_push}　分數 ${Number(w.composite_score).toFixed(3)}`);
  }
  lines.push('', '本內容由 AI 系統自動產生，不構成投資建議。');
  return lines.join('\n');
}

async function statusText() {
  const dataAsOf = await latestDataAsOf();
  const res = await supabase(
    'risk_config?select=version,registered_at&order=registered_at.desc&limit=1',
  );
  const cfg = res.ok ? (await res.json())[0] : null;
  return [
    '🔧 系統狀態',
    '',
    `最新清單日　${dataAsOf ?? '尚無'}`,
    `風控設定　　${cfg?.version ?? '未登記'}`,
    '',
    'v1 不下單。自動下單需通過 G1–G5 五道閘門。',
  ].join('\n');
}

async function reply(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.slice(0, 5000) }] }),
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // ⚠️ 必須拿**未經解析的原始 body**。JSON.parse 再 stringify 會改變
  //    空白與鍵序，簽章必定對不上。
  const rawBody = await req.text();
  if (!verifySignature(rawBody, req.headers.get('x-line-signature'))) {
    // 不記錄、不回覆、不重試。這是唯一擋住偽造紀錄的機制。
    return new Response('Unauthorized', { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  for (const event of payload.events ?? []) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue;
    // 只接受指定使用者的指令。v1 是單人系統。
    if (ALLOWED_USER_ID !== '' && event.source?.userId !== ALLOWED_USER_ID) continue;

    const text = event.message.text ?? '';
    const parsed = parseCommand(text);

    if (parsed.kind === 'ignored') continue;
    if (parsed.kind === 'help') {
      await reply(event.replyToken, HELP_TEXT);
      continue;
    }
    if (parsed.kind === 'today') {
      await reply(event.replyToken, await todayText());
      continue;
    }
    if (parsed.kind === 'status') {
      await reply(event.replyToken, await statusText());
      continue;
    }
    if (parsed.kind === 'error') {
      await reply(event.replyToken, `⚠️ ${parsed.message}`);
      continue;
    }

    const dataAsOf = await latestDataAsOf();
    const insert = await supabase('user_records', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([
        {
          recorded_at: new Date(event.timestamp).toISOString(),
          data_as_of: dataAsOf,
          source: 'line',
          line_message_id: event.message.id ?? null,
          action: parsed.action,
          code: parsed.code,
          shares: parsed.shares,
          price: parsed.price,
          note: parsed.note,
          raw_text: text,
        },
      ]),
    });

    if (insert.status === 201) {
      await reply(event.replyToken, confirmationText(parsed, dataAsOf));
    } else if (insert.status === 409) {
      // webhook 重送。已經記過了，不是錯誤。
      await reply(event.replyToken, '（這則訊息已經記錄過了）');
    } else {
      const body = await insert.text();
      await reply(
        event.replyToken,
        `⚠️ 寫入失敗（HTTP ${insert.status}）。\n紀錄沒有存進去，請稍後再試一次。`,
      );
      console.error('user_records insert failed', insert.status, body.slice(0, 300));
    }
  }

  // LINE 要求快速回 200，否則會重送
  return new Response('OK', { status: 200 });
});
