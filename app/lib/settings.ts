// 用户端通用 API 配置管理（服务端入库版）
//
// 配置统一存储于服务端 PostgreSQL（app_settings 表），密钥 AES-256-GCM 加密落库，
// 任何 API 响应都不回传明文 apiKey（仅脱敏尾 4 位）。
// 本模块职责：
//   - loadSettings()   ：GET /api/settings（带内存缓存）
//   - persistSettings():PUT /api/settings（apiKey 留空 = 保留服务端旧值）
//   - clearApiSettings()：仅清浏览器本地旧缓存（v1/v2），服务端清密钥走 persistSettings 的 clearXxxApiKey
//   - initSettingsSync()：首访一次性上报 localStorage 旧配置到服务端（幂等、静默失败）
//
// 旧版 getApiHeaders() 已删除：服务端改为从 DB 读取配置，前端不再发送 x-* 配置头。

export interface UserApiSettings {
    // 文本大模型配置 (LLM - 用于会议纪要梳理、待办提取、问答)
    llmBaseUrl?: string;
    llmApiKey?: string;
    llmModel?: string;

    // 语音转写服务配置 (ASR - 用于录音与音频文件转文字)
    asrBaseUrl?: string;
    asrApiKey?: string;
    asrModel?: string;

    // 兼容历史字段（仅旧 localStorage 迁移上报时读取，不再直接使用）
    deepseekApiKey?: string;
    deepseekBaseUrl?: string;
    deepseekModel?: string;
    siliconflowApiKey?: string;
    siliconflowModel?: string;
}

/** GET /api/settings 返回的脱敏视图 */
export interface SettingsView {
    llmBaseUrl: string;
    llmModel: string;
    llmHasApiKey: boolean;
    llmApiKeyMasked: string | null;
    asrBaseUrl: string;
    asrModel: string;
    asrHasApiKey: boolean;
    asrApiKeyMasked: string | null;
    initialized: boolean;
}

/** PUT /api/settings 的保存补丁（全部可选） */
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

export const SETTINGS_KEY = "meeting_ai_user_custom_settings_v2";
const LEGACY_SETTINGS_KEY_V1 = "meeting_ai_user_settings_v1";
const MIGRATED_MARKER_KEY = "meeting_ai_settings_migrated_v3";

// ---------------------------------------------------------------------------
// localStorage 兼容读取（旧配置迁移上报专用）
// ---------------------------------------------------------------------------

/** 读取本地 localStorage 中的旧配置（v2 优先，兼容 v1 迁移）；仅浏览器端可用 */
export function readLocalSettings(): UserApiSettings {
    if (typeof window === "undefined") return {};
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) return JSON.parse(raw) as UserApiSettings;

        // 尝试从 v1 迁移格式读取
        const oldRaw = localStorage.getItem(LEGACY_SETTINGS_KEY_V1);
        if (oldRaw) {
            const old = JSON.parse(oldRaw);
            return {
                llmApiKey: old.deepseekApiKey || "",
                llmBaseUrl: old.deepseekBaseUrl || "https://api.deepseek.com",
                llmModel: old.deepseekModel || "deepseek-chat",
                asrApiKey: old.siliconflowApiKey || "",
                asrBaseUrl: "https://api.siliconflow.cn/v1",
                asrModel: old.siliconflowModel || "XingChenAGI/XingChenASR-V3.2-Ultra",
            };
        }
        return {};
    } catch {
        return {};
    }
}

/** 写入本地 localStorage 缓存（可选能力：仅作展示缓存，服务端 DB 为准） */
export function writeLocalSettings(settings: UserApiSettings): void {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.error("保存本地配置缓存失败:", e);
    }
}

// ---------------------------------------------------------------------------
// 服务端 API 客户端
// ---------------------------------------------------------------------------

let settingsCache: SettingsView | null = null;

/** 业务请求收到 401 时统一跳转登录页（前端 401 处理唯一入口） */
export function gotoLoginOn401(status: number): boolean {
    if (status === 401 && typeof window !== "undefined") {
        window.location.href = "/login";
        return true;
    }
    return false;
}

/** 从服务端拉取脱敏设置（带内存缓存）；forceRefresh 用于保存后刷新 */
export async function loadSettings(forceRefresh = false): Promise<SettingsView> {
    if (!forceRefresh && settingsCache) return settingsCache;
    const res = await fetch("/api/settings", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok || data.error) {
        throw new Error(data.error || "读取接口设置失败");
    }
    settingsCache = data.settings as SettingsView;
    return settingsCache;
}

