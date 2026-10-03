/**
 * MySQL 连接层（唯一入口）
 *
 * - Pool 挂在 globalThis 上，规避 Next.js dev 热重载反复建池导致的连接泄漏
 * - 连接串唯一来源 process.env.DATABASE_URL（.env.local），禁止硬编码
 * - 业务代码只允许通过 query()/pingDb() 访问数据库；写操作由 InnoDB 行级锁保证并发原子性
 */
import {
    createPool as createMysqlPool,
    type Pool,
    type RowDataPacket,
    type ResultSetHeader,
} from "mysql2/promise";

declare global {
    // eslint-disable-next-line no-var
    var __meetingAiMysqlPool: Pool | undefined;
}

function createPool(): Pool {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error(
            "未配置 DATABASE_URL 环境变量。请在项目根目录 .env.local 中设置 MySQL 连接串（参考 .env.example）"
        );
    }
    // 手工解析连接串（不依赖驱动对 uri 字段的行为差异）
    const u = new URL(connectionString);
    if (u.protocol !== "mysql:" && u.protocol !== "mariadb:") {
        throw new Error(`DATABASE_URL 协议不正确：${u.protocol}（应为 mysql://）`);
    }
    return createMysqlPool({
        host: u.hostname,
        port: Number(u.port || 3306),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: decodeURIComponent(u.pathname.replace(/^\//, "")),
        connectionLimit: 5,
        maxIdle: 5,
        idleTimeout: 30_000,
        connectTimeout: 10_000,
        charset: "utf8mb4",
        timezone: "Z", // DATETIME 统一按 UTC 读写：写入 Date 序列化为 UTC，读出按 UTC 还原为 Date
        flags: ["FOUND_ROWS"], // UPDATE 的 affectedRows 取“命中行数”而非“变化行数”，保证存在性判定正确
    });
}

/** 获取进程级单例 Pool */
export function getPool(): Pool {
    if (!globalThis.__meetingAiMysqlPool) {
        globalThis.__meetingAiMysqlPool = createPool();
    }
    return globalThis.__meetingAiMysqlPool;
}

export interface QueryResult<T> {
    rows: T[];
    rowCount: number;
}

/** 执行一条参数化 SQL（SELECT 返回行集；写操作 rowCount = affectedRows） */
export async function query<T = RowDataPacket>(
    sql: string,
    params: readonly unknown[] = []
): Promise<QueryResult<T>> {
    const [result] = await getPool().query(sql, params as unknown[]);
    if (Array.isArray(result)) {
        return { rows: result as unknown as T[], rowCount: result.length };
    }
    const header = result as ResultSetHeader;
    return { rows: [], rowCount: header.affectedRows ?? 0 };
}

/** 探活：SELECT 1，供 /api/health 使用（连接失败时抛错，由路由层转 500） */
export async function pingDb(): Promise<boolean> {
    const res = await query("SELECT 1 AS ok");
    const row = res.rows[0] as { ok?: number } | undefined;
    return row?.ok === 1;
}
