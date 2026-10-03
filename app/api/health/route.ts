import { NextResponse } from "next/server";
import { pingDb } from "@/app/lib/db";

export const runtime = "nodejs";
// 读取 DB 的 GET 路由必须禁用静态优化缓存
export const dynamic = "force-dynamic";

/** GET /api/health —— SELECT 1 探活，报告 DB 状态 */
export async function GET() {
    try {
        const ok = await pingDb();
        return NextResponse.json({
            status: "ok",
            database: "up",
            time: new Date().toISOString(),
        });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "未知错误";
        console.error("[health] 数据库探活失败:", msg);
        return NextResponse.json(
            { status: "error", database: "down", error: msg },
            { status: 500 }
        );
    }
}
