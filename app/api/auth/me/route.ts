import { NextRequest, NextResponse } from "next/server";
import { requireUser, sessionCookieOptions } from "@/app/lib/auth";
import {
    signToken,
    verifyToken,
    SESSION_COOKIE,
    SESSION_TTL_SECONDS,
    RENEW_THRESHOLD_SECONDS,
} from "@/app/lib/authToken";
import { insertSession, deleteSession } from "@/app/lib/sessionStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me —— 当前用户身份（v3：滑动续期改为 jti 轮换）
 *
 * 剩余有效期 < 3 天时重签 7 天新 Cookie：插新 jti 行 + 删旧 jti 行，
 * 保证同一 Cookie 生命周期内 sessions 行唯一（共享知识 8-6）。
 */
export async function GET(req: NextRequest) {
    try {
        const user = await requireUser(req);
        if (!user) {
            return NextResponse.json({ error: "未登录或会话已过期" }, { status: 401 });
        }

        const resp = NextResponse.json({
            success: true,
            user: { username: user.username, role: user.role },
        });

        // 滑动续期（jti 轮换）：剩余 < 3 天时重签 7 天新 Cookie
        const payload = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value);
        if (payload && payload.exp - Math.floor(Date.now() / 1000) < RENEW_THRESHOLD_SECONDS) {
            const { token, jti } = await signToken({
                uid: user.id,
                un: user.username,
                role: user.role,
                ver: payload.ver,
            });
            const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
            // 先插新再删旧：中途失败旧会话仍有效（可用性优先，旧行由 purgeExpired 兜底清理）
            await insertSession(jti, user.id, expiresAt);
            await deleteSession(payload.jti);
            resp.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL_SECONDS));
        }

        return resp;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "未知错误";
        console.error("[me] 异常:", msg);
        return NextResponse.json({ error: "查询用户信息失败: " + msg }, { status: 500 });
    }
}
