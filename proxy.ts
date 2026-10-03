/**
 * 全局鉴权闸 + CSRF 闸门（Next.js 16 Proxy 约定：根目录 proxy.ts、导出 proxy 函数、默认 Node runtime）
 *
 * 定位：体验层闸门（访客页面 → 跳登录页；访客 API → 401）+ CSRF 来源校验，不是安全边界。
 * 官方文档明示 Proxy 与渲染代码分离调用、不应依赖共享模块/全局状态——
 * 因此这里只做 verifyToken 的无状态纯密码学校验（签名+过期+jti 存在，不查 DB）；
 * 每个受保护 Route Handler / Server Component 内部仍须自行 requireUser()（纵深防御，
 * users JOIN sessions 核对会话吊销）。
 *
 * CSRF（R9，共享知识 8-4）：写方法 POST/PUT/PATCH/DELETE 校验 Origin/Referer——
 * - 无 Origin 且无 Referer → 放行（curl/Node fetch/服务端调用天然兼容，回归全靠这条）
 * - 有 Origin 且 ≠ 站点源（含 TRUSTED_ORIGINS 白名单）→ 403 { error: "跨站请求已拦截" }
 * - 无 Origin 有 Referer → Referer 源必须同源，否则 403
 * - GET/HEAD/OPTIONS 不校验
 *
 * matcher 豁免：_next 静态资源、favicon、/api/health。/api/auth/* 不再整体豁免
 * （CSRF 须覆盖认证写接口），由函数内按路径放行鉴权闸。
 */
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifyToken } from "@/app/lib/authToken";

export const config = {
    matcher: [
        // 排除：静态资源、健康检查；其余全部过闸（含 /login /register /api/auth/* /api/models 等）
        "/((?!_next/static|_next/image|_next/data|favicon\\.ico|api/health|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|webmanifest|txt|xml)$).*)",
    ],
};

const PUBLIC_PAGES = new Set(["/login", "/register"]);
/** 无需登录即可访问的页面（帮助文档）；与 PUBLIC_PAGES 的区别：已登录访问时不做重定向 */
const ALWAYS_PUBLIC_PAGES = new Set(["/help"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CSRF_BLOCKED = { error: "跨站请求已拦截" };

/** 预留白名单：逗号分隔的额外可信源（如未来加域名），缺省为空不生效 */
function trustedOrigins(): string[] {
    return (process.env.TRUSTED_ORIGINS || "")
        .split(",")
        .map((s) => s.trim().replace(/\/$/, ""))
        .filter(Boolean);
}

/** 提取 Origin/Referer 头的"源"（scheme://host[:port]）；解析失败返回 null */
function originOf(headerValue: string): string | null {
    try {
        const u = new URL(headerValue);
        return `${u.protocol}//${u.host}`;
    } catch {
        return null;
    }
}

/**
 * 站点源集合：nextUrl.origin + Host 头推导源（dev 代理/端口转发场景 nextUrl.origin
 * 可能与请求 Host 不一致，两者都算同源）+ TRUSTED_ORIGINS 白名单。
 */
function siteOriginsOf(request: NextRequest): Set<string> {
    const origins = new Set<string>();
    const add = (o: string | null | undefined) => {
        if (o) origins.add(o.replace(/\/$/, ""));
    };
    add(request.nextUrl.origin);
    const host = request.headers.get("host");
    if (host) {
        const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
        const proto = forwardedProto || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
        add(`${proto}://${host}`);
    }
    for (const o of trustedOrigins()) add(o);
    return origins;
}

/**
 * CSRF 校验：写方法校验请求来源与站点同源。
 * @returns NextResponse(403) —— 拦截；null —— 放行
 */
function csrfCheck(request: NextRequest): NextResponse | null {
    if (!WRITE_METHODS.has(request.method.toUpperCase())) return null;

    const siteOrigins = siteOriginsOf(request);
    const isAllowed = (source: string | null): boolean =>
        source !== null && siteOrigins.has(source);

    const origin = request.headers.get("origin");
    if (origin) {
        return isAllowed(origin.trim()) ? null : NextResponse.json(CSRF_BLOCKED, { status: 403 });
    }
    const referer = request.headers.get("referer");
    if (referer) {
        return isAllowed(originOf(referer))
            ? null
            : NextResponse.json(CSRF_BLOCKED, { status: 403 });
    }
    // 无 Origin 且无 Referer → 放行（curl / Node fetch / 服务端调用）
    return null;
}

export async function proxy(request: NextRequest) {
    // CSRF 闸门：全站写方法（含 /api/auth/*）先于鉴权闸
    const blocked = csrfCheck(request);
    if (blocked) return blocked;

    const pathname = request.nextUrl.pathname;

    // 认证 API（登录/注册/登出/me/验证码）不做过闸鉴权，只过 CSRF
    if (pathname.startsWith("/api/auth/")) {
        return NextResponse.next();
    }

    // 帮助文档：无论是否登录都放行（已登录时也不重定向回工作台）
    if (ALWAYS_PUBLIC_PAGES.has(pathname)) {
        return NextResponse.next();
    }

    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const payload = await verifyToken(token); // 仅签名 + exp + jti 存在，无 DB 查询
    const ok = payload !== null;

    // API：未登录一律 401（豁免路径已在 matcher 排除）
    if (pathname.startsWith("/api/")) {
        if (!ok) {
            return NextResponse.json({ error: "未登录或会话已过期，请先登录" }, { status: 401 });
        }
        return NextResponse.next();
    }

    // 页面：已登录访问 /login、/register → 回工作台
    if (PUBLIC_PAGES.has(pathname)) {
        if (ok) {
            return NextResponse.redirect(new URL("/", request.url));
        }
        return NextResponse.next();
    }

    // 页面：未登录 → 跳登录页
    if (!ok) {
        return NextResponse.redirect(new URL("/login", request.url));
    }
    return NextResponse.next();
}
