/**
 * 会议数据访问层（MySQL）
 *
 * 函数名与旧 app/store.ts 一致，但全部为 async（调用点必须 await）。
 * created_at 对外输出 ISO 字符串，保持 MeetingData.createdAt 契约。
 * 写操作全部下沉为单条 SQL，由 InnoDB 行级锁保证并发原子性。
 */
import { query } from "./db";
import { ensureDatabase } from "./bootstrap";
import type { MeetingData, MindMapNode, Todo } from "./types";

/** DB 行结构（snake_case，时间列在 timezone 'Z' 连接下读出为 UTC Date） */
interface MeetingRow {
    id: string;
    title: string;
    style: string | null;
    type: string | null;
    summary: string | null;
    key_decisions: unknown;
    risks: unknown;
    mindmap: unknown;
    todos: unknown;
    transcript: string | null;
    audio_url: string | null;
    duration: string | null;
    word_count: number | null;
    created_at: Date | string;
}

/** DATETIME → ISO 字符串（Date 直接 toISOString；字符串则归一化为 UTC ISO） */
function toIso(value: Date | string): string {
    if (value instanceof Date) return value.toISOString();
    const raw = String(value).trim().replace(" ", "T");
    const withZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
    const d = new Date(withZone);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function rowToMeeting(row: MeetingRow): MeetingData & { id: string } {
    const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    return {
        id: row.id,
        title: row.title,
        style: row.style ?? undefined,
        type: row.type ?? undefined,
        summary: row.summary ?? "",
        keyDecisions: asArray<string>(row.key_decisions),
        risks: asArray<string>(row.risks),
        mindmap: asArray<MindMapNode>(row.mindmap),
        todos: asArray<Todo>(row.todos),
        transcript: row.transcript ?? undefined,
        audioUrl: row.audio_url ?? undefined,
        duration: row.duration ?? undefined,
        wordCount: row.word_count ?? undefined,
        createdAt: toIso(row.created_at),
    };
}

/** 新增或整体覆盖（upsert；updated_at 由 ON UPDATE CURRENT_TIMESTAMP 自动维护） */
export async function saveMeeting(userId: number, roomId: string, data: MeetingData): Promise<void> {
    await ensureDatabase();
    const createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
    const validCreatedAt = isNaN(createdAt.getTime()) ? new Date() : createdAt;
    await query(
        `INSERT INTO meetings
            (id, user_id, title, style, type, summary, key_decisions, risks, mindmap, todos,
             transcript, audio_url, duration, word_count, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
            title         = VALUES(title),
            style         = VALUES(style),
            type          = VALUES(type),
            summary       = VALUES(summary),
            key_decisions = VALUES(key_decisions),
            risks         = VALUES(risks),
            mindmap       = VALUES(mindmap),
            todos         = VALUES(todos),
            transcript    = VALUES(transcript),
            audio_url     = VALUES(audio_url),
            duration      = VALUES(duration),
            word_count    = VALUES(word_count),
            created_at    = VALUES(created_at)`,
        [
            roomId.slice(0, 64),
            userId,
            data.title || "未命名会议",
            data.style ?? null,
            data.type ?? null,
            data.summary ?? "",
            JSON.stringify(Array.isArray(data.keyDecisions) ? data.keyDecisions : []),
            JSON.stringify(Array.isArray(data.risks) ? data.risks : []),
            JSON.stringify(Array.isArray(data.mindmap) ? data.mindmap : []),
            JSON.stringify(Array.isArray(data.todos) ? data.todos : []),
            data.transcript ?? null,
            data.audioUrl ?? null,
            data.duration ?? null,
            typeof data.wordCount === "number" ? data.wordCount : null,
            validCreatedAt,
        ]
    );
}

/** 按 id 取单条（仅限本用户）；不存在或他人会议均返回 undefined（路由映射 404，不暴露存在性） */
export async function getMeeting(userId: number, roomId: string): Promise<MeetingData | undefined> {
    await ensureDatabase();
    const res = await query<MeetingRow>(`SELECT * FROM meetings WHERE id = ? AND user_id = ?`, [roomId, userId]);
    if (!res.rows.length) return undefined;
    return rowToMeeting(res.rows[0]);
}

/** 按创建时间倒序列出本用户会议（默认 50 条；limit 已白名单化为整数后内联，规避 LIMIT 占位符兼容问题） */
export async function listMeetings(userId: number, limit = 50): Promise<(MeetingData & { id: string })[]> {
    await ensureDatabase();
    const safeLimit = Math.floor(Math.max(1, Math.min(Number(limit) || 50, 200)));
    const res = await query<MeetingRow>(
        `SELECT * FROM meetings WHERE user_id = ? ORDER BY created_at DESC LIMIT ${safeLimit}`,
        [userId]
    );
    return res.rows.map(rowToMeeting);
}

/** 部分字段更新；不存在返回 false */
export async function updateMeeting(userId: number, roomId: string, partial: Partial<MeetingData>): Promise<boolean> {
    await ensureDatabase();

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (sqlExpr: string, value: unknown) => {
        params.push(value);
        sets.push(`${sqlExpr} = ?`);
    };

    if (partial.title !== undefined) push("title", partial.title);
    if (partial.style !== undefined) push("style", partial.style);
    if (partial.type !== undefined) push("type", partial.type);
    if (partial.summary !== undefined) push("summary", partial.summary);
    if (partial.keyDecisions !== undefined) push("key_decisions", JSON.stringify(partial.keyDecisions));
    if (partial.risks !== undefined) push("risks", JSON.stringify(partial.risks));
    if (partial.mindmap !== undefined) push("mindmap", JSON.stringify(partial.mindmap));
    if (partial.todos !== undefined) push("todos", JSON.stringify(partial.todos));
    if (partial.transcript !== undefined) push("transcript", partial.transcript);
    if (partial.audioUrl !== undefined) push("audio_url", partial.audioUrl);
    if (partial.duration !== undefined) push("duration", partial.duration);
    if (partial.wordCount !== undefined) push("word_count", partial.wordCount);
    if (partial.createdAt !== undefined && partial.createdAt) {
        const d = new Date(partial.createdAt);
        if (!isNaN(d.getTime())) push("created_at", d);
    }

    if (sets.length === 0) {
        // 无有效字段：仅判断存在性（限本用户）
        const exists = await query(`SELECT 1 AS one FROM meetings WHERE id = ? AND user_id = ?`, [roomId, userId]);
        return exists.rowCount > 0;
    }

    // updated_at 由 ON UPDATE CURRENT_TIMESTAMP 自动维护，无需显式 SET
    params.push(roomId, userId);
    const res = await query(
        `UPDATE meetings SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
        params
    );
    return res.rowCount > 0;
}

/** 删除（仅限本用户）；不存在或他人会议均返回 false（路由映射 404） */
export async function deleteMeeting(userId: number, roomId: string): Promise<boolean> {
    await ensureDatabase();
    const res = await query(`DELETE FROM meetings WHERE id = ? AND user_id = ?`, [roomId, userId]);
    return res.rowCount > 0;
}
