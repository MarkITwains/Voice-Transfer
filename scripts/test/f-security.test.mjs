/**
 * F. 安全强化用例组（R6-R9：安全响应头 / 会话吊销即时性 / 账号锁定与自动解锁 / CSRF Origin 校验）
 *
 * 前置：dev server 运行中、.env.local 含 QA_TEST_MODE=1。
 * 约束：
 *   - 锁定测试用独立账号 qa_sec_lock，每次失败尝试用独立 IP（避免误触 IP 限速 5/15min）
 *   - CSRF 用例利用"无 Origin 且无 Referer → 放行"规则：Node fetch 默认不带 Origin 即回归兼容路径
 *   - 测试用户（qa_sec_*）自注入自清理；不触碰 qaadmin 与 iso 账号
 */
import assert from "node:assert/strict";
import {
    httpGet, httpPost, dbQuery, closePool,
    testCase, summary, fetchCaptcha,
    setAuthCookie, clearAuthCookie, extractSessionCookie,
    setForwardedIp,
} from "./helpers.mjs";

const RUN_IP = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
setForwardedIp(RUN_IP);
console.log(`      本轮模拟客户端 IP: ${RUN_IP}`);

const BASE = "http://127.0.0.1:7200";
const stamp = Date.now().toString(36);
const PASS = "Passw0rd2026";

