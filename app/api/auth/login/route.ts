import { NextRequest, NextResponse } from "next/server";
import {
    getLoginLockState,
    getPasswordHash,
    getUserByUsername,
    incrementFailedLogin,
    resetLoginState,
    verifyPassword,
} from "@/app/lib/userRepo";
import { hit, clear } from "@/app/lib/rateLimit";
import { signToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/app/lib/authToken";
import { sessionCookieOptions } from "@/app/lib/auth";
import { insertSession, purgeExpired } from "@/app/lib/sessionStore";
import { verifyCaptcha } from "@/app/lib/captcha";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientIp(req: NextRequest): string {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0].trim();
    return req.headers.get("x-real-ip")?.trim() || "local";
}

/** 自适应验证码触发阈值：同账号失败 ≥2 次后必须携带有效验证码（Q4 定稿） */
const CAPTCHA_AFTER_FAILS = 2;

/**
 * POST /api/auth/login —— 账密登录（v3：账号锁定 + 自适应验证码 + 会话签发）
 *
 * 流程：IP 限速 → 账号锁定检查 → 自适应验证码 → 凭证校验 → 失败计数/成功清零 → 写 sessions
 * 契约：
 * - locked_until > NOW → 429 { error, lockedSeconds }
 * - 需验证码但缺失/错误 → 401 { error: "验证码错误或已过期，请换一张重试", requireCaptcha: true }（不计数）
 * - 密码错误 → 401 { error: "用户名或密码错误", requireCaptcha }（计数 +1，防锁定 DoS：仅密码错误计数）
 * - 成功 → 200 { success, user } + Set-Cookie（v2 token）+ sessions 插行
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        const username = typeof body.username === "string" ? body.username.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        const captchaId = typeof body.captchaId === "string" ? body.captchaId : "";
        const captchaCode = typeof body.captchaCode === "string" ? body.captchaCode : "";

        if (!username || !password) {
            return NextResponse.json({ error: "用户名或密码错误", requireCaptcha: false }, { status: 401 });
        }

        // 登录失败限速：15 分钟窗口内同 IP+用户名 5 次（R9）；成功登录清零。与账号锁定独立计数、叠加生效
        const failKey = `login:${clientIp(req)}:${username.toLowerCase()}`;
        const rl = hit(failKey, 5, 15 * 60_000);
        if (!rl.allowed) {
            return NextResponse.json(
                { error: "尝试次数过多，请 15 分钟后再试" },
                { status: 429 }
            );
        }

        // 账号锁定检查（R7）：锁定期间即使密码正确也拒绝；不存在用户走下方模糊 401
        const lock = await getLoginLockState(username);
        if (lock && lock.lockedUntil && lock.lockedUntil.getTime() > Date.now()) {
            const lockedSeconds = Math.max(1, Math.ceil((lock.lockedUntil.getTime() - Date.now()) / 1000));
            return NextResponse.json(
                {
                    error: `账号已临时锁定，请 ${Math.max(1, Math.ceil(lockedSeconds / 60))} 分钟后再试`,
                    lockedSeconds,
                    requireCaptcha: false,
                },
                { status: 429 }
            );
        }

        // 自适应验证码（R4）：失败 ≥2 次后必须携带有效验证码；一次性消费，对错都作废（不计数）
        const requireCaptcha = Boolean(lock && lock.failedLoginCount >= CAPTCHA_AFTER_FAILS);
        if (requireCaptcha) {
            if (!verifyCaptcha(captchaId, captchaCode)) {
                return NextResponse.json(
                    { error: "验证码错误或已过期，请换一张重试", requireCaptcha: true },
                    { status: 401 }
                );
            }
        }

        // 凭证校验（模糊文案，不暴露账号存在性）
        const user = await getUserByUsername(username);
        const hash = user ? await getPasswordHash(username) : null;
        const ok = Boolean(user && hash && (await verifyPassword(password, hash)));

        if (!user || !ok) {
            // 仅密码错误才计数 +1（验证码错误/缺失不计数，防"刷计数锁死受害者"的锁定 DoS）
            let nowRequireCaptcha = requireCaptcha;
            if (user) {
                const inc = await incrementFailedLogin(user.id);
                // 计数更新后 ≥2 → 前端应展示验证码行
                nowRequireCaptcha = nowRequireCaptcha || inc.failedLoginCount >= CAPTCHA_AFTER_FAILS;
            }
            return NextResponse.json(
                { error: "用户名或密码错误", requireCaptcha: nowRequireCaptcha },
                { status: 401 }
            );
        }

        // 成功登录：清零失败计数 + 解锁；顺手清理过期会话行（惰性）
        await resetLoginState(user.id);
        clear(failKey);
        purgeExpired().catch(() => { /* 清理失败不影响登录 */ });

        // 签发 v2 令牌（全新 iat + 全新 jti）并同步 sessions 表（共享知识 8-6：漏插行 = 立刻 401）
        const { token, jti } = await signToken({
            uid: user.id,
            un: user.username,
            role: user.role,
            ver: user.tokenVersion,
        });
        const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
        await insertSession(jti, user.id, expiresAt);

        const resp = NextResponse.json({
            success: true,
            user: { username: user.username, role: user.role },
        });
        resp.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL_SECONDS));
        return resp;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "未知错误";
        console.error("[login] 异常:", msg);
        return NextResponse.json({ error: "登录失败: " + msg }, { status: 500 });
    }
}
