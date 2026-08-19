import { describe, expect, it } from 'vitest';

import type { Announcement } from '../types';
import {
  MIN_QUOTE_CHARS,
  extractJsonObject,
  parseResponse,
  stripWhitespace,
  toVerdict,
  verifyQuote,
} from '../verdict';

/**
 * 這則公告的欄位與原文取自 2026-08-15 實際抓到的 TWSE 重大訊息快照
 * （data/raw/mops_twse_material_announcements/2026-08-15），
 * 只截取片段以縮短測試。原文的 \r\n 與縮排刻意保留，那正是要驗的東西。
 */
const ITEM: Announcement = {
  sourceId: 'mops_twse_material_announcements',
  code: '7835',
  market: 'TWSE',
  speakDate: '2026-08-15',
  clause: '第51款',
  subject: '公告更正本公司115年第二季合併財務報告iXBRL會計師\r\n意見種類及財務報告公告說明事項',
  detail:
    '1.事實發生日:115/08/14\n2.公司名稱:永悅健康股份有限公司\n' +
    '5.發生緣由:\n  (1)更正115年第二季合併財報iXBRL會計師意見種類\n' +
    '9.因應措施:發布重大訊息後，重新上傳至公開資訊觀測站。',
  contentHash: 'a'.repeat(64),
  itemKey: 'TWSE:7835:2026-08-15:aaaaaaaaaaaa',
};

