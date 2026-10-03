/**
 * 会话存储（sessions 表 CRUD）—— 会话服务端吊销的载体（PRD R6）
 *
 * - insertSession：登录/注册/改密重签/me 轮换时插行（jti PK）
 * - deleteSession：登出时按 jti 删行（吊销该会话）
 * - deleteSessionsByUser：改密时按 user 删全部行（双保险，token_version+1 保留）
 * - purgeExpired：登录时顺手清理过期行（惰性，避免表膨胀）
 *
 * 铁律（共享知识 8-6）：所有会话写路径必须同步 sessions 表——
 * login/register 插行、logout 删行、password 按 user 删行、me 轮换插新删旧，
 * 漏一处即出现"能登录但立刻 401"的 bug。
 */
import { query } from "./db";
import { ensureDatabase } from "./bootstrap";

/**
 * 插入会话行。
 * @param jti 会话标识（token payload.jti，32 字符 hex）
 * @param userId 用户 id
 * @param expiresAt 过期时间（= token iat + 7d；Date 按 UTC 序列化，池时区 Z）
 */
export async function insertSession(jti: string, userId: number, expiresAt: Date): Promise<void> {
    await ensureDatabase();
    await query(`INSERT INTO sessions (jti, user_id, expires_at) VALUES (?, ?, ?)`, [
        jti,
        userId,
        expiresAt,
    ]);
}

/** 按 jti 删除会话行（登出吊销；best-effort，行不存在静默成功） */
export async function deleteSession(jti: string): Promise<void> {
    await ensureDatabase();
    await query(`DELETE FROM sessions WHERE jti = ?`, [jti]);
}

/** 删除某用户全部会话行（改密全端失效双保险） */
export async function deleteSessionsByUser(userId: number): Promise<void> {
    await ensureDatabase();
    await query(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
}

/** 清理全部已过期会话行（登录时顺手调用，惰性清理） */
export async function purgeExpired(): Promise<void> {
    await ensureDatabase();
    // 连接池时区为 Z（UTC），UTC_TIMESTAMP(3) 与 DATETIME 存储口径一致
    await query(`DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP(3)`);
}
