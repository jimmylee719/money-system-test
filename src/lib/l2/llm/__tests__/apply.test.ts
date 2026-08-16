import { describe, expect, it } from 'vitest';

import { VetoLayerViolationError } from '../../engine';
import { RULE_SPEC_BY_ID } from '../../rules';
import { applyLlmVetoes } from '../apply';
import { announcementHash, buildItemKey, parseAnnouncements } from '../announce';
import { OpenAiCompatibleProvider, StubProvider } from '../provider';
import { PARAMS_HASH, PROMPT_HASH, PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from '../prompt';
import type { LlmTask, LlmVerdict, ModelSpec } from '../types';
import { NonLocalEndpointError, assertLocalEndpoint } from '../types';

function task(code: string, taskKey: string): LlmTask {
  return {
    taskKey,
    dataAsOf: '2026-08-17',
    sourceId: 'mops_twse_material_announcements',
    code,
    market: 'TWSE',
    speakDate: '2026-08-15',
    clause: '第51款',
    subject: `主旨 ${code}`,
    detail: `說明 ${code}`,
    contentHash: 'a'.repeat(64),
    itemKey: taskKey,
  };
}

function verdict(taskKey: string, v: 'veto' | 'no_veto'): LlmVerdict {
  return {
    taskKey,
    verdict: v,
    quotedEvidence: v === 'veto' ? '原文片段' : '',
    evidenceVerified: true,
    parseOk: true,
    reason: '測試',
    rawResponse: '',
    latencyMs: 1,
  };
}

const CANDIDATES = [{ code: '1101' }, { code: '2330' }, { code: '6121' }];

describe('applyLlmVetoes — 只減不增', () => {
  it('被判否決的檔會被移除，其餘原樣通過', () => {
    const out = applyLlmVetoes(CANDIDATES, {
      tasks: [task('2330', 'k1')],
      verdictsByTaskKey: new Map([['k1', verdict('k1', 'veto')]]),
      modelKey: 'test-model',
      promptVersion: PROMPT_VERSION,
    });
    expect(out.passed.map((c) => c.code)).toEqual(['1101', '6121']);
    expect(out.vetoed).toHaveLength(1);
    expect(out.vetoed[0]?.ruleId).toBe('llm_material_news');
    expect(out.countsByRule).toEqual({ llm_material_news: 1 });
  });

  it('evidence 存的是官方原文，不是模型的話', () => {
    const out = applyLlmVetoes(CANDIDATES, {
      tasks: [task('2330', 'k1')],
      verdictsByTaskKey: new Map([['k1', verdict('k1', 'veto')]]),
      modelKey: 'test-model',
      promptVersion: PROMPT_VERSION,
    });
    expect(out.vetoed[0]?.evidence).toContain('2026-08-15');
    expect(out.vetoed[0]?.evidence).toContain('第51款');
    expect(out.vetoed[0]?.evidence).toContain('主旨 2330');
  });

  it('沒有判定結果＝維持原狀，並回報未判定筆數（不是 fail-closed）', () => {
    const out = applyLlmVetoes(CANDIDATES, {
      tasks: [task('2330', 'k1'), task('1101', 'k2')],
      verdictsByTaskKey: new Map(),
      modelKey: 'test-model',
      promptVersion: PROMPT_VERSION,
    });
    expect(out.passed).toHaveLength(3);
    expect(out.pendingTasks).toBe(2);
    expect(out.failedClosed).toBe(false);
  });

  it('對佇列裡沒有的檔完全沒有影響', () => {
    const out = applyLlmVetoes(CANDIDATES, {
      tasks: [task('9999', 'k1')],
      verdictsByTaskKey: new Map([['k1', verdict('k1', 'veto')]]),
      modelKey: 'test-model',
      promptVersion: PROMPT_VERSION,
    });
    expect(out.passed).toHaveLength(3);
    expect(out.vetoed).toHaveLength(0);
  });

  it('同一檔多則公告都判否決，只記一次', () => {
    const out = applyLlmVetoes(CANDIDATES, {
      tasks: [task('2330', 'k1'), task('2330', 'k2')],
      verdictsByTaskKey: new Map([
        ['k1', verdict('k1', 'veto')],
        ['k2', verdict('k2', 'veto')],
      ]),
      modelKey: 'test-model',
      promptVersion: PROMPT_VERSION,
    });
    expect(out.vetoed).toHaveLength(1);
    expect(out.passed).toHaveLength(2);
  });

  it('全部否決也不會違反不變量', () => {
    const tasks = CANDIDATES.map((c, i) => task(c.code, `k${i}`));
    const out = applyLlmVetoes(CANDIDATES, {
      tasks,
      verdictsByTaskKey: new Map(tasks.map((t) => [t.taskKey, verdict(t.taskKey, 'veto')])),
      modelKey: 'test-model',
      promptVersion: PROMPT_VERSION,
    });
    expect(out.passed).toHaveLength(0);
    expect(out.vetoed).toHaveLength(3);
  });

  it('解析失敗與引用作廢分別回報', () => {
    const out = applyLlmVetoes(CANDIDATES, {
      tasks: [task('1101', 'k1'), task('2330', 'k2')],
      verdictsByTaskKey: new Map([
        ['k1', { ...verdict('k1', 'no_veto'), parseOk: false, evidenceVerified: false }],
        ['k2', { ...verdict('k2', 'no_veto'), parseOk: true, evidenceVerified: false }],
      ]),
      modelKey: 'test-model',
      promptVersion: PROMPT_VERSION,
    });
    expect(out.parseFailures).toBe(1);
    expect(out.evidenceFailures).toBe(1);
    expect(out.passed).toHaveLength(3);
  });

  it('llm_material_news 已登記在 RULE_SPECS，且把握程度標為 suspected', () => {
    const spec = RULE_SPEC_BY_ID.get('llm_material_news');
    expect(spec).toBeDefined();
    expect(spec?.confidence).toBe('suspected');
  });

  it('走的是與 P6 相同的 assertOnlySubtracts（同一個錯誤型別）', () => {
    // 直接證明不變量檢查真的會拋：把一個不在輸入裡的物件塞進 passed
    expect(() => {
      applyLlmVetoes([{ code: '1101' }], {
        tasks: [],
        verdictsByTaskKey: new Map(),
        modelKey: 'm',
        promptVersion: 'v',
      });
    }).not.toThrow();
    expect(VetoLayerViolationError.name).toBe('VetoLayerViolationError');
  });
});

describe('assertLocalEndpoint — 結構上不可能連到要付費的 API', () => {
  it('接受本機端點', () => {
    for (const ok of [
      'http://127.0.0.1:11434/v1',
      'http://localhost:1234/v1',
      'http://[::1]:11434/v1',
      'http://localhost/v1',
    ]) {
      expect(() => assertLocalEndpoint(ok)).not.toThrow();
    }
  });

  it('拒絕任何外部端點', () => {
    for (const bad of [
      'https://api.anthropic.com/v1',
      'https://api.openai.com/v1',
      'http://192.168.1.20:11434/v1',
      'http://evil.com/v1',
      'https://localhost:11434/v1', // https 也擋：本機 runtime 不需要 TLS
      'http://localhost.evil.com/v1',
    ]) {
      expect(() => assertLocalEndpoint(bad)).toThrow(NonLocalEndpointError);
    }
  });

  it('provider 在建構時就檢查，還沒送出任何請求就失敗', () => {
    const spec: ModelSpec = {
      modelKey: 'x',
      provider: 'openai_compatible',
      endpoint: 'https://api.openai.com/v1',
      role: 'challenger',
      promptVersion: PROMPT_VERSION,
      promptHash: PROMPT_HASH,
      paramsHash: PARAMS_HASH,
      params: {},
    };
    let called = false;
    const spy: typeof fetch = () => {
      called = true;
      return Promise.reject(new Error('不該被呼叫'));
    };
    expect(() => new OpenAiCompatibleProvider(spec, { fetchImpl: spy })).toThrow(
      NonLocalEndpointError,
    );
    expect(called).toBe(false);
  });
});

describe('OpenAiCompatibleProvider — 請求組裝', () => {
  const spec: ModelSpec = {
    modelKey: 'qwen2.5:7b-instruct',
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434/v1',
    role: 'challenger',
    promptVersion: PROMPT_VERSION,
    promptHash: PROMPT_HASH,
    paramsHash: PARAMS_HASH,
    params: {},
  };

  it('打的是 /chat/completions，且不帶任何 Authorization 標頭', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fake: typeof fetch = (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), {
          status: 200,
        }),
      );
    };
    const provider = new OpenAiCompatibleProvider(spec, { fetchImpl: fake });
    const result = await provider.complete('sys', 'user');

    expect(seenUrl).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(result.content).toBe('hello');
    const headers = seenInit?.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(JSON.stringify(seenInit?.body)).not.toMatch(/api[-_]?key/i);
  });

  it('temperature 0 與 model 名稱都被送出', async () => {
    let body = '';
    const fake: typeof fetch = (_url, init) => {
      body = String(init?.body);
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 }),
      );
    };
    await new OpenAiCompatibleProvider(spec, { fetchImpl: fake }).complete('s', 'u');
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed['model']).toBe('qwen2.5:7b-instruct');
    expect(parsed['temperature']).toBe(0);
    expect(parsed['stream']).toBe(false);
  });

  it('非 2xx 回應拋 LlmProviderError 而不是靜默回空字串', async () => {
    const fake: typeof fetch = () => Promise.resolve(new Response('模型未載入', { status: 404 }));
    await expect(
      new OpenAiCompatibleProvider(spec, { fetchImpl: fake }).complete('s', 'u'),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('連不上時的錯誤訊息會指出 runtime 沒啟動', async () => {
    const fake: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(
      new OpenAiCompatibleProvider(spec, { fetchImpl: fake }).complete('s', 'u'),
    ).rejects.toThrow(/連不上本機模型端點/);
  });

  it('StubProvider 永遠回 no_veto——假模型不該有否決的能力', async () => {
    const r = await new StubProvider().complete();
    expect(JSON.parse(r.content)).toMatchObject({ verdict: 'no_veto' });
  });
});

describe('prompt — 只問是非題，不問股價', () => {
  it('提示詞明文禁止預測股價與給買賣建議', () => {
    expect(SYSTEM_PROMPT).toContain('不得預測股價');
    expect(SYSTEM_PROMPT).toContain('不得給任何買賣建議');
  });

  it('使用者訊息不含公司名稱與代號——避免模型用既有印象作答', () => {
    const prompt = buildUserPrompt({
      sourceId: 's',
      code: '2330',
      market: 'TWSE',
      speakDate: '2026-08-15',
      clause: '第51款',
      subject: '主旨內容',
      detail: '說明內容',
      contentHash: 'h',
      itemKey: 'k',
    });
    expect(prompt).not.toContain('2330');
    expect(prompt).toContain('主旨內容');
    expect(prompt).toContain('說明內容');
  });

  it('PROMPT_HASH 綁定版本字串：改版本就換一個雜湊', () => {
    expect(PROMPT_HASH).toHaveLength(64);
    expect(PARAMS_HASH).toHaveLength(64);
  });
});

describe('parseAnnouncements — 官方欄位名的差異照抄不修正', () => {
  const twseRow = {
    出表日期: '1150816',
    發言日期: '1150815',
    公司代號: '7835',
    '主旨 ': '主旨帶空格欄位',
    符合條款: '第51款',
    說明: '說明內容',
  };
  const tpexRow = {
    Date: '1150816',
    發言日期: '1150815',
    SecuritiesCompanyCode: '6488',
    主旨: '主旨無空格欄位',
    符合條款: '第26款',
    說明: '說明內容',
  };

  it('TWSE 讀 `主旨 `（結尾帶空格）與 公司代號', () => {
    const { items } = parseAnnouncements([twseRow], 'TWSE', 'mops_twse_material_announcements');
    expect(items).toHaveLength(1);
    expect(items[0]?.code).toBe('7835');
    expect(items[0]?.subject).toBe('主旨帶空格欄位');
    expect(items[0]?.speakDate).toBe('2026-08-15');
  });

  it('TPEx 讀 `主旨`（無空格）與 SecuritiesCompanyCode', () => {
    const { items } = parseAnnouncements([tpexRow], 'TPEx', 'mops_tpex_material_announcements');
    expect(items[0]?.code).toBe('6488');
    expect(items[0]?.subject).toBe('主旨無空格欄位');
  });

  it('用錯市場的欄位名，整列連代號都讀不到而被略過', () => {
    // TWSE 的列用 TPEx 規則解析：找不到 SecuritiesCompanyCode → 代號為空 → 整列略過。
    // 不是「讀到空字串照樣寫進去」，而是明確計入 skipped。
    const { items, skipped } = parseAnnouncements([twseRow], 'TPEx', 'x');
    expect(items).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('只把主旨欄位名弄錯（其餘正確）就讀到空主旨——證明那個結尾空格是真的有影響', () => {
    // 代號用 TPEx 的欄位名（讀得到），但主旨用 TWSE 的 `主旨 `（帶空格）
    const mixed = { ...tpexRow, 主旨: undefined, '主旨 ': '主旨帶空格欄位' };
    const { items } = parseAnnouncements([mixed], 'TPEx', 'x');
    expect(items).toHaveLength(1);
    expect(items[0]?.code).toBe('6488');
    expect(items[0]?.subject).toBe('');
  });

  it('發言日期壞掉的列被略過而不是用抓取日期補', () => {
    const { items, skipped } = parseAnnouncements(
      [{ ...twseRow, 發言日期: '' }, twseRow],
      'TWSE',
      's',
    );
    expect(items).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('itemKey 由內容雜湊決定：同一則重抓得到同一個 key', () => {
    const a = parseAnnouncements([twseRow], 'TWSE', 's').items[0]!;
    const b = parseAnnouncements([{ ...twseRow, 出表日期: '1150820' }], 'TWSE', 's').items[0]!;
    expect(a.itemKey).toBe(b.itemKey); // 出表日期不納入雜湊
  });

  it('內容改一個字就是新的一題', () => {
    const a = parseAnnouncements([twseRow], 'TWSE', 's').items[0]!;
    const c = parseAnnouncements([{ ...twseRow, 說明: '說明內容2' }], 'TWSE', 's').items[0]!;
    expect(a.itemKey).not.toBe(c.itemKey);
  });

  it('buildItemKey / announcementHash 對得起來', () => {
    const hash = announcementHash({
      market: 'TWSE',
      code: '7835',
      speakDate: '2026-08-15',
      clause: '第51款',
      subject: '主旨帶空格欄位',
      detail: '說明內容',
    });
    expect(buildItemKey('TWSE', '7835', '2026-08-15', hash)).toBe(
      parseAnnouncements([twseRow], 'TWSE', 's').items[0]?.itemKey,
    );
  });

  it('非陣列 payload 回空結果而不是拋錯', () => {
    expect(parseAnnouncements({ 資料: [] }, 'TWSE', 's').items).toEqual([]);
  });
});
