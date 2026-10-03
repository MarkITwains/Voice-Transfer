/**
 * QA 验收专项脚本（严过关，阶段 12）——独立于 E/F 组的真机链路 + DB 直查证据。
 *
 * 覆盖任务书 #2 真机认证链路、#3 错码不计数(DB直查)、#5 吊销即时性(DB直删模拟)、
 * #8 安全头补充路径。测试用户 qa_yan_* 自注入自清理；随机 IP 规避限速互扰。
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

const stamp = Date.now().toString(36);
const PASS = "Passw0rd2026";

const freshIp = () =>
    `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

/** 带验证码注册（独立 IP）；返回 ma_session cookie 值 */
async function registerNew(username) {
    const cap = await fetchCaptcha();
    const res = await httpPost("/api/auth/register", {
        username, password: PASS, captchaId: cap.body.captchaId, captchaCode: cap.body.debugCode,
    }, { headers: { "x-forwarded-for": freshIp() } });
    assert.equal(res.status, 200, `注册 ${username} 失败：${res.text.slice(0, 150)}`);
    return extractSessionCookie(res.setCookies);
}

const users = [];

try {
    // ========== T1-T4 真机认证链路（任务书 #2）：register→me→logout→旧 Cookie 401 ==========
    const u1 = `qa_yan_chain_${stamp}`;
    users.push(u1);
    let chainCookie = "";

    await testCase("T1 注册（带码）→ 200 且自动登录下发会话 Cookie", async () => {
        chainCookie = await registerNew(u1);
        assert.ok(chainCookie && chainCookie.length > 20, "应下发非空 ma_session Cookie");
        assert.ok(chainCookie.startsWith("v2."), `token 应为 v2 前缀，实际前缀：${chainCookie.split(".")[0]}`);
    });

    await testCase("T2 自动登录态：GET /api/auth/me → 200 身份正确", async () => {
        setAuthCookie(chainCookie);
        const me = await httpGet("/api/auth/me");
        assert.equal(me.status, 200, `me 应 200，实际 ${me.status}：${me.text.slice(0, 100)}`);
        assert.equal(me.body?.user?.username, u1, "me 返回的用户名应正确");
    });

    await testCase("T3 登出 → 拷贝旧 Cookie 访问业务 API 立即 401（吊销即时）", async () => {
        const out = await httpPost("/api/auth/logout", {});
        assert.equal(out.status, 200, "登出应 200");
        setAuthCookie(chainCookie); // 模拟曾拷贝 Cookie 的攻击者
        const meetings = await httpGet("/api/meetings");
        assert.equal(meetings.status, 401, `登出后旧 Cookie 业务 API 应 401，实际 ${meetings.status}`);
        const me = await httpGet("/api/auth/me");
        assert.equal(me.status, 401, `登出后旧 Cookie me 应 401，实际 ${me.status}`);
    });

    await testCase("T4 DB 直查：登出后该 jti 的 sessions 行已删除（服务端吊销落库证据）", async () => {
        const rows = await dbQuery(
            "SELECT s.jti FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = ?",
            [u1]
        );
        assert.equal(rows.length, 0, `登出后该用户 sessions 行应为 0，实际 ${rows.length}`);
    });

    // ========== T5-T8 改密链路 + 错码不计数 DB 直查（任务书 #3） ==========
    const u2 = `qa_yan_pwd_${stamp}`;
    users.push(u2);

    await testCase("T5 改密链路：改密后旧 Cookie 401、新 Cookie 在线（真机复证）", async () => {
        clearAuthCookie();
        const c1 = await registerNew(u2);
        setAuthCookie(c1);
        const change = await httpPost("/api/auth/password", { oldPassword: PASS, newPassword: "NewPass456" });
        assert.equal(change.status, 200, `改密应 200：${change.text.slice(0, 120)}`);
        const c2 = extractSessionCookie(change.setCookies);
        assert.ok(c2, "改密应重签新 Cookie");
        setAuthCookie(c1);
        assert.equal((await httpGet("/api/auth/me")).status, 401, "旧 Cookie 应 401");
        setAuthCookie(c2);
        const me = await httpGet("/api/auth/me");
        assert.equal(me.status, 200, `新 Cookie 应 200，实际 ${me.status}：${me.text.slice(0, 100)}`);
    });

    await testCase("T6 错验证码不计数（DB 直查 failed_login_count 逐次不变）", async () => {
        clearAuthCookie();
        // 独立新账号（T5 已改密，复用会因密码不符产生假失败）
        const u2b = `qa_yan_cap_${stamp}`;
        users.push(u2b);
        await registerNew(u2b);
        const U = u2b;
        // 先制造 2 次密码错误（count=2 触发自适应验证码）
        for (let i = 0; i < 2; i++) {
            const r = await httpPost("/api/auth/login", { username: U, password: "WrongPass999" }, {
                headers: { "x-forwarded-for": freshIp() },
            });
            assert.equal(r.status, 401, `第 ${i + 1} 次错密码应 401`);
        }
        const before = await dbQuery(
            "SELECT failed_login_count, locked_until FROM users WHERE username = ?", [U]
        );
        assert.equal(Number(before[0].failed_login_count), 2, "两次错密后计数应为 2");
        // 错验证码 2 次：每次前后直查 DB，计数必须不变
        for (let i = 0; i < 2; i++) {
            const cap = await fetchCaptcha();
            const r = await httpPost("/api/auth/login", {
                username: U, password: PASS, captchaId: cap.body.captchaId, captchaCode: "XXXXX",
            }, { headers: { "x-forwarded-for": freshIp() } });
            assert.equal(r.status, 401, "错验证码应 401");
            const mid = await dbQuery(
                "SELECT failed_login_count FROM users WHERE username = ?", [U]
            );
            assert.equal(Number(mid[0].failed_login_count), 2,
                `错验证码后计数必须仍为 2（第 ${i + 1} 次），实际 ${mid[0].failed_login_count}`);
        }
        // 正确码 + 正确密码 → 成功；成功后计数清零
        const cap = await fetchCaptcha();
        const ok = await httpPost("/api/auth/login", {
            username: U, password: PASS, captchaId: cap.body.captchaId, captchaCode: cap.body.debugCode,
        }, { headers: { "x-forwarded-for": freshIp() } });
        assert.equal(ok.status, 200, `正确码+正确密码应 200：${ok.text.slice(0, 120)}`);
        const after = await dbQuery(
            "SELECT failed_login_count, locked_until FROM users WHERE username = ?", [U]
        );
        assert.equal(Number(after[0].failed_login_count), 0, "成功登录应清零计数");
        assert.equal(after[0].locked_until, null, "成功登录应清除 locked_until");
        clearAuthCookie();
    });

    // ========== T9 合法签名但无 sessions 行 → 401（DB 直删模拟，任务书 #5） ==========
    await testCase("T9 DB 直删 sessions 行（模拟吊销）→ 合法签名 Cookie 立即 401", async () => {
        clearAuthCookie();
        const u3 = `qa_yan_revoke_${stamp}`;
        users.push(u3);
        const c3 = await registerNew(u3);
        setAuthCookie(c3);
        assert.equal((await httpGet("/api/auth/me")).status, 200, "删除行前应在线");
        await dbQuery(
            "DELETE s FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = ?", [u3]
        );
        const me = await httpGet("/api/auth/me");
        assert.equal(me.status, 401, `DB 直删行后应 401，实际 ${me.status}`);
        const meetings = await httpGet("/api/meetings");
        assert.equal(meetings.status, 401, "DB 直删行后业务 API 也应 401");
        clearAuthCookie();
    });

    // ========== T10 安全头补充路径（任务书 #8） ==========
    await testCase("T10 安全头三件套：/register、/api/meetings(401 响应)、/api/auth/captcha 齐全", async () => {
        for (const p of ["/register", "/api/meetings", "/api/auth/captcha"]) {
            const res = await fetch(`http://127.0.0.1:7200${p}`, { redirect: "manual" });
            assert.equal(res.headers.get("x-frame-options"), "DENY", `${p} X-Frame-Options 应 DENY`);
            assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${p} X-Content-Type-Options 应 nosniff`);
            assert.equal(
                res.headers.get("referrer-policy"), "strict-origin-when-cross-origin",
                `${p} Referrer-Policy 应 strict-origin-when-cross-origin`
            );
        }
    });

    // ========== T11 同源 Referer 放行（CSRF 补充边界，任务书 #7） ==========
    await testCase("T11 无 Origin + 同源 Referer 的写请求 → 放行进入业务（401 而非 403）", async () => {
        const res = await httpPost("/api/auth/login", { username: "x", password: "y" }, {
            headers: { referer: "http://127.0.0.1:7200/login" },
        });
        assert.equal(res.status, 401, `同源 Referer 应放行（401 业务错误），实际 ${res.status}`);
        assert.equal(res.body?.error, "用户名或密码错误", "应返回业务错误而非 CSRF 拦截");
    });

} finally {
    clearAuthCookie();
    try {
        await dbQuery(
            `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'qa_yan_%')`
        );
        await dbQuery(
            `DELETE FROM user_settings WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'qa_yan_%')`
        );
        await dbQuery(`DELETE FROM users WHERE username LIKE 'qa_yan_%'`);
        console.log(`清理 qa_yan_* 测试用户完成`);
    } catch (e) {
        console.log(`清理 qa_yan_* 失败，请人工检查: ${e.message}`);
    }
    await closePool();
}

const ok = summary();
process.exit(ok ? 0 : 1);
