import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LINE_TEXT_LIMIT, LineApiError, LineClient, splitForLine, verifyLineSignature } from '../line/client';

const SECRET = 'test-channel-secret-not-a-real-one';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

describe('webhook 簽章驗證', () => {
  const body = '{"events":[{"type":"message"}]}';

  it('正確簽章通過', () => {
    expect(verifyLineSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('body 被改一個字元就不通過', () => {
    expect(verifyLineSignature(`${body} `, sign(body), SECRET)).toBe(false);
  });

  it('用別的 secret 簽的不通過', () => {
    expect(verifyLineSignature(body, sign(body, 'other-secret'), SECRET)).toBe(false);
  });

  it('缺簽章一律不通過（不是「沒帶就放行」）', () => {
    expect(verifyLineSignature(body, null, SECRET)).toBe(false);
    expect(verifyLineSignature(body, '', SECRET)).toBe(false);
  });

  it('長度不同的簽章不通過，且不會拋錯', () => {
    expect(verifyLineSignature(body, 'YWJj', SECRET)).toBe(false);
  });

  it('非 base64 的垃圾字串不通過', () => {
    expect(verifyLineSignature(body, '!!!not base64!!!', SECRET)).toBe(false);
  });

  it('對相同輸入是穩定的（不是隨機通過）', () => {
    const s = sign(body);
    for (let i = 0; i < 20; i += 1) {
      expect(verifyLineSignature(body, s, SECRET)).toBe(true);
    }
  });
});

describe('訊息切分', () => {
  it('未超過上限時原樣回傳一則', () => {
    expect(splitForLine('短訊息')).toEqual(['短訊息']);
  });

  it('超過上限時在換行處切，不切在字中間', () => {
    const line = 'x'.repeat(100);
    const text = Array.from({ length: 60 }, () => line).join('\n');
    const chunks = splitForLine(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
      // 每一段都應該由完整的行組成
      for (const l of chunk.split('\n')) {
        expect(l).toBe(line);
      }
    }
    // 內容不可遺失
    expect(chunks.join('\n')).toBe(text);
  });

  it('單行本身超長時才硬切', () => {
    const chunks = splitForLine('y'.repeat(2500), 1000);
    expect(chunks).toHaveLength(3);
    expect(chunks.join('')).toBe('y'.repeat(2500));
  });

  it('日報被截斷會讓最後幾檔悄悄消失，所以是拆不是截', () => {
    const text = Array.from({ length: 200 }, (_, i) => `第 ${i} 行`).join('\n');
    const chunks = splitForLine(text, 500);
    expect(chunks.join('\n')).toBe(text);
    expect(chunks.join('\n')).toContain('第 199 行');
  });

  it('官方上限常數為 5000', () => {
    expect(LINE_TEXT_LIMIT).toBe(5000);
  });
});

describe('推播', () => {
  it('送出正確的端點、標頭與 body', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const client = new LineClient({
      channelAccessToken: 'fake-token',
      fetchImpl: (async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch,
    });

    await client.pushText('U1234', '測試訊息');

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://api.line.me/v2/bot/message/push');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer fake-token');
    expect(JSON.parse(captured!.init.body as string)).toEqual({
      to: 'U1234',
      messages: [{ type: 'text', text: '測試訊息' }],
    });
  });

  it('LINE 回錯誤時拋出，且錯誤訊息不含憑證', async () => {
    const client = new LineClient({
      channelAccessToken: 'super-secret-token-value',
      fetchImpl: (async () =>
        new Response('{"message":"Invalid to"}', { status: 400 })) as unknown as typeof fetch,
    });

    await expect(client.pushText('U1', 'x')).rejects.toThrow(LineApiError);
    await expect(client.pushText('U1', 'x')).rejects.toThrow(/400/);
    // 憑證絕不可出現在錯誤訊息裡
    await client.pushText('U1', 'x').catch((e: unknown) => {
      expect(String(e)).not.toContain('super-secret-token-value');
    });
  });

  it('拆成超過 5 則時拒絕送出，而不是丟掉多的', async () => {
    const client = new LineClient({
      channelAccessToken: 'fake',
      fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    });
    const huge = 'z'.repeat(LINE_TEXT_LIMIT * 6);
    await expect(client.pushText('U1', huge)).rejects.toThrow(/超過單次上限/);
  });
});
