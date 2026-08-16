/**
 * 把 .env.local 的 LINE 憑證同步到 Supabase Edge Function：`npm run l4:sync-secrets`
 *
 * 【為什麼需要這支】
 * 2026-08-16 實測踩到的坑：直接在 PowerShell 打
 *   supabase secrets set A=值1 B=值2 C=值3
 * 三個 secret 全部被設成同一個值（雜湊完全相同）。
 * LINE access token 是 base64，含 `/` `+` 結尾 `=`，一行塞三對很容易被 shell 吃掉。
 * 症狀極難診斷：webhook 回 401，但看起來「secret 明明設了」。
 *
 * 改成用 --env-file 讀檔，值完全不經過命令列參數解析。
 *
 * ⚠️ 本程式不印出任何憑證內容，只印長度。
 * ⚠️ 暫存檔用完必刪（finally 保證），即使中途失敗也不會留在磁碟上。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadSupabaseConfig, loadEnvFileIfPresent } from '../src/lib/config/env';

const KEYS = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'LINE_USER_ID'] as const;
const TEMP_FILE = '.env.line.tmp';

loadEnvFileIfPresent();
const projectRef = new URL(loadSupabaseConfig().url).hostname.split('.')[0]!;

/** 直接讀檔而不用 process.env，避免被系統環境變數蓋掉 */
function readFromEnvLocal(key: string): string {
  const line = readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trimStart().startsWith(`${key}=`));
  if (line === undefined) {
    throw new Error(`.env.local 找不到 ${key}`);
  }
  const value = line.slice(line.indexOf('=') + 1).trim();
  if (value === '') {
    throw new Error(`${key} 是空的`);
  }
  return value;
}

console.log('=== 同步 LINE 憑證到 Edge Function ===\n');
console.log(`專案：${projectRef}\n`);

const entries = KEYS.map((key) => [key, readFromEnvLocal(key)] as const);
for (const [key, value] of entries) {
  console.log(`✓ ${key.padEnd(28)} ${value.length} 字元`);
}

// 三個值必須互不相同 —— 這正是先前出錯的地方，所以直接擋在這裡
const distinct = new Set(entries.map(([, v]) => v)).size;
if (distinct !== KEYS.length) {
  console.log(`\n✗ 三個值之中有重複（相異值只有 ${distinct} 個）。`);
  console.log('  .env.local 裡可能貼錯了，請檢查後重試。');
  process.exit(1);
}
console.log('✓ 三個值互不相同\n');

try {
  writeFileSync(TEMP_FILE, `${entries.map(([k, v]) => `${k}=${v}`).join('\n')}\n`, 'utf8');
  const output = execFileSync(
    'npx',
    ['--yes', 'supabase@latest', 'secrets', 'set', '--env-file', TEMP_FILE, '--project-ref', projectRef],
    { encoding: 'utf8', shell: true },
  );
  console.log(output.trim());
} finally {
  // 即使上面拋錯也要刪掉暫存檔
  rmSync(TEMP_FILE, { force: true });
}

console.log('\n✓ 已同步。');
console.log('  驗證：npm run l4:verify-webhook');
