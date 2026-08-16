import { describe, expect, it } from 'vitest';
import {
  normalizeTpexAlteredTrading,
  normalizeTpexAttention,
  normalizeTpexDisposition,
  normalizeTpexSuspension,
  normalizeTwseAlteredTrading,
  normalizeTwseAttention,
  normalizeTwseDisposition,
  normalizeTwseSuspension,
  parseDispositionPeriod,
} from '../normalize';

describe('parseDispositionPeriod', () => {
  it('解析 TWSE 格式：斜線 + 全形波浪號', () => {
    // 2026-08-16 實測的官方原文
    expect(parseDispositionPeriod('115/08/12～115/08/18')).toEqual({
      start: '2026-08-12',
      end: '2026-08-18',
    });
  });

  it('解析 TPEx 格式：壓縮 + 半形波浪號', () => {
    expect(parseDispositionPeriod('1150817~1150821')).toEqual({
      start: '2026-08-17',
      end: '2026-08-21',
    });
  });

  it('兩種波浪號都接受（全形 U+FF5E 與半形）', () => {
    expect(parseDispositionPeriod('1150817～1150821').start).toBe('2026-08-17');
    expect(parseDispositionPeriod('115/08/17~115/08/21').start).toBe('2026-08-17');
  });

  it('格式無法辨識時回 null，不猜', () => {
    expect(parseDispositionPeriod('115年8月12日起五個營業日')).toEqual({ start: null, end: null });
    expect(parseDispositionPeriod('')).toEqual({ start: null, end: null });
    expect(parseDispositionPeriod('1150817')).toEqual({ start: null, end: null });
  });

  it('日期不存在時回 null（民國 115 年 2 月 30 日）', () => {
    expect(parseDispositionPeriod('1150230~1150305').start).toBeNull();
  });
});

describe('佔位列辨識（當日無公告不是空陣列）', () => {
  it('TWSE 注意股：全空佔位列不算一檔', () => {
    // 2026-08-16 實測的官方回應，逐字複製
    const payload = [
      {
        Number: '0',
        Code: '',
        Name: '',
        NumberOfAnnouncement: '0',
        TradingInfoForAttention: '',
        Date: '',
        ClosingPrice: '0',
        PE: '0',
      },
    ];
    const out = normalizeTwseAttention(payload);
    expect(out.rows).toHaveLength(0);
    expect(out.sourceRowCount).toBe(1);
    expect(out.placeholderRows).toBe(1);
  });

  it('TPEx 暫停交易：全空佔位列不算一檔', () => {
    const payload = [
      {
        Date: '20260816',
        SecuritiesCompanyCode: '',
        CompanyName: '',
        暫停交易: '',
        恢復交易: '',
      },
    ];
    const out = normalizeTpexSuspension(payload);
    expect(out.rows).toHaveLength(0);
    expect(out.placeholderRows).toBe(1);
  });
});

describe('注意股', () => {
  it('TPEx：逐字保留官方注意原因，不摘要', () => {
    const info =
      '最近六個營業日(含當日)累積之最後成交價漲幅達29.82%，當日之成交量較最近六十個營業日日平均成交量放大6.4倍(第三款)當日週轉率達23.17%(第四款)';
    const out = normalizeTpexAttention([
      {
        Date: '1150814',
        SecuritiesCompanyCode: '3490',
        CompanyName: '單井',
        TradingInformation: info,
        ClosePrice: '39.65',
        PriceEarningRatio: '6.27',
      },
    ]);
    expect(out.rows[0]).toEqual({
      code: '3490',
      market: 'TPEx',
      date: '2026-08-14',
      info,
    });
  });
});

