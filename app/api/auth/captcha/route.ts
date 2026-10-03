/**
 * GET /api/auth/captcha —— 验证码签发契约（R1/R5）
 *
 * 200 { captchaId, svg, expiresIn: 300, debugCode? }
 * - debugCode 仅当 QA_TEST_MODE=1 且 NODE_ENV!=="production"（测试模式双条件硬门）
 * - 限速：hit(`captcha:<ip>`, 30, 60s) 防 SVG 生成 DoS；超限 429 { error }
 */
import { NextRequest, NextResponse } from "next/server";
import { issueCaptcha } from "@/app/lib/captcha";
import { hit } from "@/app/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 请求来源 IP（与 login/register 同口径） */
function clientIp(req: NextRequest): string {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0].trim();
    return req.headers.get("x-real-ip")?.trim() || "local";
}

export async function GET(req: NextRequest) {
    try {
        // 防 SVG 生成 DoS：同 IP 每分钟 30 次
        const rl = hit(`captcha:${clientIp(req)}`, 30, 60_000);
        if (!rl.allowed) {
            return NextResponse.json(
                { error: `请求过于频繁，请 ${Math.ceil(rl.retryAfterSeconds / 60)} 分钟后再试` },
                { status: 429 }
            );
        }

        const issue = issueCaptcha();
        return NextResponse.json({
            captchaId: issue.id,
            svg: issue.svg,
            expiresIn: issue.expiresIn,
            ...(issue.debugCode !== undefined ? { debugCode: issue.debugCode } : {}),
        });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "未知错误";
        console.error("[captcha] 异常:", msg);
        return NextResponse.json({ error: "验证码生成失败: " + msg }, { status: 500 });
    }
}
