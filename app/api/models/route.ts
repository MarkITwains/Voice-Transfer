import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { requireUser } from "@/app/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
    try {
        // 未登录一律 401（PRD R4：models/test-key 不豁免）
        const user = await requireUser(req);
        if (!user) {
            return NextResponse.json({ success: false, error: "未登录或会话已过期，请先登录" }, { status: 401 });
        }

        const body = await req.json();
        const { baseURL, apiKey } = body as {
            baseURL?: string;
            apiKey?: string;
        };

        if (!apiKey || !apiKey.trim()) {
            return NextResponse.json(
                { success: false, error: "请先输入 API 密钥 (API Key)" },
                { status: 400 }
            );
        }

        const trimmedKey = apiKey.trim();
        let targetUrl = (baseURL && baseURL.trim()) || "https://api.openai.com/v1";

        // 规范化 URL：去除末尾的 /
        targetUrl = targetUrl.replace(/\/+$/, "");

        const client = new OpenAI({
            apiKey: trimmedKey,
            baseURL: targetUrl,
            timeout: 15000,
        });

        try {
            const list = await client.models.list();
            const models = (list.data || [])
                .map((m) => m.id)
                .filter(Boolean)
                .sort();

            return NextResponse.json({
                success: true,
                count: models.length,
                models,
            });
        } catch (err: unknown) {
            const e = err as { status?: number; message?: string };
            if (e.status === 401) {
                return NextResponse.json(
                    { success: false, error: "API 密钥无效 (401 Unauthorized)，请核对密钥" },
                    { status: 401 }
                );
            }
            if (e.status === 404) {
                return NextResponse.json(
                    { success: false, error: `接口地址未找到 (404)，请检查接口地址是否准确（通常应包含协议和路径，如 https://api.xxx.com/v1）` },
                    { status: 404 }
                );
            }
            return NextResponse.json(
                { success: false, error: `获取模型列表失败: ${e.message || "连接异常"}` },
                { status: 400 }
            );
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "请求解析失败";
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
    }
}
