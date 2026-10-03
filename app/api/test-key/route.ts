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
                { success: false, error: "请先输入 API 密钥" },
                { status: 400 }
            );
        }

        const client = new OpenAI({
            apiKey: apiKey.trim(),
            baseURL: (baseURL && baseURL.trim()) || "https://api.openai.com/v1",
            timeout: 15000,
        });

        const list = await client.models.list();
        return NextResponse.json({
            success: true,
            message: `连接成功！已检索到 ${list.data?.length || 0} 个模型`,
        });
    } catch (err: unknown) {
        const e = err as { message?: string };
        return NextResponse.json(
            { success: false, error: `连接失败: ${e.message || "请求异常"}` },
            { status: 400 }
        );
    }
}
