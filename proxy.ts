/**
 * 存取控制。Next 16 的 proxy（舊稱 middleware）。
 *
 * 【為什麼一定要擋】
 * CLAUDE.md：❌ 對外提供個股建議（涉《證券投資信託及顧問法》）。
 * 這個 Dashboard 顯示個股名稱、買賣訊號與部位大小。
 * 部署到 Vercel 預設是公開網址——不擋就是對外提供個股建議。
 *
 * 【fail-closed：沒設密碼就全部擋掉】
 * 不是「沒設密碼就放行」。設定漏掉時，安全的方向是誰都進不來，
 * 而不是全世界都進得來。
 *
 * 用 HTTP Basic 認證：瀏覽器原生支援、不需要 cookie/session、
 * 也不需要多一個資料表。單人系統夠用。
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const REALM = 'money-system';

function unauthorized(message: string): NextResponse {
  return new NextResponse(message, {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

/**
 * 定時比較，避免以回應時間反推密碼。
 * Edge Runtime 沒有 node:crypto 的 timingSafeEqual，故自行實作。
 */
function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // 長度不同時仍走完整個迴圈，不提早回傳
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export function proxy(request: NextRequest): NextResponse {
  const expected = process.env['DASHBOARD_PASSWORD'];

  if (expected === undefined || expected.trim() === '') {
    // 設定漏掉時一律拒絕。這是刻意的：
    // 一個沒有密碼的個股訊號站台，就是對外提供個股建議。
    return unauthorized(
      '未設定 DASHBOARD_PASSWORD，站台已鎖定。\n' +
        '這是刻意的 fail-closed 行為：沒有密碼就不開放，而不是不開放密碼。',
    );
  }

  const header = request.headers.get('authorization');
  if (header === null || !header.startsWith('Basic ')) {
    return unauthorized('需要密碼');
  }

  let decoded: string;
  try {
    decoded = atob(header.slice('Basic '.length));
  } catch {
    return unauthorized('認證格式錯誤');
  }

  // 使用者名稱不檢查，只比對密碼（單人系統）
  const password = decoded.slice(decoded.indexOf(':') + 1);
  if (!safeEqual(password, expected)) {
    return unauthorized('密碼錯誤');
  }

  return NextResponse.next();
}

export const config = {
  // 靜態資源不必擋，其餘一律要密碼
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
