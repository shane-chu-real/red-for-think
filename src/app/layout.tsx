import type { Metadata, Viewport } from "next";
import { Black_Han_Sans, Noto_Sans_KR } from "next/font/google";
import "./globals.css";

// 제목·숫자용 굵은 서체와 본문 서체. 빌드할 때 내려받아 앱이 직접 제공한다(실행 중 외부 요청 없음).
const display = Black_Han_Sans({ weight: "400", variable: "--font-display-face", display: "swap", preload: false });
const body = Noto_Sans_KR({ variable: "--font-body", display: "swap", preload: false });

export const metadata: Metadata = {
  title: "기획 레드팀",
  description: "개인용 기획 토론 웹앱",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={`${display.variable} ${body.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
