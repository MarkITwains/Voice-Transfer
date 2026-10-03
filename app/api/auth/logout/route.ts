import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifyToken } from "@/app/lib/authToken";
import { sessionCookieOptions } from "@/app/lib/auth";
import { deleteSession } from "@/app/lib/sessionStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout —— 登出（v3：服务端吊销 R6/US-5）
 *
 * 服务端 DELETE sessions WHERE jti = ?（best-effort）+ 清 Cookie。
 * 吊销即时生效：即使 Cookie 曾被拷贝，服务端行已删 → requireUser JOIN 无行 → 401。
 */
export async function POST(req: NextRequest) {
    try {
        const payload = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value);
        if (payload?.jti) {
            // best-effort：行不存在（重复登出/已过期清理）静默成功
            await deleteSession(payload.jti);
        }
    } catch (e: unknown) {
        // 吊销失败不阻断登出（Cookie 仍会清除），但记录日志便于排查
        console.error("[logout] 会话吊销异常:", e instanceof Error ? e.message : e);
    }
    const resp = NextResponse.json({ success: true, message: "已登出" });
    // Max-Age:0 立即失效
    resp.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
    return resp;
}
