import type { NextConfig } from 'next';

/**
 * Dashboard 設定。
 *
 * ⚠️ 這個站台**必須是私有的**。CLAUDE.md 禁止「對外提供個股建議」
 * （涉《證券投資信託及顧問法》），而本站顯示個股名稱與買賣訊號。
 * 存取控制在 proxy.ts，且 fail-closed：沒設密碼就全部擋掉。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // CLAUDE.md：AVIF 優先
  images: { formats: ['image/avif', 'image/webp'] },
  // 這個站只有自己看，不需要被搜尋引擎索引
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
      ],
    },
  ],
};

export default nextConfig;
