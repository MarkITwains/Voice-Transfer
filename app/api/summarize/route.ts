import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import { saveMeeting } from "@/app/lib/meetingRepo";
import { resolveLlmConfig } from "@/app/lib/serverSettings";
import { requireUser } from "@/app/lib/auth";
import type { MeetingData, MindMapNode, Todo } from "@/app/lib/types";

export const runtime = "nodejs";

interface RawTodo {
    content?: string;
    assignee?: string;
    deadline?: string;
}

interface RawTopic {
    title?: string;
    points?: string[];
    children?: string[];
}

interface RawResult {
    title?: string;
    summary?: string;
    keyDecisions?: string[];
    topics?: RawTopic[];
    todos?: RawTodo[];
    risks?: string[];
}

export async function POST(req: NextRequest) {
    try {
        const user = await requireUser(req);
        if (!user) {
            return NextResponse.json({ error: "未登录或会话已过期，请先登录" }, { status: 401 });
        }

        // 配置优先级：请求头 x-*（兼容期兜底）→ 当前用户 user_settings（BYOK）→ 空
        const { apiKey, baseUrl: rawBaseUrl, model } = await resolveLlmConfig(req, user.id);

        if (!apiKey || !apiKey.trim()) {
            return NextResponse.json(
                {
                    error: "未配置大模型 API 密钥。请点击右上角「API 设置」填写您的 API 地址、密钥及模型",
                },
                { status: 401 }
            );
        }

        if (!model || !model.trim()) {
            return NextResponse.json(
                {
                    error: "未指定大模型名称。请点击右上角「API 设置」输入或拉取模型列表选择模型",
                },
                { status: 400 }
            );
        }

        const baseURL = (rawBaseUrl && rawBaseUrl.trim()) ? rawBaseUrl.trim().replace(/\/+$/, "") : "https://api.openai.com/v1";

        const body = await req.json();
        const { rawText, style = "standard", duration } = body as {
            rawText?: string;
            style?: string;
            duration?: string;
        };

        if (!rawText || rawText.trim().length < 5) {
            return NextResponse.json(
                { error: "会议内容太短，请至少输入 5 个字" },
                { status: 400 }
            );
        }

        let styleContext = "常规工作周会或项目例会：理清各项进展、存在的问题与接下来的计划。";
        if (style === "standup") {
            styleContext = "敏捷晨会/站会：重点整理昨日完成、今日目标、卡点阻塞以及具体由谁支援。";
        } else if (style === "brainstorm") {
            styleContext = "头脑风暴与方案研讨：重点整理大家提出的好点子、方案争议焦点、最终大家认可的尝试方向。";
        } else if (style === "business") {
            styleContext = "商务洽谈与客户沟通：重点整理客户核心诉求、双方各自承诺的事项、价格与合作边界、后续对接人。";
        }

        const prompt = `
你是一位非常干练、懂业务、讲人话的资深团队秘书与项目专家。
请通读以下会议速记/对话内容，像一位专业负责人一样，为团队整理出一份干净、清楚、接地气、方便大家直接执行的会议纪要。

【会议场景侧重】：${styleContext}

请注意：
1. 语言要口语自然、通俗易懂，杜绝空洞官腔与 AI 假大空词汇，说清楚谁做了什么、定下了什么；
2. 待办事项一定要尽可能明确【谁负责】、【具体做什么】、【何时交付】；
3. 输出严格的 JSON 格式：

{
  "title": "通俗明确的会议主题（如：Q4上线冲刺与系统保障周会）",
  "summary": "3-4条最核心的结论（用中文分号；隔开，简明扼要，直奔主题）",
  "keyDecisions": [
    "定下的具体决策1（如：同意在周四前完成新版上线）",
    "定下的具体决策2"
  ],
  "topics": [
    {
      "title": "具体讨论议题（如：前端体验与用户配置上线）",
      "points": [
        "讨论的主要细节或大家达成的意见1",
        "具体细节2"
      ]
    }
  ],
  "todos": [
    {
      "content": "具体要做的事项（要具体可执行）",
      "assignee": "负责人姓名（未提及则留空）",
      "deadline": "截止时间（如：本周五下班前，未提及则留空）"
    }
  ],
  "risks": [
    "需要大家注意的风险点或待确认卡点（没有则留空数组）"
  ]
}

【会议速记文本】：
"""
${rawText}
"""
`;

        const client = new OpenAI({
            apiKey: apiKey.trim(),
            baseURL,
            timeout: 60000,
        });

        const completion = await client.chat.completions.create({
            model: model.trim(),
            messages: [
                {
                    role: "system",
                    content: "你是一位专业高效、说人话的会议纪要助理。请严格输出合法的 JSON 格式。",
                },
                {
                    role: "user",
                    content: prompt,
                },
            ],
            temperature: 0.3,
            response_format: {
                type: "json_object",
            },
        });

        const content = completion.choices[0]?.message?.content || "{}";
        let result: RawResult = {};

        try {
            result = JSON.parse(content);
        } catch {
            const match = content.match(/\{[\s\S]*\}/);
            if (match) {
                result = JSON.parse(match[0]);
            } else {
                throw new Error("模型返回的内容格式不符合预期，请稍后重试");
            }
        }

        const roomId = uuidv4().slice(0, 8);

        const cleanTodos: Todo[] = Array.isArray(result.todos)
            ? result.todos.map((t, idx) => ({
                  id: `todo-${idx + 1}`,
                  content: t.content?.trim() || "未命名任务",
                  assignee: t.assignee?.trim() || undefined,
                  deadline: t.deadline?.trim() || undefined,
                  completed: false,
              }))
            : [];

        const cleanMindmap: MindMapNode[] = Array.isArray(result.topics)
            ? result.topics.map((t) => ({
                  title: t.title?.trim() || "讨论议题",
                  children: Array.isArray(t.points || t.children)
                      ? (t.points || t.children || []).map((c) => String(c).trim()).filter(Boolean)
                      : [],
              }))
            : [];

        const cleanDecisions: string[] = Array.isArray(result.keyDecisions)
            ? result.keyDecisions.map((d) => String(d).trim()).filter(Boolean)
            : [];

        const cleanRisks: string[] = Array.isArray(result.risks)
            ? result.risks.map((r) => String(r).trim()).filter(Boolean)
            : [];

        let typeLabel = "日常例会";
        if (style === "standup") typeLabel = "敏捷站会";
        else if (style === "brainstorm") typeLabel = "头脑风暴";
        else if (style === "business") typeLabel = "商务沟通";

        const meetingData: MeetingData = {
            id: roomId,
            title: result.title?.trim() || "会议纪要",
            style,
            type: typeLabel,
            summary: result.summary?.trim() || "暂无主要结论",
            keyDecisions: cleanDecisions,
            risks: cleanRisks,
            mindmap: cleanMindmap,
            todos: cleanTodos,
            transcript: rawText,
            duration: duration || undefined,
            wordCount: rawText.length,
            createdAt: new Date().toISOString(),
        };

        await saveMeeting(user.id, roomId, meetingData);

        return NextResponse.json({
            success: true,
            roomId,
        });
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "未知错误";
        console.error("生成会议纪要失败:", msg);
        return NextResponse.json(
            { error: `会议纪要整理失败: ${msg}` },
            { status: 500 }
        );
    }
}
