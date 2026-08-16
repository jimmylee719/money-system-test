import { describe, expect, it } from 'vitest';
import { HELP_TEXT, confirmationText, parseCommand } from '../line/commands';
import type { RecCommand } from '../line/commands';

function rec(text: string): RecCommand {
  const parsed = parseCommand(text);
  if (parsed.kind !== 'rec') {
    throw new Error(`預期解析成 rec，實際為 ${parsed.kind}：${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function errorOf(text: string): string {
  const parsed = parseCommand(text);
  if (parsed.kind !== 'error') {
    throw new Error(`預期解析失敗，實際為 ${parsed.kind}`);
  }
  return parsed.message;
}

describe('買賣紀錄', () => {
  it('/rec 買 2330 100 580.5', () => {
    expect(rec('/rec 買 2330 100 580.5')).toEqual({
      kind: 'rec',
      action: 'buy',
      code: '2330',
      shares: 100,
      price: 580.5,
      note: null,
    });
  });

  it('「買進」「賣出」也認得', () => {
    expect(rec('/rec 買進 2330 100 580').action).toBe('buy');
    expect(rec('/rec 賣出 2330 100 610').action).toBe('sell');
  });

  it('價格帶千分位逗號也解析得出來', () => {
    expect(rec('/rec 買 2330 100 1,250').price).toBe(1250);
  });

  it('多餘的字視為備註', () => {
    expect(rec('/rec 買 2330 100 580 停損設在 560').note).toBe('停損設在 560');
  });

  it('零股股數（非整張）完全正常', () => {
    expect(rec('/rec 買 2330 24 580').shares).toBe(24);
  });

  it('缺股數或價格 → 不猜，回覆用法', () => {
    expect(errorOf('/rec 買 2330')).toContain('需要股數與價格');
    expect(errorOf('/rec 買 2330 100')).toContain('需要股數與價格');
  });

  it('股數不是正整數 → 拒絕', () => {
    expect(errorOf('/rec 買 2330 0 580')).toContain('正整數');
    expect(errorOf('/rec 買 2330 -5 580')).toContain('正整數');
    expect(errorOf('/rec 買 2330 10.5 580')).toContain('正整數');
  });

  it('價格非正數 → 拒絕', () => {
    expect(errorOf('/rec 買 2330 100 0')).toContain('價格要大於 0');
  });
});

describe('觀望／略過／備註', () => {
  it('觀望可帶原因', () => {
    expect(rec('/rec 觀望 6121 想再等等')).toEqual({
      kind: 'rec',
      action: 'watch',
      code: '6121',
      shares: null,
      price: null,
      note: '想再等等',
    });
  });

  it('觀望不帶原因也可以', () => {
    expect(rec('/rec 觀望 6121').note).toBeNull();
  });

  it('略過與跳過同義', () => {
    expect(rec('/rec 略過 1560 沒錢').action).toBe('skip');
    expect(rec('/rec 跳過 1560').action).toBe('skip');
  });

  it('備註沒有代號，後面全是內容', () => {
    expect(rec('/rec 備註 今天大盤怪怪的')).toEqual({
      kind: 'rec',
      action: 'note',
      code: null,
      shares: null,
      price: null,
      note: '今天大盤怪怪的',
    });
  });

  it('備註內容空白 → 拒絕', () => {
    expect(errorOf('/rec 備註')).toContain('不可空白');
  });
});

describe('股票代號', () => {
  it('接受 4 碼與 6 碼（第一上市外國公司是 6 碼）', () => {
    expect(rec('/rec 觀望 2330').code).toBe('2330');
    expect(rec('/rec 觀望 910322').code).toBe('910322');
  });

  it('接受帶英文字母的代號並轉大寫', () => {
    expect(rec('/rec 觀望 00400a').code).toBe('00400A');
  });

  it('不像代號的東西 → 拒絕，不寫進 append-only 的表', () => {
    expect(errorOf('/rec 觀望 台積電')).toContain('不像股票代號');
    expect(errorOf('/rec 觀望 12')).toContain('不像股票代號');
    expect(errorOf('/rec 觀望 1234567')).toContain('不像股票代號');
  });
});

describe('其他指令與非指令', () => {
  it('/help /today /status', () => {
    expect(parseCommand('/help').kind).toBe('help');
    expect(parseCommand('/today').kind).toBe('today');
    expect(parseCommand('/status').kind).toBe('status');
    expect(parseCommand('/HELP').kind).toBe('help'); // 大小寫不敏感
  });

  it('不以 / 開頭的訊息一律忽略，不回覆', () => {
    expect(parseCommand('今天天氣真好').kind).toBe('ignored');
    expect(parseCommand('2330 可以買嗎').kind).toBe('ignored');
  });

  it('不認得的指令 → 提示 /help', () => {
    expect(errorOf('/buy 2330')).toContain('不認得指令');
  });

  it('不認得的動作 → 列出可用動作', () => {
    expect(errorOf('/rec 梭哈 2330 100 580')).toContain('可用：買、賣、觀望、略過、備註');
  });

  it('說明文字明確聲明不會下單', () => {
    expect(HELP_TEXT).toContain('只做紀錄，不會下單');
    expect(HELP_TEXT).toContain('v1 不具備任何下單功能');
  });
});

describe('確認訊息', () => {
  it('買進的確認包含金額估算與不可修改的提醒', () => {
    const text = confirmationText(rec('/rec 買 2330 24 580'), '2026-08-17');
    expect(text).toContain('買進');
    expect(text).toContain('2330');
    expect(text).toContain('24 股 @ 580');
    expect(text).toContain('13,920'); // 24 × 580
    expect(text).toContain('2026-08-17');
    expect(text).toContain('紀錄不可修改');
  });

  it('觀望的確認不會出現金額', () => {
    const text = confirmationText(rec('/rec 觀望 6121 等回檔'), null);
    expect(text).toContain('觀望');
    expect(text).not.toContain('金額');
    expect(text).toContain('等回檔');
  });
});
