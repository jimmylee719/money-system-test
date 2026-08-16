import { describe, expect, it } from 'vitest';
import {
  MissingEnvError,
  describeSupabaseConfig,
  hasSupabaseConfig,
  loadSupabaseConfig,
} from '../env';

const FAKE_KEY = 'fake-service-role-key-value-that-should-never-be-logged';
const FAKE_ANON = 'fake-anon-key-value';

const FULL = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: FAKE_KEY,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: FAKE_ANON,
} satisfies NodeJS.ProcessEnv;

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
