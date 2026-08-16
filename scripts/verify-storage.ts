/**
 * Supabase Storage 原始 bytes 儲存的實測驗證：`npm run l0:verify-storage`
 *
 * 要證明的四件事：
 *   1. 上傳成功
 *   2. **來回一致**：下載 → 解壓 → 重算 SHA-256 必須等於原始 bytes 的雜湊
 *      （只驗「上傳有沒有成功」不夠，壓縮／傳輸任一環出錯都會靜默毀損資料）
 *   3. 同內容重複上傳不會覆蓋（append-only）
 *   4. 誠實回報：service_role 到底刪不刪得掉物件
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { randomBytes } from 'node:crypto';
import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { sha256Hex } from '../src/lib/l0/snapshot';
import { SupabaseStorageBodyStore } from '../src/lib/l0/supabase-storage';
import type { RawSnapshot } from '../src/lib/l0/types';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

const store = new SupabaseStorageBodyStore({
  url: config.url,
  apiKey: config.serviceRoleKey,
});

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}
const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? '✓' : '✗'} ${name}`);
  console.log(`    ${detail}\n`);
}

// 造一份夠大、可壓縮、每次不同的測試內容（模擬真實 JSON 的高重複性）
const runId = randomBytes(6).toString('hex');
const payload = Buffer.from(
  JSON.stringify(
    Array.from({ length: 2000 }, (_, i) => ({
      Date: '1150814',
      Code: String(1000 + (i % 900)),
      Name: `測試標的${i % 50}`,
      ClosingPrice: (10 + (i % 400) / 10).toFixed(2),
      run: runId,
    })),
  ),
  'utf8',
);
const contentHash = sha256Hex(payload);

const snapshot = {
  sourceId: '__storage_probe__',
  dataAsOf: '2026-08-16',
  contentHash,
} as unknown as RawSnapshot;

console.log('=== Supabase Storage 原始 bytes 驗證 ===');
console.log(`目標：${config.url}  bucket：${store.bucket}`);
console.log(`測試內容：${payload.length} bytes，SHA-256 ${contentHash.slice(0, 16)}…\n`);

// ── 1. 上傳 ─────────────────────────────────────────────────────────────────
const first = await store.put(snapshot, payload);
record('首次上傳', first.written, `written=${first.written} path=${first.bodyPath}`);

// ── 2. 來回一致性 ───────────────────────────────────────────────────────────
try {
  const downloaded = await store.get(first.bodyPath);
  const roundTripHash = sha256Hex(downloaded);
  record(
    '下載 → 解壓 → 重算 SHA-256 與原始一致',
    roundTripHash === contentHash && downloaded.byteLength === payload.length,
    `原始 ${payload.length} bytes / 取回 ${downloaded.byteLength} bytes；` +
      `hash ${roundTripHash === contentHash ? '相符 ✓' : `不符 ✗（${roundTripHash.slice(0, 16)}…）`}`,
  );
} catch (error) {
  record('下載 → 解壓 → 重算 SHA-256 與原始一致', false, String(error));
}

// ── 3. 壓縮效果（實際佔用多少額度） ──────────────────────────────────────────
{
  const res = await fetch(
    `${config.url}/storage/v1/object/info/${store.bucket}/${first.bodyPath}`,
    {
      headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const text = await res.text();
  let storedSize: number | null = null;
  try {
    const info = JSON.parse(text) as { size?: unknown };
    storedSize = typeof info.size === 'number' ? info.size : null;
  } catch {
    storedSize = null;
  }
  record(
    '實際佔用空間為壓縮後大小',
    storedSize !== null && storedSize < payload.length,
    storedSize === null
      ? `無法取得物件資訊（HTTP ${res.status}）：${text.slice(0, 160)}`
      : `原始 ${payload.length} bytes → 儲存 ${storedSize} bytes（${(payload.length / storedSize).toFixed(1)}x）`,
  );
}

// ── 4. 重複上傳不覆蓋 ───────────────────────────────────────────────────────
const second = await store.put(snapshot, payload);
record(
  '同內容重複上傳不覆蓋（append-only）',
  second.written === false && second.bodyPath === first.bodyPath,
  `written=${second.written}（應為 false）path 相同=${second.bodyPath === first.bodyPath}`,
);

// ── 5. 誠實回報刪除是否可行 ─────────────────────────────────────────────────
{
  const res = await fetch(`${config.url}/storage/v1/object/${store.bucket}/${first.bodyPath}`, {
    method: 'DELETE',
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  const text = (await res.text()).slice(0, 200);
  const blocked = res.status >= 400;
  console.log(`${blocked ? '✓' : '⚠'} service_role 刪除物件`);
  console.log(`    HTTP ${res.status} ${text}`);
  console.log(
    blocked
      ? '    → 刪除被擋，儲存層本身即為 append-only\n'
      : '    → ⚠ 刪除可行。儲存層無法阻擋刪除，僅能靠帳本的 content_hash 事後偵測資料遺失。\n' +
          '      這是已知限制，不是通過的檢查。\n',
  );
  // 刻意不計入通過／失敗：這一項是「回報事實」而非「主張已達成」
  if (!blocked) {
    // 刪掉了就補回去，讓下次執行仍可驗證
    await store.put(snapshot, payload);
  }
}

const failed = checks.filter((c) => !c.passed);
console.log('='.repeat(60));
console.log(`共 ${checks.length} 項檢查，通過 ${checks.length - failed.length}，失敗 ${failed.length}`);
for (const f of failed) {
  console.log(`  ✗ ${f.name}：${f.detail}`);
}
process.exit(failed.length > 0 ? 1 : 0);
