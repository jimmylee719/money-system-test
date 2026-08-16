import { describe, expect, it } from 'vitest';
import {
  createParseStats,
  parseInteger,
  parseNumeric,
  parseNumericOrNote,
  parseText,
} from '../parse';

describe('parseNumeric — 規則全部來自 2026-08-16 實測的真實資料', () => {
  it('解析一般數值', () => {
    expect(parseNumeric('14.79')).toBe(14.79);
    expect(parseNumeric('0')).toBe(0);
    expect(parseNumeric(42)).toBe(42);
  });

  it('去除千分位逗號（TWSE 個股三大法人：「250,897,716」）', () => {
    expect(parseNumeric('250,897,716')).toBe(250897716);
    expect(parseNumeric('-1,234.5')).toBe(-1234.5);
  });

  it('處理上櫃行情的尾隨空格與前導正號（「-0.72 」「+0.02」）', () => {
    expect(parseNumeric('-0.72 ')).toBe(-0.72);
    expect(parseNumeric('+0.02')).toBe(0.02);
    expect(parseNumeric('  14.79  ')).toBe(14.79);
  });

  it('官方的缺值表示一律回 null，不是 0', () => {
    // 沒有本益比與本益比為 0 是完全不同的兩件事
    expect(parseNumeric('')).toBe(null); // TWSE 本益比（虧損公司）
    expect(parseNumeric(' ---')).toBe(null); // 上櫃行情當日無成交
    expect(parseNumeric('-')).toBe(null); // MI_INDEX 漲跌
    expect(parseNumeric('--')).toBe(null);
    expect(parseNumeric(null)).toBe(null);
    expect(parseNumeric(undefined)).toBe(null);
  });

  it('負數不會被誤判為缺值', () => {
    // "-" 是缺值，"-0.06" 是真的負數，兩者必須分得開
    expect(parseNumeric('-0.0600')).toBe(-0.06);
    expect(parseNumeric('-5')).toBe(-5);
  });

  it('未知的內容回 null 並計入 unparsable，不靜默當成缺值', () => {
    // 用真正沒見過的值。已知的官方缺值 token（如 N/A）另有測試，
    // 兩者必須分得開——否則新的格式變動會被當成缺值吞掉。
    const stats = createParseStats();
    expect(parseNumeric('約 100', stats)).toBe(null);
    expect(parseNumeric('停止交易', stats)).toBe(null);
    expect(stats.unparsable).toBe(2);
    expect(stats.blank).toBe(0);
    expect(stats.unparsableSamples).toEqual(['約 100', '停止交易']);
  });

  it('上櫃用 N/A 表示缺值（實測 218 筆），上市用空字串', () => {
    const stats = createParseStats();
    expect(parseNumeric('N/A', stats)).toBe(null);
    expect(parseNumeric('n/a', stats)).toBe(null);
    expect(stats.blank).toBe(2);
    expect(stats.unparsable).toBe(0);
  });

  it('缺值與解析失敗分開計數 —— 前者正常，後者是格式變動的警訊', () => {
    const stats = createParseStats();
    parseNumeric('1.5', stats);
    parseNumeric('', stats);
    parseNumeric(' ---', stats);
    parseNumeric('壞掉了', stats);
    expect(stats).toMatchObject({ parsed: 1, blank: 2, unparsable: 1 });
  });
});

describe('parseNumericOrNote —— 官方註記是資訊，不是缺值', () => {
  it('保留除權息註記（上櫃漲跌欄，實測 3 筆）', () => {
    // 除權息日的漲跌不是「沒有」，是「不可直接比較」。
    // P9 算報酬時必須把除權息還原，丟掉這個欄位會低估報酬。
    const stats = createParseStats();
    expect(parseNumericOrNote('除權 ', stats)).toEqual({ value: null, note: '除權' });
    expect(parseNumericOrNote('除息 ', stats)).toEqual({ value: null, note: '除息' });
    expect(parseNumericOrNote('除權息', stats)).toEqual({ value: null, note: '除權息' });
    expect(stats.noted).toBe(3);
    expect(stats.blank).toBe(0);
    expect(stats.unparsable).toBe(0);
  });

  it('一般數值照常解析，note 為 null', () => {
    const stats = createParseStats();
    expect(parseNumericOrNote('-0.72 ', stats)).toEqual({ value: -0.72, note: null });
    expect(stats.parsed).toBe(1);
    expect(stats.noted).toBe(0);
  });

  it('未知的非數值仍計為 unparsable —— 新的格式變動不會被吞掉', () => {
    const stats = createParseStats();
    expect(parseNumericOrNote('停牌', stats)).toEqual({ value: null, note: null });
    expect(stats.unparsable).toBe(1);
    expect(stats.noted).toBe(0);
  });

  it('unparsableSamples 最多保留 10 筆，不會無限成長', () => {
    const stats = createParseStats();
    for (let i = 0; i < 30; i += 1) {
      parseNumeric(`bad${i}`, stats);
    }
    expect(stats.unparsable).toBe(30);
    expect(stats.unparsableSamples).toHaveLength(10);
  });
});

describe('parseInteger', () => {
  it('接受整數與帶逗號的整數', () => {
    expect(parseInteger('49694719')).toBe(49694719);
    expect(parseInteger('250,897,716')).toBe(250897716);
  });

  it('小數視為解析失敗，不四捨五入 —— 股數不會有小數', () => {
    const stats = createParseStats();
    expect(parseInteger('12.5', stats)).toBe(null);
    expect(stats.unparsable).toBe(1);
    expect(stats.parsed).toBe(0);
  });

  it('缺值仍為 null', () => {
    expect(parseInteger('')).toBe(null);
    expect(parseInteger(' ---')).toBe(null);
  });
});

describe('parseText', () => {
  it('去除官方值的前後空白（上櫃證券名稱「主動統一升級50  」）', () => {
    expect(parseText('主動統一升級50  ')).toBe('主動統一升級50');
    expect(parseText('  1101 ')).toBe('1101');
  });

  it('非字串回空字串', () => {
    expect(parseText(null)).toBe('');
    expect(parseText(123)).toBe('');
  });
});
