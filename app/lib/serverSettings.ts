/**
 * 服务端 AI 配置解析
 *
 * 优先级：请求头（x-* 兼容期兜底）→ user_settings(当前用户 BYOK) → 空
 * 前端新版本不再发送 x-* 配置头（getApiHeaders 已退役），但旧缓存页面若仍发头也能正确工作。
 */
import type { NextRequest } from "next/server";
import { getSettings, type DbSettings } from "./settingsRepo";

export interface ResolvedConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
}

const EMPTY: ResolvedConfig = { apiKey: "", baseUrl: "", model: "" };

/** 文本大模型（LLM）配置：x-api-key / x-base-url / x-model → DB → 空 */
export async function resolveLlmConfig(req: NextRequest, userId: number): Promise<ResolvedConfig> {
    const headerKey = (req.headers.get("x-api-key") || req.headers.get("x-deepseek-api-key") || "").trim();
    const headerBaseUrl = (req.headers.get("x-base-url") || req.headers.get("x-deepseek-base-url") || "").trim();
    const headerModel = (req.headers.get("x-model") || req.headers.get("x-deepseek-model") || "").trim();

    if (headerKey) {
        return { apiKey: headerKey, baseUrl: headerBaseUrl, model: headerModel };
    }

    let db: DbSettings;
    try {
        db = await getSettings(userId);
    } catch (e) {
        console.error("[serverSettings] 读取 DB 设置失败:", e instanceof Error ? e.message : e);
        return EMPTY;
    }
    return {
        apiKey: db.llmApiKey,
        baseUrl: headerBaseUrl || db.llmBaseUrl,
        model: headerModel || db.llmModel,
    };
}

/** 语音转写（ASR）配置：x-asr-* → DB → 空 */
export async function resolveAsrConfig(req: NextRequest, userId: number): Promise<ResolvedConfig> {
    const headerKey = (
        req.headers.get("x-asr-api-key") ||
        req.headers.get("x-siliconflow-api-key") ||
        ""
    ).trim();
    const headerBaseUrl = (req.headers.get("x-asr-base-url") || "").trim();
    const headerModel = (
        req.headers.get("x-asr-model") ||
        req.headers.get("x-siliconflow-model") ||
        ""
    ).trim();

    if (headerKey) {
        return { apiKey: headerKey, baseUrl: headerBaseUrl, model: headerModel };
    }

    let db: DbSettings;
    try {
        db = await getSettings(userId);
    } catch (e) {
        console.error("[serverSettings] 读取 DB 设置失败:", e instanceof Error ? e.message : e);
        return EMPTY;
    }
    return {
        apiKey: db.asrApiKey,
        baseUrl: headerBaseUrl || db.asrBaseUrl,
        model: headerModel || db.asrModel,
    };
}
