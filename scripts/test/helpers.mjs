/**
 * QA 集成测试公共工具（Node 内置模块，无第三方测试框架）
 *
 * 运行方式（托管 node）：
 *   C:\Users\wjy13\.workbuddy\binaries\node\versions\22.22.2-3\node.exe scripts/test/<file>.mjs
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import nodeAssert from "node:assert/strict";

export const BASE = process.env.QA_BASE_URL || "http://127.0.0.1:7200";
export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");

/** 从 .env.local 读取 DATABASE_URL（测试自用，不改业务代码） */
function readDatabaseUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    const envFile = path.join(PROJECT_ROOT, ".env.local");
    if (fs.existsSync(envFile)) {
        const m = fs.readFileSync(envFile, "utf-8").match(/^DATABASE_URL=(.+)$/m);
        if (m) return m[1].trim();
    }
    throw new Error("未找到 DATABASE_URL（.env.local）");
}

let _pool = undefined;
export async function getPool() {
    if (_pool) return _pool;
    const mysql = await import("mysql2/promise");
    const url = new URL(readDatabaseUrl());
    _pool = mysql.createPool({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.replace(/^\//, "")),
        connectionLimit: 2,
        charset: "utf8mb4",
        timezone: "Z",
    });
    return _pool;
}

/** 执行一条 SQL，返回 rows（SELECT 返回行数组；写操作返回 [ResultSetHeader]） */
export async function dbQuery(sql, params = []) {
    const pool = await getPool();
    const [rows] = await pool.query(sql, params);
    return Array.isArray(rows) ? rows : [rows];
}

export async function closePool() {
    if (_pool) {
        await _pool.end();
        _pool = undefined;
    }
}

// ---------------- HTTP ----------------

// 当前套件的登录态 Cookie（ma_session=...；由 setAuthCookie 设置，request 自动携带）
let authCookie = "";

// 当前套件模拟的客户端 IP（限速键按 IP 区分；每轮测试用随机 IP 获得独立配额）
let fwdIp = "";

/** 设置套件级 X-Forwarded-For（模拟独立客户端，避免跨轮限速配额互扰） */
export function setForwardedIp(ip) {
    fwdIp = ip || "";
}

/** 设置本套件后续请求自动携带的会话 Cookie（传 ma_session 的值或完整 cookie 串均可） */
export function setAuthCookie(cookie) {
    authCookie = cookie || "";
    if (authCookie && !authCookie.includes("=")) authCookie = `ma_session=${authCookie}`;
}

export function clearAuthCookie() {
    authCookie = "";
}

/** 从 Set-Cookie 数组提取 ma_session 值 */
export function extractSessionCookie(setCookies) {
    for (const c of setCookies || []) {
        const m = c.match(/^ma_session=([^;]*)/);
        if (m) return m[1];
    }
    return null;
}

async function request(method, urlPath, { body, headers } = {}) {
    const res = await fetch(`${BASE}${urlPath}`, {
        method,
        headers: {
            "content-type": "application/json",
            ...(fwdIp ? { "x-forwarded-for": fwdIp } : {}),
            ...(authCookie ? { cookie: authCookie } : {}),
            ...(headers || {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        /* 非 JSON 响应保留原文 */
    }
    return { status: res.status, ok: res.ok, body: json, text, setCookies: res.headers.getSetCookie?.() ?? [] };
}

export const httpGet = (p, opts) => request("GET", p, opts);
export const httpPut = (p, body, opts) => request("PUT", p, { body, ...opts });
export const httpPost = (p, body, opts) => request("POST", p, { body, ...opts });
export const httpPatch = (p, body, opts) => request("PATCH", p, { body, ...opts });
export const httpDelete = (p, opts) => request("DELETE", p, opts);

// ---------------- 断言与报告 ----------------

const results = [];

export function record(name, pass, detail = "") {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

export function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

export function summary() {
    const failed = results.filter((r) => !r.pass);
    console.log("\n========== 测试小结 ==========");
    console.log(`总计: ${results.length}  通过: ${results.length - failed.length}  失败: ${failed.length}`);
    if (failed.length) {
        console.log("失败用例:");
        for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    }
    return failed.length === 0;
}

/** 用例包装：捕获异常 → 记录 PASS/FAIL，保证清理逻辑总能执行 */
export async function testCase(name, fn) {
    try {
        await fn();
        record(name, true);
    } catch (e) {
        record(name, false, e instanceof Error ? e.message : String(e));
    }
}

// ---------------- 本地 mock LLM 服务（OpenAI 兼容） ----------------

/**
 * 起一个仅本机回环的 mock OpenAI 服务，用于驱动 /api/summarize 完整走通
 * 「解析配置 → 调 LLM → saveMeeting 落库」链路。
 */
export function startMockLlm(port = 7300) {
    const fixedResult = {
        title: "QA集成测试会议",
        summary: "QA自动测试生成的结论1；QA自动测试生成的结论2",
        keyDecisions: ["QA决策：完成集成测试"],
        topics: [{ title: "测试议题", points: ["测试要点A", "测试要点B"] }],
        todos: [{ content: "QA待办：清理测试数据", assignee: "严过关", deadline: "今天" }],
        risks: ["QA风险：无"],
    };
    const server = net.createServer((socket) => {
        let buf = "";
        socket.on("data", (d) => {
            buf += d.toString("utf-8");
            if (!buf.includes("\r\n\r\n")) return;
            const payload = JSON.stringify({
                id: "chatcmpl-qa-mock",
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "qa-mock-model",
                choices: [
                    { index: 0, message: { role: "assistant", content: JSON.stringify(fixedResult) }, finish_reason: "stop" },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
            socket.end(
                `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`
            );
            buf = "";
        });
        socket.on("error", () => {});
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// ---------------- 验证码与认证（v3：注册必带码 / 登录自适应带码） ----------------

/**
 * GET /api/auth/captcha 取一张验证码（测试模式响应含 debugCode 明文）。
 * @returns {{ status, body: { captchaId, svg, expiresIn, debugCode? } }}
 */
export async function fetchCaptcha() {
    const res = await request("GET", "/api/auth/captcha");
    nodeAssert.equal(res.status, 200, `GET /api/auth/captcha 期望 200，实际 ${res.status}：${res.text.slice(0, 120)}`);
    nodeAssert.ok(res.body?.captchaId && res.body?.svg, "验证码响应缺 captchaId/svg");
    return res;
}

/**
 * 组装注册请求体：自动附带验证码（测试模式取 debugCode）。
 */
async function registerBody(username, password) {
    const body = { username, password };
    try {
        const cap = await fetchCaptcha();
        body.captchaId = cap.body.captchaId;
        body.captchaCode = cap.body.debugCode || "";
    } catch {
        // 验证码接口异常时保留裸请求体（由用例自身断言失败原因）
    }
    return body;
}

/**
 * 登录并自动处理自适应验证码：先裸登录；响应 401+requireCaptcha 时取码重试一次。
 */
async function loginWithCaptcha(username, password) {
    let login = await request("POST", "/api/auth/login", { body: { username, password } });
    if (login.status === 401 && login.body?.requireCaptcha === true) {
        const cap = await fetchCaptcha();
        login = await request("POST", "/api/auth/login", {
            body: { username, password, captchaId: cap.body.captchaId, captchaCode: cap.body.debugCode || "" },
        });
    }
    return login;
}

/** 注册/登录并设置本套件登录态（v3：注册自动带验证码；返回 { status, body, cookie }） */
export async function registerOrLogin(username, password) {
    const reg = await request("POST", "/api/auth/register", {
        body: await registerBody(username, password),
    });
    if (reg.status === 200) {
        setAuthCookie(extractSessionCookie(reg.setCookies));
        return reg;
    }
    // 已存在（或被限速）→ 尝试登录（自适应带码）
    const login = await loginWithCaptcha(username, password);
    if (login.status === 200) {
        setAuthCookie(extractSessionCookie(login.setCookies));
        return login;
    }
    return login.status === 401 ? reg : login; // 都失败时优先返回注册结果（错误信息更具体）
}

/** 仅登录；返回 { status, body, cookie }，成功时已设置套件登录态（自适应验证码自动处理） */
export async function loginAs(username, password) {
    const login = await loginWithCaptcha(username, password);
    if (login.status === 200) {
        setAuthCookie(extractSessionCookie(login.setCookies));
    }
    return login;
}

/** 通过 mock LLM + 请求头覆盖，调用 /api/summarize 新建一场会议 */
export async function createMeetingViaSummarize(mockPort, rawTextExtra = "") {
    const res = await httpPost("/api/summarize", {
        rawText: `QA集成测试速记内容，用于验证新建链路。${rawTextExtra}`,
        style: "standard",
    }, {
        headers: {
            "x-api-key": "sk-qa-mock-key",
            "x-base-url": `http://127.0.0.1:${mockPort}/v1`,
            "x-model": "qa-mock-model",
        },
    });
    assert(res.status === 200, `POST /api/summarize 期望 200，实际 ${res.status}：${res.text.slice(0, 200)}`);
    assert(res.body?.success === true && res.body?.roomId, "summarize 响应缺少 success/roomId");
    return res.body.roomId;
}

/** 通过 API 删除会议（清理用），返回是否删除成功 */
export async function safeDeleteMeeting(roomId) {
    const res = await httpDelete(`/api/meetings?id=${encodeURIComponent(roomId)}`);
    return res.status === 200;
}
