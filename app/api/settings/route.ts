import { NextRequest, NextResponse } from "next/server";
import { getSettings, saveSettings, hasStoredSettings, type SettingsPatch } from "@/app/lib/settingsRepo";
import { maskKey } from "@/app/lib/crypto";
import { requireUser } from "@/app/lib/auth";

export const runtime = "nodejs";
// 读取 DB 的 GET 路由必须禁用静态优化缓存
export const dynamic = "force-dynamic";

/** 脱敏视图（任何响应不得包含明文 apiKey） */
interface SettingsView {
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

/** GET /api/settings —— 脱敏返回（按当前用户） */
export async function GET(req: NextRequest) {
    try {
        const user = await requireUser(req);
        if (!user) {
            return NextResponse.json({ error: "未登录或会话已过期，请先登录" }, { status: 401 });
        }
        const s = await getSettings(user.id);
        const initialized = await hasStoredSettings(user.id);
        const view: SettingsView = {
            llmBaseUrl: s.llmBaseUrl,
            llmModel: s.llmModel,
            llmHasApiKey: Boolean(s.llmApiKey),
            llmApiKeyMasked: maskKey(s.llmApiKey),
            asrBaseUrl: s.asrBaseUrl,
            asrModel: s.asrModel,
            asrHasApiKey: Boolean(s.asrApiKey),
            asrApiKeyMasked: maskKey(s.asrApiKey),
            initialized,
        };
        return NextResponse.json({ success: true, settings: view });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "未知错误";
        console.error("[settings] GET 失败:", msg);
        return NextResponse.json({ error: "读取接口设置失败: " + msg }, { status: 500 });
    }
}

/**
 * PUT /api/settings —— 保存
 * 规则：xxxApiKey 为空串/缺省 → 保留库中旧密钥；仅 clearXxxApiKey=true 才清除
 */
export async function PUT(req: NextRequest) {
    try {
        const user = await requireUser(req);
        if (!user) {
            return NextResponse.json({ error: "未登录或会话已过期，请先登录" }, { status: 401 });
        }

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

        const str = (v: unknown): string | undefined =>
            typeof v === "string" ? v : undefined;

        const patch: SettingsPatch = {
            llmBaseUrl: str(body.llmBaseUrl),
            llmModel: str(body.llmModel),
            llmApiKey: str(body.llmApiKey),
            clearLlmApiKey: body.clearLlmApiKey === true,
            asrBaseUrl: str(body.asrBaseUrl),
            asrModel: str(body.asrModel),
            asrApiKey: str(body.asrApiKey),
            clearAsrApiKey: body.clearAsrApiKey === true,
        };

        // 过滤掉未提供的字段（undefined 不会被 saveSettings 采纳，但保持补丁语义清晰）
        const hasAny = Object.values(patch).some((v) => v !== undefined);
        if (!hasAny) {
            return NextResponse.json({ error: "请求体中未包含任何可保存的设置项" }, { status: 400 });
        }

        await saveSettings(user.id, patch);

        // 保存成功后返回脱敏回显，便于前端确认
        const s = await getSettings(user.id);
        const view: SettingsView = {
            llmBaseUrl: s.llmBaseUrl,
            llmModel: s.llmModel,
            llmHasApiKey: Boolean(s.llmApiKey),
            llmApiKeyMasked: maskKey(s.llmApiKey),
            asrBaseUrl: s.asrBaseUrl,
            asrModel: s.asrModel,
            asrHasApiKey: Boolean(s.asrApiKey),
            asrApiKeyMasked: maskKey(s.asrApiKey),
            initialized: true,
        };
        return NextResponse.json({ success: true, settings: view });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "未知错误";
        console.error("[settings] PUT 失败:", msg);
        return NextResponse.json({ error: "保存接口设置失败: " + msg }, { status: 500 });
    }
}
