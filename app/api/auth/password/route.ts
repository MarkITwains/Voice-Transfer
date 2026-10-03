import { NextRequest, NextResponse } from "next/server";
import { requireUser, sessionCookieOptions } from "@/app/lib/auth";
import { changePassword, verifyPassword, getPasswordHash } from "@/app/lib/userRepo";
import { validatePassword } from "@/app/lib/validation";
import { hit } from "@/app/lib/rateLimit";
import { signToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/app/lib/authToken";
import { insertSession } from "@/app/lib/sessionStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/password —— 修改密码（R13/R6）：验旧密码 → 新密码强度校验 → token_version+1 + 删全部 sessions → 重签 Cookie */
export async function POST(req: NextRequest) {
    try {
        const user = await requireUser(req);
        if (!user) {
            return NextResponse.json({ error: "未登录或会话已过期" }, { status: 401 });
        }

        // 改密限速：每用户 1 小时窗口 5 次（防爆破旧密码）
        const rl = hit(`pwd:${user.id}`, 5, 3600_000);
        if (!rl.allowed) {
            return NextResponse.json(
                { error: `操作过于频繁，请 ${Math.ceil(rl.retryAfterSeconds / 60)} 分钟后再试` },
                { status: 429 }
            );
        }

        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        const oldPassword = typeof body.oldPassword === "string" ? body.oldPassword : "";
        const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

        // 验旧密码
        const hash = await getPasswordHash(user.username);
        const oldOk = hash ? await verifyPassword(oldPassword, hash) : false;
        if (!oldOk) {
            return NextResponse.json({ error: "原密码不正确" }, { status: 400 });
        }

        // 新密码强度（唯一来源 validation.ts）
        const pwdError = validatePassword(newPassword);
        if (pwdError) {
            return NextResponse.json({ error: pwdError }, { status: 400 });
        }

        // 更新哈希 + token_version+1（changePassword 内已删该用户全部 sessions 行 = 服务端吊销双保险，R6）
        const updated = await changePassword(user.id, newPassword);
        if (!updated) {
            return NextResponse.json({ error: "用户不存在" }, { status: 401 });
        }

        // 重签新 Cookie + 插新会话行（当前设备保持登录态；其他设备旧 Cookie 因
        // ver 不符 + sessions 行已删双重失效）
        const { token, jti } = await signToken({
            uid: updated.id,
            un: updated.username,
            role: updated.role,
            ver: updated.tokenVersion,
        });
        const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
        await insertSession(jti, updated.id, expiresAt);
        const resp = NextResponse.json({
            success: true,
            message: "密码已修改，已退出所有设备上的旧会话",
            user: { username: updated.username, role: updated.role },
        });
        resp.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL_SECONDS));
        return resp;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "未知错误";
        console.error("[password] 异常:", msg);
        return NextResponse.json({ error: "修改密码失败: " + msg }, { status: 500 });
    }
}
