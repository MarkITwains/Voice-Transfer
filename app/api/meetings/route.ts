import { NextRequest, NextResponse } from "next/server";
import { listMeetings, deleteMeeting, updateMeeting, getMeeting } from "@/app/lib/meetingRepo";
import { requireUser } from "@/app/lib/auth";

export const runtime = "nodejs";
// 读取 DB 的 GET 路由必须禁用静态优化缓存
export const dynamic = "force-dynamic";

// 获取会议历史列表或单个会议
export async function GET(req: NextRequest) {
    try {
        const user = await requireUser(req);
        if (!user) {
            return NextResponse.json({ error: "未登录或会话已过期，请先登录" }, { status: 401 });
        }

        const { searchParams } = new URL(req.url);
        const id = searchParams.get("id");

        if (id) {
            const meeting = await getMeeting(user.id, id);
            if (!meeting) {
                return NextResponse.json({ error: "会议不存在" }, { status: 404 });
            }
            return NextResponse.json({ success: true, meeting });
        }

        const limit = Number(searchParams.get("limit")) || 30;
        const meetings = await listMeetings(user.id, limit);
        return NextResponse.json({
            success: true,
            meetings: meetings.map(m => ({
                id: m.id,
                title: m.title,
                type: m.type,
                summary: m.summary,
                createdAt: m.createdAt,
                duration: m.duration,
                todoCount: m.todos?.length || 0,
                completedTodoCount: m.todos?.filter(t => t.completed)?.length || 0,
                wordCount: m.wordCount || m.transcript?.length || 0,
            })),
        });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "未知错误";
        return NextResponse.json({ error: "获取会议记录失败: " + msg }, { status: 500 });
    }
}

// 删除指定会议
export async function DELETE(req: NextRequest) {
    try {
        const user = await requireUser(req);
        if (!user) {
            return NextResponse.json({ error: "未登录或会话已过期，请先登录" }, { status: 401 });
        }

        const { searchParams } = new URL(req.url);
        const id = searchParams.get("id");

        if (!id) {
            return NextResponse.json({ error: "缺少会议 ID" }, { status: 400 });
        }

        const success = await deleteMeeting(user.id, id);
        if (!success) {
            return NextResponse.json({ error: "会议不存在或已被删除" }, { status: 404 });
        }

        return NextResponse.json({ success: true, message: "删除成功" });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "未知错误";
        return NextResponse.json({ error: "删除会议失败: " + msg }, { status: 500 });
    }
}

// 更新会议字段
export async function PATCH(req: NextRequest) {
    try {
        const user = await requireUser(req);
        if (!user) {
            return NextResponse.json({ error: "未登录或会话已过期，请先登录" }, { status: 401 });
        }

        const body = await req.json();
        const { id, ...updates } = body;

        if (!id) {
            return NextResponse.json({ error: "缺少会议 ID" }, { status: 400 });
        }

        const success = await updateMeeting(user.id, id as string, updates);
        if (!success) {
            return NextResponse.json({ error: "会议不存在" }, { status: 404 });
        }

        return NextResponse.json({ success: true, message: "更新成功" });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "未知错误";
        return NextResponse.json({ error: "更新会议失败: " + msg }, { status: 500 });
    }
}