describe('處置股', () => {
  it('TWSE：期間解析出來，公告日與處置期間是不同的兩件事', () => {
    const out = normalizeTwseDisposition([
      {
        Number: '1',
        Date: '1150811',
        Code: '2491',
        Name: '吉祥全',
        NumberOfAnnouncement: '2',
        ReasonsOfDisposition: '連續三次',
        DispositionPeriod: '115/08/12～115/08/18',
        DispositionMeasures: '第二次處置',
        Detail: '（略）',
        LinkInformation: '（略）',
      },
    ]);
    const row = out.rows[0]!;
    // 公告日 8/11，但處置期間是 8/12～8/18。只看公告日會判斷錯。
    expect(row.announcedDate).toBe('2026-08-11');
    expect(row.periodStart).toBe('2026-08-12');
    expect(row.periodEnd).toBe('2026-08-18');
    expect(row.periodRaw).toBe('115/08/12～115/08/18');
  });

  it('TPEx：期間格式不同但一樣解析得出來', () => {
    const out = normalizeTpexDisposition([
      {
        Date: '1150814',
        SecuritiesCompanyCode: '5475',
        CompanyName: '德宏',
        DispositionPeriod: '1150817~1150821',
        DispositionReasons: '最近10個營業日內有6個營業日',
        DisposalCondition: '（略）',
      },
    ]);
    expect(out.rows[0]!.periodStart).toBe('2026-08-17');
    expect(out.rows[0]!.periodEnd).toBe('2026-08-21');
  });
});

describe('暫停交易', () => {
  it('TWSE：停牌日與復牌日分開保留', () => {
    const out = normalizeTwseSuspension([
      {
        Number: '1',
        Code: '1218',
        Name: '泰山',
        TradingHaltDate: '1150813',
        TradingHaltTime: '080000',
        TradingResumptionDate: '1150814',
        TradingResumptionTime: '080000',
      },
    ]);
    expect(out.rows[0]!.haltDate).toBe('2026-08-13');
    expect(out.rows[0]!.resumptionDate).toBe('2026-08-14');
  });
});

describe('變更交易方法', () => {
  it('TWSE：列的存在本身即為變更交易，沒有旗標可判斷', () => {
    const out = normalizeTwseAlteredTrading([
      { Code: '1213', Name: '大飲', PeriodicCallAuctionTrading: '  ' },
      { Code: '1538', Name: '正峰新', PeriodicCallAuctionTrading: '**' },
    ]);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]!.alteredTrading).toBe(true);
    // "  "（兩個空格）不是旗標；"**" 才是
    expect(out.rows[0]!.periodicTrading).toBe(false);
    expect(out.rows[1]!.periodicTrading).toBe(true);
    // 原文逐字保留，不解讀成布林後就丟掉
    expect(out.rows[0]!.raw).toContain('"  "');
  });

  it('TPEx：旗標是全形 Ｙ，ASCII 的 Y 也接受，其餘皆為否', () => {
    const out = normalizeTpexAlteredTrading([
      {
        Date: '1150814',
        SecuritiesCompanyCode: '3064',
        CompanyName: '泰偉',
        AlteredTrading: 'Ｙ', // 全形
        PeriodicTrading: '',
        ManagedStock: '',
        MatchingFrequency: '',
        SuspensionOfTrading: '',
        ' FinancialAnnouncements': 'Ｙ',
      },
      {
        Date: '1150814',
        SecuritiesCompanyCode: '9999',
        CompanyName: '測試',
        AlteredTrading: '',
        PeriodicTrading: 'Y', // 半形也接受
        ManagedStock: 'N', // N 不是旗標
        MatchingFrequency: '030',
        SuspensionOfTrading: 'Ｙ',
        ' FinancialAnnouncements': '',
      },
    ]);
    expect(out.rows[0]!.alteredTrading).toBe(true);
    expect(out.rows[0]!.periodicTrading).toBe(false);

    expect(out.rows[1]!.alteredTrading).toBe(false);
    expect(out.rows[1]!.periodicTrading).toBe(true);
    expect(out.rows[1]!.managedStock).toBe(false);
    expect(out.rows[1]!.suspensionOfTrading).toBe(true);
  });
});
