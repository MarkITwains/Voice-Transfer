/**
 * 数据库引导：建表 + 存量 JSON 迁移 + 用户化结构改造（幂等）—— MySQL 版
 *
 * - ensureDatabase() 进程级 Promise 单例：首次被 repo 调用时执行（lazy），全程只跑一次
 * - DDL 全部 CREATE TABLE IF NOT EXISTS / 条件 ALTER，可安全重复执行
 * - 迁移一（meetings_json_v1）：.data/meetings.json → meetings 表（幂等，已有标记即跳过）
 * - 用户化改造（登录与多用户增量）：
 *     1) 建 users（bcrypt 哈希 / role / token_version）
 *     2) meetings 条件 ALTER 加 user_id + 索引 + 外键（查 information_schema 幂等）
 *     3) 建 user_settings（BYOK 每用户一行）
 *     4) app_settings 为空配置 → DROP（若发现数据则抛错回报，不 DROP）
 * - 重跑方式：DELETE FROM migration_markers WHERE name='meetings_json_v1'
 */
import fs from "fs";
import path from "path";
import { query } from "./db";
import type { MeetingData } from "./types";

const DATA_DIR = path.join(process.cwd(), ".data");
const MEETINGS_JSON = path.join(DATA_DIR, "meetings.json");
const MEETINGS_MARKER = "meetings_json_v1";

let ensurePromise: Promise<void> | undefined;

/** 核心业务表（幂等 DDL；JSON/时间列统一 NULL-able，默认值由应用层保证） */
async function createCoreTables(): Promise<void> {
    await query(`
        CREATE TABLE IF NOT EXISTS meetings (
            id             VARCHAR(64)  NOT NULL,
            title          VARCHAR(512) NOT NULL,
            style          VARCHAR(32)  NULL,
            type           VARCHAR(32)  NULL,
            summary        MEDIUMTEXT   NULL,
            key_decisions  JSON         NULL,
            risks          JSON         NULL,
            mindmap        JSON         NULL,
            todos          JSON         NULL,
            transcript     MEDIUMTEXT   NULL,
            audio_url      TEXT         NULL,
            duration       VARCHAR(32)  NULL,
            word_count     INT          NULL,
            created_at     DATETIME(3)  NOT NULL,
            updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
            PRIMARY KEY (id),
            INDEX idx_meetings_created_at (created_at)
        ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
    `);
    await query(`
        CREATE TABLE IF NOT EXISTS migration_markers (
            name    VARCHAR(64)  NOT NULL,
            done_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (name)
        ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
    `);
}

/** 建 users 表（幂等；username 唯一，utf8mb4_unicode_ci 天然大小写不敏感） */
async function createUsersTable(): Promise<void> {
    await query(`
        CREATE TABLE IF NOT EXISTS users (
            id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            username      VARCHAR(64)  NOT NULL,
            password_hash VARCHAR(72)  NOT NULL,
            role          VARCHAR(16)  NOT NULL DEFAULT 'user',
            token_version INT          NOT NULL DEFAULT 0,
            created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (id),
            UNIQUE KEY uk_username (username)
        ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
    `);
}

/** meetings 条件 ALTER：加 user_id 列 + 索引 + 外键（查 information_schema 幂等） */
async function alterMeetingsAddUserId(): Promise<void> {
    // 1) 列
    const col = await query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meetings' AND COLUMN_NAME = 'user_id'`
    );
    if (col.rowCount === 0) {
        await query(`ALTER TABLE meetings ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id`);
        console.info("[bootstrap] meetings 已加 user_id 列");
    }

    // 2) 索引
    const idx = await query(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meetings' AND INDEX_NAME = 'idx_meetings_user_created'`
    );
    if (idx.rowCount === 0) {
        await query(`ALTER TABLE meetings ADD INDEX idx_meetings_user_created (user_id, created_at)`);
        console.info("[bootstrap] meetings 已加索引 idx_meetings_user_created");
    }

    // 3) 外键
    const fk = await query(
        `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meetings' AND CONSTRAINT_NAME = 'fk_meetings_user'`
    );
    if (fk.rowCount === 0) {
        await query(
            `ALTER TABLE meetings ADD CONSTRAINT fk_meetings_user FOREIGN KEY (user_id) REFERENCES users(id)`
        );
        console.info("[bootstrap] meetings 已加外键 fk_meetings_user");
    }
}

