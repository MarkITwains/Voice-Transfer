/**
 * 设置数据访问层（user_settings 表，每用户一行）—— BYOK 多用户版
 *
 * - 密钥列（*_api_key_enc）只经 app/lib/crypto.ts 加解密，格式 v1:<iv>:<tag>:<cipher>
 * - getSettings(userId) 返回解密后的完整配置（仅供服务端模块内部使用，绝不直接下发给前端）
 * - saveSettings(userId, patch) 保存规则：apiKey 为空串/缺省 → 保留库中旧值；仅显式 clearXxxApiKey=true 才清除
 * - initialized 语义 = 当前用户是否已存任一配置
 */
import { query } from "./db";
import { ensureDatabase } from "./bootstrap";
import { decrypt, encrypt } from "./crypto";

/** DB 中解密后的设置（服务端内部视图） */
export interface DbSettings {
    llmBaseUrl: string;
    llmApiKey: string;
    llmModel: string;
    asrBaseUrl: string;
    asrApiKey: string;
    asrModel: string;
}

/** 保存补丁（全部可选） */
export interface SettingsPatch {
    llmBaseUrl?: string;
    llmModel?: string;
    llmApiKey?: string;
    clearLlmApiKey?: boolean;
    asrBaseUrl?: string;
    asrModel?: string;
    asrApiKey?: string;
    clearAsrApiKey?: boolean;
}

interface SettingsRow {
    llm_base_url: string | null;
    llm_api_key_enc: string | null;
    llm_model: string | null;
    asr_base_url: string | null;
    asr_api_key_enc: string | null;
    asr_model: string | null;
}

function rowToSettings(row: SettingsRow): DbSettings {
    return {
        llmBaseUrl: row.llm_base_url ?? "",
        llmApiKey: decrypt(row.llm_api_key_enc),
        llmModel: row.llm_model ?? "",
        asrBaseUrl: row.asr_base_url ?? "",
        asrApiKey: decrypt(row.asr_api_key_enc),
        asrModel: row.asr_model ?? "",
    };
}

const EMPTY_SETTINGS: DbSettings = {
    llmBaseUrl: "", llmApiKey: "", llmModel: "", asrBaseUrl: "", asrApiKey: "", asrModel: "",
};

/** 读取某用户的解密后设置；无行返回空配置 */
export async function getSettings(userId: number): Promise<DbSettings> {
    await ensureDatabase();
    const res = await query<SettingsRow>(`SELECT * FROM user_settings WHERE user_id = ?`, [userId]);
    if (!res.rows.length) return EMPTY_SETTINGS;
    return rowToSettings(res.rows[0]);
}

/**
 * 保存某用户的设置（读旧值合并后 upsert，避免部分覆盖；首保存自动建行）
 * - xxxApiKey 为空串/undefined 且未 clear → 保留库中旧密钥
 * - clearXxxApiKey === true → 清除密钥（优先级最高）
 */
export async function saveSettings(userId: number, patch: SettingsPatch): Promise<DbSettings> {
    await ensureDatabase();
    const current = await getSettings(userId);

    let llmApiKeyEnc: string | null = current.llmApiKey ? encrypt(current.llmApiKey) : null;
    if (patch.clearLlmApiKey === true) {
        llmApiKeyEnc = null;
    } else if (patch.llmApiKey && patch.llmApiKey.trim()) {
        llmApiKeyEnc = encrypt(patch.llmApiKey.trim());
    }

    let asrApiKeyEnc: string | null = current.asrApiKey ? encrypt(current.asrApiKey) : null;
    if (patch.clearAsrApiKey === true) {
        asrApiKeyEnc = null;
    } else if (patch.asrApiKey && patch.asrApiKey.trim()) {
        asrApiKeyEnc = encrypt(patch.asrApiKey.trim());
    }

    const next = {
        llmBaseUrl: patch.llmBaseUrl !== undefined ? patch.llmBaseUrl.trim() : current.llmBaseUrl,
        llmModel: patch.llmModel !== undefined ? patch.llmModel.trim() : current.llmModel,
        asrBaseUrl: patch.asrBaseUrl !== undefined ? patch.asrBaseUrl.trim() : current.asrBaseUrl,
        asrModel: patch.asrModel !== undefined ? patch.asrModel.trim() : current.asrModel,
    };

    // updated_at 由 ON UPDATE CURRENT_TIMESTAMP 自动维护
    await query(
        `INSERT INTO user_settings
            (user_id, llm_base_url, llm_api_key_enc, llm_model, asr_base_url, asr_api_key_enc, asr_model)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
            llm_base_url    = VALUES(llm_base_url),
            llm_api_key_enc = VALUES(llm_api_key_enc),
            llm_model       = VALUES(llm_model),
            asr_base_url    = VALUES(asr_base_url),
            asr_api_key_enc = VALUES(asr_api_key_enc),
            asr_model       = VALUES(asr_model)`,
        [
            userId,
            next.llmBaseUrl || null,
            llmApiKeyEnc,
            next.llmModel || null,
            next.asrBaseUrl || null,
            asrApiKeyEnc,
            next.asrModel || null,
        ]
    );

    return {
        ...next,
        llmApiKey: decrypt(llmApiKeyEnc),
        asrApiKey: decrypt(asrApiKeyEnc),
    };
}

/** 某用户是否已存有任一配置（对应 GET /api/settings 的 initialized，按用户判定） */
export async function hasStoredSettings(userId: number): Promise<boolean> {
    const s = await getSettings(userId);
    return Boolean(
        s.llmApiKey || s.llmBaseUrl || s.llmModel || s.asrApiKey || s.asrBaseUrl || s.asrModel
    );
}
