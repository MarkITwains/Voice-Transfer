import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getMeeting } from "@/app/lib/meetingRepo";
import { resolveLlmConfig } from "@/app/lib/serverSettings";
import { requireUser } from "@/app/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
    try {
        const user = await requireUser(req);
        if (!user) {
            return NextResponse.json({ error: "未登录或会话已过期，请先登录" }, { status: 401 });
        }

        // 配置优先级：请求头 x-*（兼容期兜底）→ 当前用户 user_settings（BYOK）→ 空
        const { apiKey, baseUrl: headerBaseUrl, model: headerModel } = await resolveLlmConfig(req, user.id);

        if (!apiKey || !apiKey.trim()) {
            return NextResponse.json(
                {
                    error: "未配置大模型 API 密钥。请点击页面右上角「API 设置」填写您的 API Key",
                },
                { status: 401 }
            );
        }

        const baseURL = (headerBaseUrl && headerBaseUrl.trim())
            ? headerBaseUrl.trim().replace(/\/+$/, "")
            : "https://api.openai.com/v1";

        const body = await req.json();
        const { roomId, messages = [], question, context: directContext } = body as {
            roomId?: string;
            messages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
            question?: string;
            context?: string;
        };

        let meetingContext = directContext || "";
        let meetingTitle = "";

        if (roomId) {
            const meeting = await getMeeting(user.id, roomId);
            if (meeting) {
                meetingTitle = meeting.title;
                meetingContext = `
【会议主题】：${meeting.title}
【会议类型】：${meeting.type || "普通例会"}
【核心决议】：${meeting.summary}
【关键决策】：${meeting.keyDecisions?.join("；") || "无"}
【风险关注】：${meeting.risks?.join("；") || "无"}
【待办清单】：
${meeting.todos?.map(t => `- [${t.completed ? "已完成" : "待办"}] ${t.content}（责任人: ${t.assignee || "未指定"}，截止: ${t.deadline || "未定"}）`).join("\n") || "无"}

【原始速记记录】：
${meeting.transcript || "无完整速记"}
`.trim();
            }
        }

        const systemMessage = `
你是一位高效、亲切、讲人话的会议助理。
你手中掌握本场会议的完整速记、主要结论和待办清单。
请根据会议内容，用平实自然、亲和直接的语气回答同事的问题（如梳理谁负责什么、什么时间交付、争议细节等）。
如果会议记录里没有提到用户问的事情，请坦诚说“会议记录里没有提到这一点”，不要胡编乱造。

【本场会议资料】：
${meetingContext || "无详细记录"}
`;

        const conversationHistory = [...messages];
        if (question && (!messages.length || messages[messages.length - 1].content !== question)) {
            conversationHistory.push({ role: "user", content: question });
        }

        if (conversationHistory.length === 0) {
            return NextResponse.json(
                { error: "请输入您想了解的问题" },
                { status: 400 }
            );
        }

        const client = new OpenAI({
            apiKey: apiKey.trim(),
            baseURL,
            timeout: 45000,
        });

        const completion = await client.chat.completions.create({
            model: (headerModel && headerModel.trim()) || "deepseek-chat",
            messages: [
                { role: "system", content: systemMessage },
                ...conversationHistory.map(m => ({
                    role: m.role as "user" | "assistant",
                    content: m.content,
                })),
            ],
            temperature: 0.3,
        });

        const reply = completion.choices[0]?.message?.content || "抱歉，未能生成回答，请稍后再试";

        return NextResponse.json({
            success: true,
            reply,
            meetingTitle,
        });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "请求失败";
        console.error("Chat API 异常:", msg);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
