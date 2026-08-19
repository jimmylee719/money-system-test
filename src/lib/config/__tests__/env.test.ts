import { describe, expect, it } from 'vitest';
import {
  MissingEnvError,
  describeSupabaseConfig,
  hasLineConfig,
  hasSupabaseConfig,
  loadLineConfig,
  loadSupabaseConfig,
} from '../env';
import type { EnvSource } from '../env';

const FAKE_KEY = 'fake-service-role-key-value-that-should-never-be-logged';
const FAKE_ANON = 'fake-anon-key-value';

const FULL = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: FAKE_KEY,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: FAKE_ANON,
} satisfies EnvSource;

describe('loadSupabaseConfig', () => {
  it('loads a complete config', () => {
    const config = loadSupabaseConfig(FULL);
    expect(config.url).toBe('https://example.supabase.co');
    expect(config.serviceRoleKey).toBe(FAKE_KEY);
    expect(config.anonKey).toBe(FAKE_ANON);
  });

  it('strips trailing slashes so URL joining never double-slashes', () => {
    expect(loadSupabaseConfig({ ...FULL, NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co//' }).url).toBe(
      'https://x.supabase.co',
    );
  });

  it('treats whitespace-only values as missing', () => {
    expect(() => loadSupabaseConfig({ ...FULL, SUPABASE_SERVICE_ROLE_KEY: '   ' })).toThrow(
      MissingEnvError,
    );
  });

  it('names every missing variable', () => {
    try {
      loadSupabaseConfig({});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingEnvError);
      expect((error as MissingEnvError).missing).toEqual([
        'NEXT_PUBLIC_SUPABASE_URL',
        'SUPABASE_SERVICE_ROLE_KEY',
      ]);
    }
  });

  it('never leaks a key value into the error message', () => {
    try {
      loadSupabaseConfig({ SUPABASE_SERVICE_ROLE_KEY: FAKE_KEY });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(FAKE_KEY);
      expect((error as Error).message).toContain('NEXT_PUBLIC_SUPABASE_URL');
    }
  });

  it('rejects a non-https URL', () => {
    expect(() =>
      loadSupabaseConfig({ ...FULL, NEXT_PUBLIC_SUPABASE_URL: 'http://example.supabase.co' }),
    ).toThrow(RangeError);
  });

  it('anon key is optional', () => {
    const { NEXT_PUBLIC_SUPABASE_ANON_KEY: _omitted, ...withoutAnon } = FULL;
    expect(loadSupabaseConfig(withoutAnon).anonKey).toBe(null);
  });
});

describe('hasSupabaseConfig', () => {
  it('is true only when both required variables are present', () => {
    expect(hasSupabaseConfig(FULL)).toBe(true);
    expect(hasSupabaseConfig({})).toBe(false);
    expect(hasSupabaseConfig({ NEXT_PUBLIC_SUPABASE_URL: FULL.NEXT_PUBLIC_SUPABASE_URL })).toBe(
      false,
    );
  });
});

describe('describeSupabaseConfig', () => {
  it('reports lengths only — never the key itself', () => {
    const summary = describeSupabaseConfig(loadSupabaseConfig(FULL));
    expect(summary).not.toContain(FAKE_KEY);
    expect(summary).not.toContain(FAKE_ANON);
    expect(summary).toContain('https://example.supabase.co');
    expect(summary).toContain(`${FAKE_KEY.length} 字元`);
  });
});

/**
 * 2026-08-19 事故回歸：GitHub Actions 的每日 LINE 日報連續數日沒送出，
 * 原因是 repo secrets 從未設定（只設了 Supabase Edge Function 那一組）。
 *
 * 這裡釘住的關鍵事實是：**GitHub Actions 把未設定的 secret 展開成空字串，不是未定義**。
 * 若空字串被當成「有設定」，程式會拿著空 token 去打 LINE，換來一個難查的 401；
 * 現在它被正確判為缺漏，日報邏輯才有機會發出警報。
 */
describe('hasLineConfig — 未設定的 GitHub secret 會變成空字串', () => {
  const LINE_FULL: EnvSource = {
    LINE_CHANNEL_ACCESS_TOKEN: 'fake-line-token',
    LINE_CHANNEL_SECRET: 'fake-line-secret',
    LINE_USER_ID: `U${'0123456789abcdef'.repeat(2)}`,
  };

  it('三個都在才算有設定', () => {
    expect(hasLineConfig(LINE_FULL)).toBe(true);
    expect(hasLineConfig({})).toBe(false);
  });

  it('空字串等同未設定 —— 這正是 CI 裡 secret 沒設時的樣子', () => {
    for (const key of Object.keys(LINE_FULL)) {
      expect(hasLineConfig({ ...LINE_FULL, [key]: '' })).toBe(false);
      expect(hasLineConfig({ ...LINE_FULL, [key]: '   ' })).toBe(false);
    }
  });

  it('缺任何一個都算沒設定，不會只憑其中兩個就去推播', () => {
    for (const key of Object.keys(LINE_FULL)) {
      const { [key]: _omitted, ...partial } = LINE_FULL;
      expect(hasLineConfig(partial)).toBe(false);
    }
  });

  it('user id 格式錯誤會擋在載入階段，而不是拿去換一個 400', () => {
    expect(() => loadLineConfig({ ...LINE_FULL, LINE_USER_ID: 'my-line-id' })).toThrow(RangeError);
  });
});
