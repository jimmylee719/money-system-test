import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '台股分析交易助手',
  description: '個人研究紀錄。不對外提供個股建議。',
  // 這個站只有自己看
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
