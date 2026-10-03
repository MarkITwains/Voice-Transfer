/**
 * 认证与身份获取（纵深防御层）
 *
 * - requireUser(req)：Route Handler 唯一身份入口；解析 Cookie 令牌后单查询核对
 *   users JOIN sessions（token_version + 会话吊销 + 过期，一次往返；
 *   proxy 只做无状态校验）
 * - requireAdmin(req)：requireUser + role === 'admin'
 * - getServerUser()：Server Component（app/result/[roomId]/page.tsx）用 next/headers cookies()
 * - requireUser/requireAdmin 返回 null 时，调用方自行返回 401；越权访问数据一律 404
 */
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { query } from "./db";
import { SESSION_COOKIE, verifyToken, type SessionPayload } from "./authToken";

export interface SessionUser {
    id: number;
    username: string;
    role: string;
}

/** Cookie 属性契约（共享知识 6） */
export function sessionCookieOptions(maxAgeSeconds: number) {
    return {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        maxAge: maxAgeSeconds,
        secure: process.env.COOKIE_SECURE === "1",
    };
}

interface UserRow {
    id: number;
    username: string;
    role: string;
    token_version: number;
}

/**
 * 完整校验：无状态验签（签名+过期+jti 存在）+ DB 单查询核对
 * （users JOIN sessions：用户存在 + token_version 一致 + 会话行存在且未过期未吊销，一次往返）。
 * @internal 由 requireUser / getServerUser 共用
 */
async function resolveUser(token: string | undefined | null): Promise<SessionUser | null> {
    const payload: SessionPayload | null = await verifyToken(token);
    if (!payload) return null;

    // 单查询同时完成：用户存在 + token_version + 会话未吊销未过期（连接池时区 Z，UTC 口径一致）
    const res = await query<UserRow>(
        `SELECT u.id, u.username, u.role, u.token_version
         FROM users u
         JOIN sessions s ON s.jti = ? AND s.user_id = u.id AND s.expires_at > UTC_TIMESTAMP(3)
         WHERE u.id = ?`,
        [payload.jti, payload.uid]
    );
    const row = res.rows[0];
    if (!row) return null;
    // token_version 不符 → 旧会话已被改密操作踢掉（双保险之一，sessions 行删除为另一保险）
    if (Number(row.token_version) !== payload.ver) return null;

    return { id: Number(row.id), username: row.username, role: row.role };
}

/** Route Handler 唯一身份入口；null → 调用方返回 401 */
export async function requireUser(req: NextRequest): Promise<SessionUser | null> {
    try {
        return await resolveUser(req.cookies.get(SESSION_COOKIE)?.value);
    } catch (e) {
        // DB 不可用等异常：视为未认证（由调用方 401），错误已可由 health 排查
        console.error("[auth] requireUser 异常:", e instanceof Error ? e.message : e);
        return null;
    }
}

/** 管理员校验；null（含未登录/非 admin）→ 调用方返回 401/403 */
export async function requireAdmin(req: NextRequest): Promise<SessionUser | null> {
    const user = await requireUser(req);
    if (!user || user.role !== "admin") return null;
    return user;
}

/** Server Component 身份获取（next/headers cookies()） */
export async function getServerUser(): Promise<SessionUser | null> {
    try {
        const jar = await cookies();
        return await resolveUser(jar.get(SESSION_COOKIE)?.value);
    } catch (e) {
        console.error("[auth] getServerUser 异常:", e instanceof Error ? e.message : e);
        return null;
    }
}
