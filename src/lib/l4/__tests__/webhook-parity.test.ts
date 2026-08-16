/**
 * webhook（Deno）與 Node 端的指令解析必須行為一致。
 *
 * 【為什麼會有兩份】
 * Supabase Edge Function 跑在 Deno，無法直接 import 本專案 src/ 底下的模組，
 * 所以 supabase/functions/line-webhook/index.ts 重寫了一份解析邏輯。
 *
 * 【為什麼一定要測】
 * 兩份實作只要有一份被改到，行為就會不一致，而且**完全沒有徵兆**：
 * 測試全綠、部署成功，只有實際傳訊息時才會發現「怎麼跟預期不一樣」。
 * 這個測試把 Deno 檔案裡的解析程式抽出來實際執行，用同一組案例比對兩邊結果。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELP_TEXT, parseCommand } from '../line/commands';
import type { ParsedCommand } from '../line/commands';

const WEBHOOK_PATH = join(process.cwd(), 'supabase', 'functions', 'line-webhook', 'index.ts');

/**
 * 從 Deno 原始碼抽出解析相關的區段並實際執行。
 * 抽取範圍是純 JavaScript（常數、正則、兩個函式），不含任何 Deno API。
 */
function loadWebhookParser(): {
  parseCommand: (text: string) => ParsedCommand;
  HELP_TEXT: string;
} {
  const source = readFileSync(WEBHOOK_PATH, 'utf8');
  const start = source.indexOf('const ACTION_WORDS');
  const end = source.indexOf('function confirmationText');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      'webhook 原始碼的結構變了，抽不出解析區段。' +
        '請確認 ACTION_WORDS 與 confirmationText 兩個標記仍然存在。',
    );
  }
  const snippet = source.slice(start, end);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(`${snippet}\nreturn { parseCommand, HELP_TEXT };`);
  return factory() as ReturnType<typeof loadWebhookParser>;
}

const webhook = loadWebhookParser();

/** 兩邊都必須產生相同結果的案例。涵蓋每一種動作與每一種錯誤。 */
const CASES: readonly string[] = [
  '/rec 買 2330 100 580.5',
  '/rec 買進 2330 24 580',
  '/rec 賣 2330 100 610',
  '/rec 賣出 2330 100 610',
  '/rec 買 2330 100 1,250',
  '/rec 買 2330 100 580 停損設在 560',
  '/rec 觀望 6121 想再等等',
  '/rec 觀望 6121',
  '/rec 略過 1560 沒錢',
  '/rec 跳過 1560',
  '/rec 備註 今天大盤怪怪的',
  '/rec 觀望 910322',
  '/rec 觀望 00400a',
  '/help',
  '/HELP',
  '/today',
  '/status',
  '今天天氣真好',
  '2330 可以買嗎',
  // 各種錯誤
  '/rec',
  '/rec 買',
  '/rec 買 2330',
  '/rec 買 2330 100',
  '/rec 買 2330 0 580',
  '/rec 買 2330 -5 580',
  '/rec 買 2330 10.5 580',
  '/rec 買 2330 100 0',
  '/rec 備註',
  '/rec 觀望 台積電',
  '/rec 觀望 12',
  '/rec 觀望 1234567',
  '/rec 梭哈 2330 100 580',
  '/buy 2330',
];

describe('Deno webhook 與 Node 的解析行為一致', () => {
  for (const text of CASES) {
    it(`「${text}」`, () => {
      expect(webhook.parseCommand(text)).toEqual(parseCommand(text) as unknown);
    });
  }

  it('說明文字兩邊逐字相同', () => {
    expect(webhook.HELP_TEXT).toBe(HELP_TEXT);
  });

  it('抽取機制本身有效（抽錯會拋錯而不是靜默通過）', () => {
    // 確認真的執行到了 Deno 那份，而不是不小心測到 Node 這份
    expect(webhook.parseCommand).not.toBe(parseCommand);
    expect(webhook.parseCommand('/rec 買 2330 100 580').kind).toBe('rec');
  });
});

describe('webhook 的安全要求', () => {
  const source = readFileSync(WEBHOOK_PATH, 'utf8');

  it('簽章驗證失敗時回 401，且沒有任何繞過分支', () => {
    expect(source).toContain('verifySignature(rawBody, req.headers.get(\'x-line-signature\'))');
    expect(source).toContain("return new Response('Unauthorized', { status: 401 })");
  });

  it('用未經解析的原始 body 驗簽（parse 過再 stringify 會對不上）', () => {
    expect(source).toContain('const rawBody = await req.text()');
  });

  it('比對用 timingSafeEqual，不是字串相等', () => {
    expect(source).toContain('timingSafeEqual');
    expect(source).not.toMatch(/signature\s*===\s*expected/);
  });

  it('對外連線只有 LINE 一個網域，其餘都走 SUPABASE_URL', () => {
    // v1 不下單，也不應該把資料送到任何第三方。
    // 這裡列舉原始碼裡所有的 https:// 字面值並比對白名單——
    // 哪天有人加了券商 API 或其他外部端點，這個測試就會紅。
    //
    // （早先的版本用 /order|broker|下單/ 做關鍵字比對，結果被自己的註解
    //   「v1 不下單」與 PostgREST 的 order= 參數誤判，那種測法沒有意義。）
    const hosts = new Set(
      [...source.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase()),
    );
    expect([...hosts].sort()).toEqual(['api.line.me']);
  });

  it('Supabase 呼叫一律經由 SUPABASE_URL 環境變數，網址不寫死', () => {
    expect(source).toContain('`${SUPABASE_URL}/rest/v1/${path}`');
  });

  it('只接受指定使用者的指令（v1 是單人系統）', () => {
    expect(source).toContain("event.source?.userId !== ALLOWED_USER_ID");
  });
});