/** 建 sessions 表（R6 会话吊销载体；jti 即 token payload 中的会话标识，幂等） */
async function createSessionsTable(): Promise<void> {
    await query(`
        CREATE TABLE IF NOT EXISTS sessions (
            jti        VARCHAR(32)     NOT NULL COMMENT '会话标识 = crypto.randomBytes(16) hex',
            user_id    BIGINT UNSIGNED NOT NULL,
            created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            expires_at DATETIME(3)     NOT NULL COMMENT '= token iat + 7d',
            PRIMARY KEY (jti),
            KEY idx_sessions_user (user_id, expires_at),
            CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id)
        ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
    `);
}

/** users 表条件 ALTER：加账号锁定列 failed_login_count / locked_until（查 information_schema 幂等） */
async function alterUsersAddLockColumns(): Promise<void> {
    const col1 = await query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'failed_login_count'`
    );
    if (col1.rowCount === 0) {
        await query(`ALTER TABLE users ADD COLUMN failed_login_count INT NOT NULL DEFAULT 0`);
        console.info("[bootstrap] users 已加 failed_login_count 列");
    }

    const col2 = await query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'locked_until'`
    );
    if (col2.rowCount === 0) {
        await query(`ALTER TABLE users ADD COLUMN locked_until DATETIME(3) NULL`);
        console.info("[bootstrap] users 已加 locked_until 列");
    }
}

/** 建 user_settings 表（BYOK，每用户一行，密钥沿用 .data/enc_key 加密） */
async function createUserSettingsTable(): Promise<void> {
    await query(`
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id         BIGINT UNSIGNED NOT NULL,
            llm_base_url    TEXT         NULL,
            llm_api_key_enc TEXT         NULL,
            llm_model       TEXT         NULL,
            asr_base_url    TEXT         NULL,
            asr_api_key_enc TEXT         NULL,
            asr_model       TEXT         NULL,
            updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
            PRIMARY KEY (user_id),
            CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users(id)
        ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
    `);
}

/**
 * app_settings 处理：确认为空配置后 DROP（单行结构无法平滑改造为按用户多行，直接新建 user_settings 更干净）。
 * 若发现任何有效配置数据（与"空配置"确认不符），抛错中止并不 DROP —— 交人工处理。
 */
async function dropAppSettingsIfEmpty(): Promise<void> {
    const exists = await query(
        `SELECT TABLE_NAME FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'app_settings'`
    );
    if (exists.rowCount === 0) return; // 表不存在（全新库），无需处理

    const data = await query(
        `SELECT COUNT(*) AS cnt FROM app_settings
         WHERE llm_base_url IS NOT NULL OR llm_api_key_enc IS NOT NULL OR llm_model IS NOT NULL
            OR asr_base_url IS NOT NULL OR asr_api_key_enc IS NOT NULL OR asr_model IS NOT NULL`
    );
    const rows = data.rows as unknown as { cnt: number }[];
    if (Number(rows[0]?.cnt ?? 0) > 0) {
        throw new Error(
            "[bootstrap] app_settings 表中发现有效配置数据（与'空配置'确认不符），已中止 DROP。请人工核对后处理！"
        );
    }
    await query(`DROP TABLE IF EXISTS app_settings`);
    console.info("[bootstrap] app_settings 为空配置，已 DROP（BYOK 改用 user_settings 表）");
}

/**
 * 迁移一：.data/meetings.json → meetings 表（幂等）
 * 源文件为 Record<roomId, MeetingData> 结构（与旧 app/store.ts 磁盘格式一致）
 */