/** 保存设置到服务端；apiKey 留空/缺省 = 保留服务端旧值 */
export async function persistSettings(patch: SettingsPatch): Promise<SettingsView> {
    const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
        throw new Error(data.error || "保存接口设置失败");
    }
    settingsCache = data.settings as SettingsView;
    return settingsCache;
}

/** 仅清空浏览器本地旧缓存（不影响服务端 DB；服务端清密钥走 persistSettings 的 clearXxxApiKey） */
export function clearApiSettings(): void {
    if (typeof window === "undefined") return;
    try {
        localStorage.removeItem(SETTINGS_KEY);
        localStorage.removeItem(LEGACY_SETTINGS_KEY_V1);
    } catch {
        // ignore
    }
}

// ---------------------------------------------------------------------------
// 首访一次性上报迁移（localStorage 旧配置 → 服务端 DB，多用户版）
//
// 触发：HomeClient 挂载且已登录（/api/auth/me 成功）后调用
// 上报条件（全部满足才 PUT）：
//   ① 本地无 meeting_ai_settings_migrated_v3 标记
//   ② localStorage(SETTINGS_KEY/v1) 有有效旧配置
//   ③ GET /api/settings 返回【当前用户】initialized === false（settingsRepo 按用户门闩）
// 效果：每个浏览器只迁移一次；同浏览器换账号登录不重复上报（标记已设）；
//       新用户新设备本地无旧数据 → 天然不触发
// 幂等性由服务端"按用户 initialized"保证，本地标记仅减少一次请求；失败静默不挡首屏
// ---------------------------------------------------------------------------

let initSyncPromise: Promise<void> | null = null;

/** HomeClient 登录确认后调用；Promise 去重，进程内只跑一次 */
export function initSettingsSync(): Promise<void> {
    if (!initSyncPromise) {
        initSyncPromise = doInitSettingsSync().catch(() => {
            // 静默降级：上报失败不打断首屏，用户仍可在设置弹窗手动填写
        });
    }
    return initSyncPromise;
}

async function doInitSettingsSync(): Promise<void> {
    if (typeof window === "undefined") return;

    // ① 本地标记已有 → 本浏览器已上报过（同浏览器换账号也不重复）
    if (localStorage.getItem(MIGRATED_MARKER_KEY)) return;

    let view: SettingsView;
    try {
        view = await loadSettings();
    } catch {
        return; // 服务端不可达或未登录，静默退出（下次首访重试）
    }

    // ③ 服务端该用户已存有配置 → DB 为准，本地旧值不再上报
    if (view.initialized) {
        localStorage.setItem(MIGRATED_MARKER_KEY, "1");
        return;
    }

    // ② 读取本地旧配置（v2 原样；v1 兼容格式归一化后上报）
    const local = readLocalSettings();
    const llmApiKey = (local.llmApiKey || local.deepseekApiKey || "").trim();
    const llmBaseUrl = (local.llmBaseUrl || local.deepseekBaseUrl || "").trim();
    const llmModel = (local.llmModel || local.deepseekModel || "").trim();
    const asrApiKey = (local.asrApiKey || local.siliconflowApiKey || "").trim();
    const asrBaseUrl = (local.asrBaseUrl || "").trim();
    const asrModel = (local.asrModel || local.siliconflowModel || "").trim();

    if (!llmApiKey && !llmBaseUrl && !llmModel && !asrApiKey && !asrBaseUrl && !asrModel) {
        // 本地无有效配置，直接写标记结束
        localStorage.setItem(MIGRATED_MARKER_KEY, "1");
        return;
    }

    try {
        await persistSettings({
            llmBaseUrl: llmBaseUrl || undefined,
            llmModel: llmModel || undefined,
            llmApiKey: llmApiKey || undefined,
            asrBaseUrl: asrBaseUrl || undefined,
            asrModel: asrModel || undefined,
            asrApiKey: asrApiKey || undefined,
        });
        // 成功后写本地标记防重放
        localStorage.setItem(MIGRATED_MARKER_KEY, "1");
    } catch {
        // 上报失败静默：不写标记，下次首访重试
    }
}
