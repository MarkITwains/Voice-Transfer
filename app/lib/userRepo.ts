/**
 * 用户数据访问层（users 表）
 *
 * - registerUser：事务内「锁 users 表 → 判定首人 → 插入 →（首人）claim 无主会议 + 登记标记」，幂等
 * - verifyLogin：按用户名取哈希（utf8mb4_unicode_ci 天然大小写不敏感）→ bcrypt.compare 由调用方执行
 * - changePassword：更新哈希且 token_version + 1（踢全端旧会话）
 * - listUsers：管理员只读用户列表（R10）
 */
import bcrypt from "bcryptjs";
import { getPool, query } from "./db";
import { ensureDatabase } from "./bootstrap";
import { deleteSessionsByUser } from "./sessionStore";
import type { RowDataPacket, ResultSetHeader } from "mysql2/promise";

const BCRYPT_ROUNDS = 10;

/** 账号锁定参数（Q3 定稿）：连续失败 5 次锁 15 分钟，自动解锁，与 IP 限速独立计数叠加生效 */
export const LOGIN_LOCK_THRESHOLD = 5;
export const LOGIN_LOCK_MINUTES = 15;

export interface UserRecord {
    id: number;
    username: string;
    role: string;
    tokenVersion: number;
    createdAt: string;
}

interface UserRow {
    id: number;
    username: string;
    password_hash: string;
    role: string;
    token_version: number;
    created_at: Date | string;
}

function rowToUser(row: UserRow): UserRecord {
    const created = row.created_at instanceof Date ? row.created_at.toISOString() : new Date(String(row.created_at)).toISOString();
    return {
        id: Number(row.id),
        username: row.username,
        role: row.role,
        tokenVersion: Number(row.token_version),
        createdAt: isNaN(new Date(created).getTime()) ? new Date().toISOString() : created,
    };
}

export interface RegisterResult {
    user: UserRecord;
    /** 本次注册是否为首个用户（= 是否执行了无主会议 claim） */
    isFirstUser: boolean;
    /** 首人 claim 归属的会议条数 */
    claimedMeetings: number;
}

/**
 * 注册用户（事务内）：
 *   SELECT id FROM users LIMIT 1 FOR UPDATE  -- 锁住用户集，防并发双首注册
 *   COUNT(*) == 0 → role='admin' + claim 无主会议（WHERE user_id IS NULL，天然幂等）+ 登记 marker
 *   否则 role='user'
 * 用户名唯一冲突由 uk_username 抛错（调用方转 400"用户名已存在"）。
 */