async function migrateMeetingsJson(): Promise<void> {
    const marker = await query(`SELECT name FROM migration_markers WHERE name = ?`, [MEETINGS_MARKER]);
    if (marker.rowCount > 0) {
        return; // 已迁移过
    }

    if (!fs.existsSync(MEETINGS_JSON)) {
        await query(`INSERT IGNORE INTO migration_markers (name) VALUES (?)`, [MEETINGS_MARKER]);
        console.info("[bootstrap] 未发现 .data/meetings.json，跳过 JSON 迁移并写标记");
        return;
    }

    let source: Record<string, MeetingData>;
    try {
        source = JSON.parse(fs.readFileSync(MEETINGS_JSON, "utf-8"));
    } catch (e) {
        throw new Error(
            `[bootstrap] .data/meetings.json 解析失败，迁移中止（未写标记，可修复后重试）: ${
                e instanceof Error ? e.message : String(e)
            }`
        );
    }

    const entries = Object.entries(source).filter(([, v]) => v && typeof v === "object");
    const sourceCount = entries.length;
    if (sourceCount === 0) {
        await query(`INSERT IGNORE INTO migration_markers (name) VALUES (?)`, [MEETINGS_MARKER]);
        console.info("[bootstrap] .data/meetings.json 为空对象，写标记结束");
        return;
    }

    // 先备份（保留，不自动删）
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = `${MEETINGS_JSON}.bak-${stamp}`;
    fs.copyFileSync(MEETINGS_JSON, backupFile);

    // 逐条导入：INSERT IGNORE 保证重跑不产生重复/覆盖
    let imported = 0;
    let skipped = 0;
    let firstTitle = "";
    let firstTodoCount = 0;

    for (const [id, m] of entries) {
        const createdAt = m.createdAt ? new Date(m.createdAt) : new Date();
        const validCreatedAt = isNaN(createdAt.getTime()) ? new Date() : createdAt;
        try {
            const res = await query(
                `INSERT IGNORE INTO meetings
                    (id, title, style, type, summary, key_decisions, risks, mindmap, todos,
                     transcript, audio_url, duration, word_count, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    id.slice(0, 64),
                    m.title || "未命名会议",
                    m.style ?? null,
                    m.type ?? null,
                    m.summary ?? "",
                    JSON.stringify(Array.isArray(m.keyDecisions) ? m.keyDecisions : []),
                    JSON.stringify(Array.isArray(m.risks) ? m.risks : []),
                    JSON.stringify(Array.isArray(m.mindmap) ? m.mindmap : []),
                    JSON.stringify(Array.isArray(m.todos) ? m.todos : []),
                    m.transcript ?? null,
                    m.audioUrl ?? null,
                    m.duration ?? null,
                    typeof m.wordCount === "number" ? m.wordCount : null,
                    validCreatedAt,
                ]
            );
            if (res.rowCount > 0) {
                imported++;
                if (!firstTitle) {
                    firstTitle = m.title || "";
                    firstTodoCount = Array.isArray(m.todos) ? m.todos.length : 0;
                }
            } else {
                skipped++;
            }
        } catch (e) {
            // 单条失败即整体失败：不写标记，下次 bootstrap 重试（已导入行因 INSERT IGNORE 天然幂等）
            throw new Error(
                `[bootstrap] 迁移第 ${imported + skipped + 1} 条（id=${id}）失败，已保留备份 ${backupFile}，未写标记: ${
                    e instanceof Error ? e.message : String(e)
                }`
            );
        }
    }

    await query(`INSERT IGNORE INTO migration_markers (name) VALUES (?)`, [MEETINGS_MARKER]);

    // 校验报告（R7）
    console.info(
        `[bootstrap][迁移校验 meetings_json_v1] 源条数=${sourceCount} 导入条数=${imported} 冲突跳过条数=${skipped}; ` +
            `抽样首条 title="${firstTitle}" todos长度=${firstTodoCount}; 备份=${backupFile}`
    );
}

/** 确保数据库就绪（进程级单例，repo 层入口统一 await） */
export function ensureDatabase(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await createCoreTables();
            await createUsersTable(); // 先于 meetings/sessions 外键
            await alterMeetingsAddUserId();
            await createSessionsTable(); // 会话吊销载体（R6）
            await alterUsersAddLockColumns(); // 账号锁定列（R7）
            await createUserSettingsTable();
            await migrateMeetingsJson();
            await dropAppSettingsIfEmpty();
            console.info("[bootstrap] 数据库就绪（建表 + 迁移检查完成）");
        })().catch((e) => {
            // 失败时重置单例，下次请求可重试
            ensurePromise = undefined;
            throw e;
        });
    }
    return ensurePromise;
}
