import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/auth";
import { listUsers } from "@/app/lib/userRepo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/users —— 管理员只读用户列表（R10/Q3：本期无任何操作能力） */
export async function GET(req: NextRequest) {
    try {
        const admin = await requireAdmin(req);
        if (!admin) {
            return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
        }

        const users = await listUsers();
        return NextResponse.json({
            success: true,
            users: users.map((u) => ({
                id: u.id,
                username: u.username,
                role: u.role,
                createdAt: u.createdAt,
            })),
        });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "未知错误";
        console.error("[admin/users] 异常:", msg);
        return NextResponse.json({ error: "查询用户列表失败: " + msg }, { status: 500 });
    }
}