export async function registerUser(username: string, password: string): Promise<RegisterResult> {
    await ensureDatabase();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const pool = getPool();
    const conn = await pool.getConnection();
    let isFirstUser = false;
    let claimed = 0;
    try {
        await conn.beginTransaction();
        // 锁用户集：空表时锁间隙，两个并发注册只有一个看到 COUNT=0（单实例 MySQL，够用）
        await conn.query(`SELECT id FROM users LIMIT 1 FOR UPDATE`);
        const [countRows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS c FROM users`);
        const rows = countRows as unknown as { c: number }[];
        const userCount = Number(rows[0]?.c ?? 0);
        isFirstUser = userCount === 0;

        const role = isFirstUser ? "admin" : "user";
        const [insertResult] = await conn.query(
            `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`,
            [username, passwordHash, role]
        );
        const userId = Number((insertResult as { insertId: number }).insertId);

        if (isFirstUser) {
            // claim 无主会议：WHERE user_id IS NULL 天然幂等（重跑只影响未归属行）
            const [claimResult] = await conn.query(
                `UPDATE meetings SET user_id = ? WHERE user_id IS NULL`,
                [userId]
            );
            claimed = Number((claimResult as { affectedRows: number }).affectedRows ?? 0);
            // 登记审计标记（幂等写法）
            await conn.query(
                `INSERT INTO migration_markers (name) VALUES ('claim_meetings_v1')
                 ON DUPLICATE KEY UPDATE done_at = done_at`
            );
        }

        await conn.commit();

        const user: UserRecord = {
            id: userId,
            username,
            role,
            tokenVersion: 0,
            createdAt: new Date().toISOString(),
        };
        return { user, isFirstUser, claimedMeetings: claimed };
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}

/** 按用户名查（唯一入口：登录）；不存在返回 null */
export async function getUserByUsername(username: string): Promise<UserRecord | null> {
    await ensureDatabase();
    const res = await query<UserRow>(`SELECT * FROM users WHERE username = ?`, [username]);
    if (!res.rows.length) return null;
    return rowToUser(res.rows[0]);
}

/** 按 id 查；不存在返回 null */
export async function getUserById(id: number): Promise<UserRecord | null> {
    await ensureDatabase();
    const res = await query<UserRow>(`SELECT * FROM users WHERE id = ?`, [id]);
    if (!res.rows.length) return null;
    return rowToUser(res.rows[0]);
}

/** 取密码哈希（登录校验用）；不存在返回 null */
export async function getPasswordHash(username: string): Promise<string | null> {
    await ensureDatabase();
    const res = await query<UserRow>(`SELECT * FROM users WHERE username = ?`, [username]);
    if (!res.rows.length) return null;
    return res.rows[0].password_hash;
}

/** bcrypt 比对（封装于此，路由层不直接依赖 bcryptjs） */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
}

/**
 * 修改密码：更新哈希且 token_version = token_version + 1（旧会话全端失效），
 * 并删除该用户全部 sessions 行（服务端吊销双保险，R6）。
 * @returns 更新后的用户信息（tokenVersion 为新值）；用户不存在返回 null
 */
export async function changePassword(
    userId: number,
    newPassword: string
): Promise<UserRecord | null> {
    await ensureDatabase();
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const res = await query(
        `UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?`,
        [passwordHash, userId]
    );
    if (res.rowCount === 0) return null;
    // 服务端吊销双保险：即使 token_version 核对被绕过，sessions 行已删（requireUser JOIN 无行 → 401）
    await deleteSessionsByUser(userId);
    return getUserById(userId);
}

// ---------------- 账号锁定（R7：5 次 / 15 分钟，独立于 IP 限速） ----------------

/** 锁定状态查询结果（登录路由用） */
export interface LockState {
    id: number;
    failedLoginCount: number;
    lockedUntil: Date | null;
    tokenVersion: number;
}

interface LockRow {
    id: number;
    failed_login_count: number;
    locked_until: Date | string | null;
    token_version: number;
}

/**
 * 取账号锁定状态；用户不存在返回 null（由调用方走模糊 401，不计数）。
 */
export async function getLoginLockState(username: string): Promise<LockState | null> {
    await ensureDatabase();
    const res = await query<LockRow>(
        `SELECT id, failed_login_count, locked_until, token_version FROM users WHERE username = ?`,
        [username]
    );
    if (!res.rows.length) return null;
    const row = res.rows[0];
    const lu = row.locked_until
        ? (row.locked_until instanceof Date ? row.locked_until : new Date(String(row.locked_until)))
        : null;
    return {
        id: Number(row.id),
        failedLoginCount: Number(row.failed_login_count),
        lockedUntil: lu && !isNaN(lu.getTime()) ? lu : null,
        tokenVersion: Number(row.token_version),
    };
}

/**
 * 密码错误计数 +1（原子单语句）；达 5 次时上锁 15 分钟并将计数归零。
 * 仅密码错误才调用（验证码错误/缺失不计数，防锁定 DoS）。
 * @returns 更新后的 { failedLoginCount, locked }（locked=true 表示本次触发了上锁）
 */
export async function incrementFailedLogin(
    userId: number
): Promise<{ failedLoginCount: number; locked: boolean }> {
    await ensureDatabase();
    // 原子语义：failed+1 >= 5 → locked_until = UTC now + 15min 且计数归零；否则仅 +1
    await query(
        `UPDATE users SET
            locked_until = IF(failed_login_count + 1 >= ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MINUTE), locked_until),
            failed_login_count = IF(failed_login_count + 1 >= ?, 0, failed_login_count + 1)
         WHERE id = ?`,
        [LOGIN_LOCK_THRESHOLD, LOGIN_LOCK_MINUTES, LOGIN_LOCK_THRESHOLD, userId]
    );
    // 回读结果（单实例 MySQL，两次往返可接受；连接池时区 Z，UTC_TIMESTAMP 口径一致）
    const res = await query<LockRow>(
        `SELECT id, failed_login_count, locked_until, token_version FROM users WHERE id = ?`,
        [userId]
    );
    const row = res.rows[0];
    const lockedUntil = row?.locked_until
        ? (row.locked_until instanceof Date ? row.locked_until : new Date(String(row.locked_until)))
        : null;
    const locked = Boolean(lockedUntil && lockedUntil.getTime() > Date.now());
    return { failedLoginCount: Number(row?.failed_login_count ?? 0), locked };
}

/** 成功登录：清零失败计数并解除锁定 */
export async function resetLoginState(userId: number): Promise<void> {
    await ensureDatabase();
    await query(
        `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?`,
        [userId]
    );
}

/** 管理员只读用户列表（R10） */
export async function listUsers(): Promise<UserRecord[]> {
    await ensureDatabase();
    const res = await query<UserRow>(`SELECT * FROM users ORDER BY id ASC`);
    return res.rows.map(rowToUser);
}