describe('extractJsonObject — 容忍模型在 JSON 前後多寫字', () => {
  it('取出裸 JSON', () => {
    expect(extractJsonObject('{"verdict":"no_veto"}')).toBe('{"verdict":"no_veto"}');
  });

  it('前後有敘述文字也取得到', () => {
    const raw = '好的，我的判斷如下：\n{"verdict":"no_veto","quote":""}\n希望有幫助。';
    expect(extractJsonObject(raw)).toBe('{"verdict":"no_veto","quote":""}');
  });

  it('包在程式碼區塊裡也取得到', () => {
    expect(extractJsonObject('```json\n{"verdict":"veto"}\n```')).toBe('{"verdict":"veto"}');
  });

  it('字串裡的大括號不會讓括號配對錯亂', () => {
    const raw = '{"verdict":"no_veto","reason":"公告寫 {不適用}"}';
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it('字串裡的跳脫引號不會提前結束', () => {
    const raw = '{"verdict":"no_veto","reason":"他說\\"不適用\\""}';
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it('沒有 JSON 就回 null', () => {
    expect(extractJsonObject('我認為不需要否決。')).toBeNull();
  });
});

describe('parseResponse — 只認 veto / no_veto 兩個值', () => {
  it('模型自創第三種答案視為解析失敗，不猜它的意思', () => {
    for (const invented of ['buy', 'neutral', 'warning', 'strong_buy', '']) {
      const parsed = parseResponse(JSON.stringify({ verdict: invented }));
      expect(parsed.ok).toBe(false);
      expect(parsed.verdict).toBe('no_veto');
    }
  });

  it('JSON 壞掉時解析失敗', () => {
    expect(parseResponse('{"verdict":').ok).toBe(false);
  });

  it('正常回應解析成功', () => {
    const parsed = parseResponse('{"verdict":"veto","quote":"abc","reason":"r"}');
    expect(parsed).toMatchObject({ ok: true, verdict: 'veto', quote: 'abc', reason: 'r' });
  });
});

describe('verifyQuote — 引用必須真的在原文裡', () => {
  it('逐字引用通過', () => {
    expect(verifyQuote('更正115年第二季合併財報iXBRL會計師意見種類', ITEM)).toBe(true);
  });

  it('跨越原文換行與縮排的引用也通過（只忽略空白）', () => {
    // 原文在「會計師」與「意見種類」之間有一個 \r\n
    expect(verifyQuote('合併財務報告iXBRL會計師意見種類', ITEM)).toBe(true);
  });

  it('原文沒有的句子驗不過——這就是幻覺的攔截點', () => {
    expect(verifyQuote('本公司遭銀行拒絕往來並列為全額交割股', ITEM)).toBe(false);
  });

  it('改寫一個字就驗不過', () => {
    expect(verifyQuote('更正115年第三季合併財報iXBRL會計師意見種類', ITEM)).toBe(false);
  });

  it(`短於 ${MIN_QUOTE_CHARS} 個非空白字元一律驗不過`, () => {
    expect(verifyQuote('。', ITEM)).toBe(false);
    expect(verifyQuote('   ', ITEM)).toBe(false);
    expect(verifyQuote('', ITEM)).toBe(false);
  });

  it('全形空格也算空白', () => {
    expect(stripWhitespace('更正　115　年')).toBe('更正115年');
  });
});

describe('toVerdict — 只能否決的最後一道程式閘門', () => {
  it('解析失敗必定 no_veto，且記為 parseOk=false', () => {
    const v = toVerdict('k', ITEM, '我覺得應該要小心一點', 12);
    expect(v.verdict).toBe('no_veto');
    expect(v.parseOk).toBe(false);
    expect(v.evidenceVerified).toBe(false);
    expect(v.rawResponse).toBe('我覺得應該要小心一點');
  });

  it('判否決但引用是幻覺 → 作廢改判 no_veto，並留下證據', () => {
    const raw = JSON.stringify({
      verdict: 'veto',
      quote: '本公司遭銀行拒絕往來並列為全額交割股',
      reason: '銀行拒往',
    });
    const v = toVerdict('k', ITEM, raw, 30);
    expect(v.verdict).toBe('no_veto');
    expect(v.parseOk).toBe(true);
    expect(v.evidenceVerified).toBe(false);
    expect(v.quotedEvidence).toContain('拒絕往來');
    expect(v.reason).toContain('引用與原文不完全一致');
    // 不得宣稱那是幻覺——本檢查分不出捏造與簡繁／近義字轉寫
    expect(v.reason).toContain('本檢查無法區分');
  });

  it('判否決且引用屬實 → 否決成立', () => {
    const raw = JSON.stringify({
      verdict: 'veto',
      quote: '更正115年第二季合併財報iXBRL會計師意見種類',
      reason: '財報更正',
    });
    const v = toVerdict('k', ITEM, raw, 30);
    expect(v.verdict).toBe('veto');
    expect(v.evidenceVerified).toBe(true);
  });

  it('no_veto 不需要引用', () => {
    const v = toVerdict('k', ITEM, '{"verdict":"no_veto","quote":"","reason":"例行公告"}', 5);
    expect(v.verdict).toBe('no_veto');
    expect(v.parseOk).toBe(true);
    expect(v.quotedEvidence).toBe('');
  });

  it('無論模型回什麼，verdict 永遠只會是那兩個值之一', () => {
    const responses = [
      '{"verdict":"buy","quote":"x"}',
      '{"verdict":"veto","quote":"不存在的句子不存在的句子"}',
      'garbage',
      '{"verdict":"no_veto"}',
      '{}',
      '{"verdict":"veto","quote":"更正115年第二季合併財報iXBRL會計師意見種類"}',
    ];
    for (const raw of responses) {
      expect(['veto', 'no_veto']).toContain(toVerdict('k', ITEM, raw, 1).verdict);
    }
  });
});

/**
 * 2026-08-19 實測回歸：qwen2.5:3b 的 3 次「引用不符」全部不是幻覺，
 * 而是簡體字或近義字轉寫。這組測試把那三種真實情況釘住，
 * 確保日後有人放寬比對規則時，會先看到這裡寫的取捨。
 */
describe('引用不符的三種真實成因（2026-08-19 實測）', () => {
  const item: Announcement = {
    sourceId: 's',
    code: '2425',
    market: 'TWSE',
    speakDate: '2026-08-18',
    clause: '第20款',
    subject: '公告本公司召開重大訊息說明記者會內容',
    detail:
      '鑒於美國商務部於113年4月將本公司透過子公司景弘，間接持有之子公司思騰合力(天津)' +
      '科技有限公司列入實體清單中，對於集團後續營運及管理帶來極大不確定性。' +
      '因思騰合力天津公司未在公開市場交易且被美國商務部列入實體清單中，不易洽詢潛在買家。' +
      '為提升經濟效益，爰擬拆除現有廠房及相關設備。',
    contentHash: 'x'.repeat(64),
    itemKey: 'k',
  };

  it('簡體字轉寫驗不過（模型實際輸出）', () => {
    expect(verifyQuote('美國商务部列入实体清单中，不易洽询潜在买家', item)).toBe(false);
  });

  it('「鑒」寫成「鑑」驗不過——這不是簡繁，是換了一個字', () => {
    expect(verifyQuote('鑑於美國商務部於113年4月將本公司', item)).toBe(false);
    expect(verifyQuote('鑒於美國商務部於113年4月將本公司', item)).toBe(true);
  });

  it('「爰擬」寫成「為擬」驗不過', () => {
    expect(verifyQuote('為提升經濟效益，為擬拆除現有廠房', item)).toBe(false);
    expect(verifyQuote('為提升經濟效益，爰擬拆除現有廠房', item)).toBe(true);
  });

  it('真正的幻覺一樣驗不過——放寬規則的風險就在這裡分不出來', () => {
    expect(verifyQuote('本公司遭銀行拒絕往來並列為全額交割股', item)).toBe(false);
  });

  it('作廢時的說明不得斷言是幻覺', () => {
    const raw = JSON.stringify({ verdict: 'veto', quote: '美國商务部列入实体清单中', reason: 'r' });
    const v = toVerdict('k', item, raw, 1);
    expect(v.verdict).toBe('no_veto');
    expect(v.evidenceVerified).toBe(false);
    expect(v.reason).not.toContain('找不到');
    expect(v.reason).toContain('本檢查無法區分');
  });
});