function freshIp() {
    return `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}

/** 带验证码注册（独立 IP，规避注册限速互扰）；返回 ma_session cookie 值 */
async function registerNew(username) {
    const cap = await fetchCaptcha();
    const res = await httpPost("/api/auth/register", {
        username, password: PASS, captchaId: cap.body.captchaId, captchaCode: cap.body.debugCode,
    }, { headers: { "x-forwarded-for": freshIp() } });
    assert.equal(res.status, 200, `注册 ${username} 失败：${res.text.slice(0, 150)}`);
    return extractSessionCookie(res.setCookies);
}

/** 一次"密码错误"登录尝试（独立 IP 规避 IP 限速；仅当响应要求验证码时才带码重试一次） */
async function failedPasswordAttempt(username, ip) {
    let res = await httpPost("/api/auth/login", { username, password: "WrongPass999" }, {
        headers: { "x-forwarded-for": ip },
    });
    // 仅"验证码错误"文案时重试（密码错误文案不重试，避免一次尝试双计数）
    if (res.status === 401 && String(res.body?.error || "").includes("验证码")) {
        const cap = await fetchCaptcha();
        res = await httpPost("/api/auth/login", {
            username, password: "WrongPass999", captchaId: cap.body.captchaId, captchaCode: cap.body.debugCode,
        }, { headers: { "x-forwarded-for": ip } });
    }
    return res;
}

try {
    // ---------- F1 安全响应头三件套（R8） ----------
    await testCase("F1 安全响应头：X-Frame-Options/X-Content-Type-Options/Referrer-Policy 全站生效", async () => {
        for (const path of ["/login", "/api/health"]) {
            const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
            assert.equal(res.headers.get("x-frame-options"), "DENY", `${path} X-Frame-Options 应为 DENY`);
            assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${path} X-Content-Type-Options 应为 nosniff`);
            assert.equal(
                res.headers.get("referrer-policy"), "strict-origin-when-cross-origin",
                `${path} Referrer-Policy 应为 strict-origin-when-cross-origin`
            );
        }
    });

    // ---------- F2 登出吊销即时性（R6/US-5） ----------
    await testCase("F2 登出后拷贝的旧 Cookie 立即 401（服务端吊销，无延迟窗口）", async () => {
        clearAuthCookie();
        const cookie = await registerNew(`qa_sec_rev_${stamp}`);
        assert.ok(cookie, "注册应下发会话 Cookie");
        setAuthCookie(cookie);
        const before = await httpGet("/api/auth/me");
        assert.equal(before.status, 200, "登出前旧 Cookie 应有效");
        // 用该 Cookie 登出（服务端删 sessions 行）
        const out = await httpPost("/api/auth/logout", {});
        assert.equal(out.status, 200, "登出应 200");
        // 模拟"曾拷贝 Cookie 的攻击者"：登出后再用同一 Cookie 访问
        setAuthCookie(cookie);
        const after = await httpGet("/api/auth/me");
        assert.equal(after.status, 401, `登出后旧 Cookie 应 401（吊销即时），实际 ${after.status}`);
        const meetings = await httpGet("/api/meetings");
        assert.equal(meetings.status, 401, "登出后旧 Cookie 访问业务 API 也应 401");
        clearAuthCookie();
    });

    // ---------- F3 改密吊销即时性（R6/US-6） ----------
    await testCase("F3 改密后所有旧 Cookie 立即 401，改密方新 Cookie 保持在线", async () => {
        clearAuthCookie();
        const u = `qa_sec_pwd_${stamp}`;
        const cookie1 = await registerNew(u);
        setAuthCookie(cookie1);
        assert.equal((await httpGet("/api/auth/me")).status, 200, "改密前 Cookie 应有效");
        // 改密：token_version+1 + 删该用户全部 sessions（双保险）
        const change = await httpPost("/api/auth/password", { oldPassword: PASS, newPassword: "NewPass456" });
        assert.equal(change.status, 200, `改密失败：${change.text.slice(0, 150)}`);
        const cookie2 = extractSessionCookie(change.setCookies);
        assert.ok(cookie2, "改密后应重签新 Cookie");
        // 旧 Cookie 立即失效
        setAuthCookie(cookie1);
        assert.equal((await httpGet("/api/auth/me")).status, 401, "改密后旧 Cookie 应 401");
        // 改密方新 Cookie 在线
        setAuthCookie(cookie2);
        assert.equal((await httpGet("/api/auth/me")).status, 200, "改密方新 Cookie 应保持在线");
        clearAuthCookie();
    });

    // ---------- F4 账号锁定：锁定后正确密码也 429（R7/US-7） ----------
    const lockUser = `qa_sec_lock_${stamp}`;
    await testCase("F4a 连续 5 次密码错误触发账号锁定（自适应验证码逐次出现）", async () => {
        clearAuthCookie();
        await registerNew(lockUser); // 建号（注册即登录，不污染失败计数）
        clearAuthCookie();
        for (let i = 1; i <= 5; i++) {
            const res = await failedPasswordAttempt(lockUser, freshIp()); // 每次独立 IP
            assert.equal(res.status, 401, `第 ${i} 次错密码应 401，实际 ${res.status}：${res.text.slice(0, 100)}`);
            assert.ok(!res.body?.lockedSeconds, "未上锁前不应返回 lockedSeconds");
        }
        const rows = await dbQuery("SELECT failed_login_count, locked_until FROM users WHERE username = ?", [lockUser]);
        assert.equal(Number(rows[0].failed_login_count), 0, "上锁时计数应归零");
        assert.ok(rows[0].locked_until, "上锁后 locked_until 应非空");
    });

    await testCase("F4b 锁定期内正确密码也 429，且响应带 lockedSeconds", async () => {
        const res = await httpPost("/api/auth/login", { username: lockUser, password: PASS }, {
            headers: { "x-forwarded-for": freshIp() },
        });
        assert.equal(res.status, 429, `锁定期内正确密码应 429，实际 ${res.status}：${res.text.slice(0, 120)}`);
        assert.ok(Number(res.body?.lockedSeconds) > 0, `应返回 lockedSeconds，实际 ${JSON.stringify(res.body)}`);
        assert.ok(String(res.body?.error).includes("锁定"), "错误文案应提示账号锁定");
    });

    // ---------- F5 自动解锁（US-8：无需人工，等待期满即可重登） ----------
    await testCase("F5 锁定期满自动解锁：DB 置 locked_until 为过去时间后正确密码登录成功", async () => {
        await dbQuery(
            `UPDATE users SET locked_until = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE) WHERE username = ?`,
            [lockUser]
        );
        const res = await httpPost("/api/auth/login", { username: lockUser, password: PASS }, {
            headers: { "x-forwarded-for": freshIp() },
        });
        assert.equal(res.status, 200, `解锁后正确密码应 200，实际 ${res.status}：${res.text.slice(0, 150)}`);
        const rows = await dbQuery("SELECT failed_login_count, locked_until FROM users WHERE username = ?", [lockUser]);
        assert.equal(Number(rows[0].failed_login_count), 0, "成功登录应清零计数");
        assert.equal(rows[0].locked_until, null, "成功登录应清除锁定时间");
        clearAuthCookie();
    });

    // ---------- F6-F10 CSRF Origin 校验（R9） ----------
    await testCase("F6 CSRF：异源 Origin 的写请求 → 403 跨站请求已拦截", async () => {
        const res = await httpPost("/api/auth/login", { username: "x", password: "y" }, {
            headers: { origin: "https://evil.example.com" },
        });
        assert.equal(res.status, 403, `异源写请求应 403，实际 ${res.status}`);
        assert.equal(res.body?.error, "跨站请求已拦截", `403 文案应为固定值，实际：${res.body?.error}`);
    });

    await testCase("F7 CSRF：无 Origin 且无 Referer → 放行（curl/Node fetch 兼容路径）", async () => {
        // 裸 POST（helper 不带 Origin/Referer）：应进入正常处理（登出无 Cookie 也 200），而非 403
        const res = await httpPost("/api/auth/logout", {});
        assert.equal(res.status, 200, `无 Origin/Referer 的写请求应放行，实际 ${res.status}：${res.text.slice(0, 100)}`);
    });

    await testCase("F8 CSRF：GET 请求不校验来源（异源 Origin 的 GET 正常 200）", async () => {
        const res = await httpGet("/api/auth/captcha", { headers: { origin: "https://evil.example.com" } });
        assert.equal(res.status, 200, `GET 不应被 CSRF 拦截，实际 ${res.status}`);
    });

    await testCase("F9 CSRF：无 Origin 有异源 Referer → 403", async () => {
        const res = await httpPost("/api/auth/logout", {}, {
            headers: { referer: "https://evil.example.com/attack" },
        });
        assert.equal(res.status, 403, `异源 Referer 写请求应 403，实际 ${res.status}`);
        assert.equal(res.body?.error, "跨站请求已拦截", "403 文案应为固定值");
    });

    await testCase("F10 CSRF：同源 Origin 的写请求正常放行", async () => {
        const res = await httpPost("/api/auth/login", { username: `qa_csrf_${stamp}`, password: "Whatever123" }, {
            headers: { origin: "http://127.0.0.1:7200" },
        });
        // 同源放行 → 进入业务处理（用户不存在 → 401 模糊文案），而非 403
        assert.equal(res.status, 401, `同源写请求应放行进入业务处理（401），实际 ${res.status}`);
        assert.equal(res.body?.error, "用户名或密码错误", "应返回业务错误而非 CSRF 拦截");
    });

} finally {
    clearAuthCookie();
    // 自注入自清理：sessions/user_settings 先删（FK），再删 qa_sec_* 用户
    try {
        await dbQuery(
            `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'qa_sec_%')`
        );
        await dbQuery(
            `DELETE FROM user_settings WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'qa_sec_%')`
        );
        await dbQuery(`DELETE FROM users WHERE username LIKE 'qa_sec_%'`);
        console.log(`清理 qa_sec_* 测试用户完成`);
    } catch (e) {
        console.log(`清理 qa_sec_* 失败，请人工检查: ${e.message}`);
    }
    await closePool();
}

const ok = summary();
process.exit(ok ? 0 : 1);
