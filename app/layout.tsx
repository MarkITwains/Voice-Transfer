import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "言简 · 会议纪要",
  description: "把会议速记或录音，梳理成决议、待办、议题与风险四段式纪要。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
