import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 生产环境推荐开启，压缩 API 响应体
  compress: true,

  // 全局安全响应头三件套（PRD R8；CSP 本期不做，Q5 定稿）
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
