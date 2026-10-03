import { NextRequest, NextResponse } from "next/server";
import { registerUser } from "@/app/lib/userRepo";
import { validateUsername, validatePassword } from "@/app/lib/validation";
import { hit } from "@/app/lib/rateLimit";
import { signToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/app/lib/authToken";
import { sessionCookieOptions } from "@/app/lib/auth";
import { insertSession, purgeExpired } from "@/app/lib/sessionStore";
import { verifyCaptcha } from "@/app/lib/captcha";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 请求来源 IP（本机自托管：无代理头时归为 local） */
function clientIp(req: NextRequest): string {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0].trim();
    return req.headers.get("x-real-ip")?.trim() || "local";
}

/**
 * POST /api/auth/register —— 开放注册（v3：强制图形验证码 R3 + 会话签发）
 *
 * 顺序：用户名/密码校验（不计配额）→ 注册限速 → 验证码强制校验（R3）→ 注册 → sessions 插行
 * - 验证码缺失/错误/过期/复用 → 400 { error: "验证码错误或已过期", requireCaptcha: true }（一次性语义，须换新码）
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        const username = typeof body.username === "string" ? body.username.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        const captchaId = typeof body.captchaId === "string" ? body.captchaId : "";
        const captchaCode = typeof body.captchaCode === "string" ? body.captchaCode : "";

        // 校验（唯一来源 validation.ts；校验失败不计入注册限速配额）
        const usernameError = validateUsername(username);
        if (usernameError) {
            return NextResponse.json({ error: usernameError }, { status: 400 });
        }
        const passwordError = validatePassword(password);
        if (passwordError) {
            return NextResponse.json({ error: passwordError }, { status: 400 });
        }

        // 注册限速：同 IP 1 小时窗口 5 次（R9；验证码失败前已计数，防绕过验证码刷注册）
        const rl = hit(`reg:${clientIp(req)}`, 5, 3600_000);
        if (!rl.allowed) {
            return NextResponse.json(
                { error: `注册尝试过于频繁，请 ${Math.ceil(rl.retryAfterSeconds / 60)} 分钟后再试` },
                { status: 429 }
            );
        }

        // 强制图形验证码（R3，防机器人批量注册）：一次性消费，对错都作废
        if (!verifyCaptcha(captchaId, captchaCode)) {
            return NextResponse.json(
                { error: "验证码错误或已过期", requireCaptcha: true },
                { status: 400 }
            );
        }

        let result;
        try {
            result = await registerUser(username, password);
        } catch (e) {
            // 唯一键冲突 → 用户名已存在（注册场景允许明示，设计 2.4）
            if ((e as { code?: string }).code === "ER_DUP_ENTRY") {
                return NextResponse.json({ error: "用户名已存在" }, { status: 400 });
            }
            throw e;
        }

        // 注册即登录：签发 v2 会话（全新 iat + jti）并同步 sessions 表（共享知识 8-6）
        purgeExpired().catch(() => { /* 清理失败不影响注册 */ });
        const { token, jti } = await signToken({
            uid: result.user.id,
            un: result.user.username,
            role: result.user.role,
            ver: result.user.tokenVersion,
        });
        const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
        await insertSession(jti, result.user.id, expiresAt);

        const resp = NextResponse.json({
            success: true,
            user: { username: result.user.username, role: result.user.role },
            isFirstUser: result.isFirstUser,
            claimedMeetings: result.claimedMeetings,
        });
        resp.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL_SECONDS));
        return resp;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "未知错误";
        console.error("[register] 异常:", msg);
        return NextResponse.json({ error: "注册失败: " + msg }, { status: 500 });
    }
}
