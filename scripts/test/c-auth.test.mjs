/**
 * C. 认证、多用户隔离、限速与账号能力
 *
 * 前置：dev server 运行中、MySQL 运行中；meeting_ai 库存在（bootstrap 首请求自动建 users 等表）。
 * 约束：
 *   - 首个用户判定为条件式（qaadmin 已存在则校验其 admin 身份与 claim 结果；否则现场注册首个用户）
 *   - 注册限速为同 IP 1 小时 5 次：本脚本把注册动作集中在限速用例之前，
 *     限速用例允许"直接收到 429"（复跑场景）或"注册若干次后收到 429"（首跑场景）
 *   - 登录失败限速键含随机用户名，复跑不互相污染
 *   - 测试产生的会议/设置全部清理；隔离账号（qa_iso_a/qa_iso_b）保留供复跑登录
 */
import assert from "node:assert/strict";
import {
    httpGet, httpPut, httpPost, httpDelete, httpPatch, dbQuery, closePool,
    testCase, summary, startMockLlm, createMeetingViaSummarize,
    registerOrLogin, loginAs, setAuthCookie, clearAuthCookie,
    extractSessionCookie, setForwardedIp, fetchCaptcha,
} from "./helpers.mjs";

// 每轮测试模拟独立客户端 IP：注册/登录限速键按 IP 区分，保证复跑配额互不干扰
// （服务端限速键解析 X-Forwarded-For；本机自托管场景下测试模拟不同客户端是合理等价）
const RUN_IP = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
setForwardedIp(RUN_IP);
console.log(`      本轮模拟客户端 IP: ${RUN_IP}`);

const MOCK_PORT = 7300;
const ADMIN_USER = "qaadmin";
const ADMIN_PASS = "Passw0rd2026";
const ISO_PASS = "Passw0rd2026";
const createdIds = []; // 本脚本创建、需要清理的会议 id
const settingsDirty = []; // 需要清理设置的 userId（ISO_A_ID / ISO_B_ID）

try {
    await startMockLlm(MOCK_PORT);

    // ---------- C0 首用户判定与 admin 身份 ----------
    const userCountRows = await dbQuery("SELECT COUNT(*) AS c FROM users");
    const userCount = Number(userCountRows[0].c);

    if (userCount === 0) {
        await testCase("C0-1 全新库：首个注册用户自动成为管理员", async () => {
            clearAuthCookie();
            const res = await registerOrLogin(ADMIN_USER, ADMIN_PASS);
            assert.equal(res.status, 200, `首用户注册失败：${res.text.slice(0, 200)}`);
            assert.equal(res.body?.user?.role, "admin", `首个用户 role 应为 admin，实际 ${res.body?.user?.role}`);
            assert.ok(res.body?.claimedMeetings >= 4, `首用户应 claim 存量会议(>=4)，实际 ${res.body?.claimedMeetings}`);
        });
    } else {
        const login = await loginAs(ADMIN_USER, ADMIN_PASS);
        await testCase("C0-2 存量库：管理员账号存在且 role=admin、claim 已完成", async () => {
            assert.equal(login.status, 200, `管理员登录失败：${login.text.slice(0, 200)}`);
            assert.equal(login.body?.user?.role, "admin", "qaadmin 应为 admin");
            const rows = await dbQuery("SELECT role FROM users WHERE username = ?", [ADMIN_USER]);
            assert.equal(rows[0].role, "admin", "DB 中 qaadmin role 应为 admin");
            const nulls = await dbQuery("SELECT COUNT(*) AS c FROM meetings WHERE user_id IS NULL");
            assert.equal(Number(nulls[0].c), 0, `不应存在无主会议，实际 ${nulls[0].c}`);
            const markers = await dbQuery("SELECT name FROM migration_markers WHERE name = 'claim_meetings_v1'");
            assert.equal(markers.length, 1, "应存在 claim_meetings_v1 迁移标记");
        });
    }

    // ---------- C1 未登录访问保护 ----------
    await testCase("C1 未登录：业务 API 全部 401", async () => {
        clearAuthCookie();
        const probes = [
            httpGet("/api/meetings"),
            httpGet("/api/settings"),
            httpPost("/api/models", { baseURL: "https://x", apiKey: "k" }),
            httpPost("/api/test-key", { baseURL: "https://x", apiKey: "k" }),
            httpPost("/api/chat", { roomId: "x", question: "y" }),
        ];
        for (const p of probes) {
            const res = await p;
            assert.equal(res.status, 401, `未登录访问应 401，实际 ${res.status}：${res.text.slice(0, 120)}`);
        }
    });

    await testCase("C1b 未登录：页面重定向到 /login（/ 与 /result 均 302/307）", async () => {
        clearAuthCookie();
        for (const path of ["/", "/result/someRoom"]) {
            const res = await fetch(`http://127.0.0.1:7200${path}`, { redirect: "manual" });
            assert.ok([301, 302, 307, 308].includes(res.status), `${path} 期望重定向，实际 ${res.status}`);
            assert.ok((res.headers.get("location") || "").includes("/login"), `${path} 应重定向到 /login`);
        }
    });

    await testCase("C1c 未登录：/api/health 豁免放行", async () => {
        clearAuthCookie();
        const res = await httpGet("/api/health");
        assert.equal(res.status, 200, `health 应豁免鉴权，实际 ${res.status}`);
    });

    // ---------- C3 注册校验（不消耗注册限速配额：校验失败/重名不计入? 重名会计入但总量受控） ----------
    await testCase("C3-1 弱密码注册被 400 拒绝（过短/缺数字/缺字母/超长）", async () => {
        clearAuthCookie();
        const cases = [
            ["qa_weak_1", "Ab1"],              // 过短
            ["qa_weak_2", "abcdefgh"],          // 缺数字
            ["qa_weak_3", "12345678"],          // 缺字母
            ["qa_weak_4", "x".repeat(65) + "A1"], // 超长
        ];
        for (const [u, p] of cases) {
            const res = await httpPost("/api/auth/register", { username: u, password: p });
            assert.equal(res.status, 400, `${u} 弱密码应 400，实际 ${res.status}`);
            assert.ok(res.body?.error, "应返回具体校验原因");
        }
    });

    await testCase("C3-2 非法用户名注册被 400 拒绝", async () => {
        clearAuthCookie();
        for (const u of ["ab", "qa bad name", "qa-bad-name", "用户名测试"]) {
            const res = await httpPost("/api/auth/register", { username: u, password: "Passw0rd2026" });
            assert.equal(res.status, 400, `${u} 非法用户名应 400，实际 ${res.status}`);
        }
    });

    await testCase("C3-3 重复用户名注册被 400 拒绝且提示明确（带有效验证码，排除验证码干扰）", async () => {
        clearAuthCookie();
        const cap = await fetchCaptcha();
        const res = await httpPost("/api/auth/register", {
            username: ADMIN_USER, password: "Passw0rd2026",
            captchaId: cap.body.captchaId, captchaCode: cap.body.debugCode,
        });
        assert.equal(res.status, 400, `重名应 400，实际 ${res.status}`);
        assert.ok(String(res.body?.error).includes("用户名已存在"), `应提示用户名已存在：${res.body?.error}`);
    });

    // ---------- C4 登录成功 + Cookie 属性 ----------
    await testCase("C4 登录成功：me 返回身份，Cookie 属性符合契约", async () => {
        clearAuthCookie();
        const login = await httpPost("/api/auth/login", { username: ADMIN_USER, password: ADMIN_PASS });
        assert.equal(login.status, 200, `登录失败：${login.text.slice(0, 200)}`);
        const setCookie = (login.setCookies || []).find((c) => c.startsWith("ma_session="));
        assert.ok(setCookie, "应下发 ma_session Cookie");
        assert.ok(/HttpOnly/i.test(setCookie), "Cookie 应 HttpOnly");
        assert.ok(/SameSite=lax/i.test(setCookie), "Cookie 应 SameSite=Lax");
        assert.ok(/Max-Age=604800/.test(setCookie), "Cookie 应 7 天过期（Max-Age=604800）");
        assert.ok(/Path=\//.test(setCookie), "Cookie Path 应为 /");
        setAuthCookie(extractSessionCookie(login.setCookies));
        const me = await httpGet("/api/auth/me");
        assert.equal(me.status, 200, "登录后 me 应 200");
        assert.equal(me.body?.user?.username, ADMIN_USER, "me 应返回正确用户名");
        assert.equal(me.body?.user?.role, "admin", "me 应返回正确角色");
    });

    // ---------- C5 登录失败统一模糊 401 ----------
    await testCase("C5 错误密码与不存在用户：统一 401 且文案一致（不暴露账号存在性）", async () => {
        clearAuthCookie();
        const wrongPwd = await httpPost("/api/auth/login", { username: ADMIN_USER, password: "WrongPass999" });
        const noUser = await httpPost("/api/auth/login", { username: `qa_nouser_${Date.now()}`, password: "Whatever123" });
        assert.equal(wrongPwd.status, 401, "错误密码应 401");
        assert.equal(noUser.status, 401, "不存在用户应 401");
        assert.equal(wrongPwd.body?.error, noUser.body?.error, "两种失败文案必须一致");
        assert.equal(wrongPwd.body?.error, "用户名或密码错误", `文案应为固定值，实际：${wrongPwd.body?.error}`);
    });

    // ---------- C7 隔离账号准备（注册消耗配额，集中在限速用例之前） ----------
    const isoARes = await registerOrLogin("qa_iso_a", ISO_PASS);
    const isoBRes = await registerOrLogin("qa_iso_b", ISO_PASS);
    await testCase("C7-0 隔离账号就绪（iso_a/iso_b 可注册或登录）", async () => {
        assert.ok([200, 429].includes(isoARes.status) || isoARes.status === 400, `iso_a 就绪失败：${isoARes.status} ${isoARes.text.slice(0, 120)}`);
        assert.ok([200, 429].includes(isoBRes.status) || isoBRes.status === 400, `iso_b 就绪失败：${isoBRes.status} ${isoBRes.text.slice(0, 120)}`);
        // 复跑时注册可能 429 → 已回退登录成功；这里以登录态最终可用为准
        loginAs("qa_iso_a", ISO_PASS);
        const meA = await httpGet("/api/auth/me");
        assert.equal(meA.status, 200, "iso_a 登录态不可用");
    });
    const idRowsA = await dbQuery("SELECT id FROM users WHERE username = 'qa_iso_a'");
    const idRowsB = await dbQuery("SELECT id FROM users WHERE username = 'qa_iso_b'");
    const ISO_A_ID = Number(idRowsA[0]?.id);
    const ISO_B_ID = Number(idRowsB[0]?.id);
    settingsDirty.push(ISO_A_ID, ISO_B_ID);

    // ---------- C8 双用户会议隔离 ----------
    let isoARoomId = null;
    await testCase("C8-1 iso_a 经 summarize 新建会议成功", async () => {
        await loginAs("qa_iso_a", ISO_PASS);
        isoARoomId = await createMeetingViaSummarize(MOCK_PORT, "-isoA隔离测试");
        createdIds.push(isoARoomId);
    });

    await testCase("C8-2 iso_b 列表看不到 iso_a 的会议", async () => {
        await loginAs("qa_iso_b", ISO_PASS);
        const list = await httpGet("/api/meetings?limit=200");
        assert.equal(list.status, 200, "iso_b 列表请求失败");
        const found = (list.body?.meetings || []).some((m) => m.id === isoARoomId);
        assert.ok(!found, "横向越权：iso_b 能在列表中看到 iso_a 的会议!");
    });

    await testCase("C8-3 iso_b GET/PATCH/DELETE iso_a 的会议 → 全部 404", async () => {
        const get = await httpGet(`/api/meetings?id=${isoARoomId}`);
        const patch = await httpPatch("/api/meetings", { id: isoARoomId, title: "越权改名" });
        const del = await httpDelete(`/api/meetings?id=${isoARoomId}`);
        assert.equal(get.status, 404, `越权 GET 应 404，实际 ${get.status}`);
        assert.equal(patch.status, 404, `越权 PATCH 应 404，实际 ${patch.status}`);
        assert.equal(del.status, 404, `越权 DELETE 应 404，实际 ${del.status}`);
    });

    await testCase("C8-4 iso_a 本人 GET 正常；删除会议成功", async () => {
        await loginAs("qa_iso_a", ISO_PASS);
        const get = await httpGet(`/api/meetings?id=${isoARoomId}`);
        assert.equal(get.status, 200, "本人 GET 应 200");
        const del = await httpDelete(`/api/meetings?id=${isoARoomId}`);
        assert.equal(del.status, 200, "本人 DELETE 应 200");
        createdIds.splice(createdIds.indexOf(isoARoomId), 1);
    });

    await testCase("C8-5 iso_b 的 result 页面访问 iso_a 已删会议 → 404 视图", async () => {
        const login = await loginAs("qa_iso_b", ISO_PASS);
        const cookie = extractSessionCookie(login.setCookies);
        assert.ok(cookie, "iso_b 登录应下发 Cookie");
        const res = await fetch(`http://127.0.0.1:7200/result/${isoARoomId}`, {
            headers: { cookie: `ma_session=${cookie}` },
            redirect: "manual",
        });
        assert.equal(res.status, 404, `有效会话访问他人/已删会议应 404，实际 ${res.status}`);
        const html = await res.text();
        assert.ok(html.includes("未找到该会议记录"), "404 视图应渲染未找到提示");
    });

    // ---------- C9 BYOK 设置隔离 ----------
    await testCase("C9-1 iso_a 配置 LLM 密钥 → 仅 iso_a 可见（脱敏）", async () => {
        await loginAs("qa_iso_a", ISO_PASS);
        const put = await httpPut("/api/settings", { llmApiKey: "sk-iso-a-123456789", llmModel: "iso-a-model" });
        assert.equal(put.status, 200, `iso_a 保存设置失败：${put.text.slice(0, 200)}`);
        const get = await httpGet("/api/settings");
        assert.equal(get.body?.settings?.llmHasApiKey, true, "iso_a 本人应有密钥");
        assert.equal(get.body?.settings?.llmApiKeyMasked, "sk-****6789", `脱敏值异常: ${get.body?.settings?.llmApiKeyMasked}`);
    });

    await testCase("C9-2 iso_b 配置自己的密钥；响应不含 iso_a 的密钥（互不可见）", async () => {
        await loginAs("qa_iso_b", ISO_PASS);
        const put = await httpPut("/api/settings", { llmApiKey: "sk-iso-b-987654321", llmModel: "iso-b-model" });
        assert.equal(put.status, 200, `iso_b 保存设置失败：${put.text.slice(0, 200)}`);
        const get = await httpGet("/api/settings");
        assert.equal(get.status, 200, "iso_b GET settings 失败");
        assert.equal(get.body?.settings?.llmHasApiKey, true, "iso_b 应只有自己的密钥");
        assert.equal(get.body?.settings?.llmApiKeyMasked, "sk-****4321", `iso_b masked 应为自己的尾4位: ${get.body?.settings?.llmApiKeyMasked}`);
        assert.ok(!get.text.includes("sk-iso-a-123456789"), "响应泄漏 iso_a 的明文密钥!");
        assert.ok(!get.text.includes("iso-a-model"), "响应泄漏 iso_a 的模型配置!");
    });

    await testCase("C9-3 DB 落库核实：user_settings 按用户分行且均为密文互不相同", async () => {
        const rows = await dbQuery(
            "SELECT user_id, llm_api_key_enc, llm_model FROM user_settings WHERE user_id IN (?, ?) ORDER BY user_id",
            [ISO_A_ID, ISO_B_ID]
        );
        assert.equal(rows.length, 2, `user_settings 应有两行，实际 ${rows.length}`);
        for (const r of rows) {
            assert.ok(String(r.llm_api_key_enc).startsWith("v1:"), `user ${r.user_id} 密文格式异常`);
            assert.ok(!String(r.llm_api_key_enc).includes("sk-iso-a-123456789"), "DB 出现明文密钥!");
            assert.ok(!String(r.llm_api_key_enc).includes("sk-iso-b-987654321"), "DB 出现明文密钥!");
        }
        const a = rows.find((r) => Number(r.user_id) === ISO_A_ID);
        const b = rows.find((r) => Number(r.user_id) === ISO_B_ID);
        assert.equal(a?.llm_model, "iso-a-model", "iso_a 的 model 应落库");
        assert.equal(b?.llm_model, "iso-b-model", "iso_b 的 model 应落库");
        assert.notEqual(a?.llm_api_key_enc, b?.llm_api_key_enc, "两用户的密文不应相同（AES-GCM 随机 IV）");
    });

    // ---------- C10b 管理员接口（ISO 账号就绪后执行） ----------
    await testCase("C10 管理员可见用户列表；普通用户 403", async () => {
        await loginAs("qa_iso_b", ISO_PASS);
        const forbidden = await httpGet("/api/admin/users");
        assert.equal(forbidden.status, 403, `普通用户访问 admin 接口应 403，实际 ${forbidden.status}`);
        await loginAs(ADMIN_USER, ADMIN_PASS);
        const okRes = await httpGet("/api/admin/users");
        assert.equal(okRes.status, 200, `管理员查询应 200，实际 ${okRes.status}`);
        assert.ok(Array.isArray(okRes.body?.users) && okRes.body.users.length >= 2, "用户列表应含全部注册用户");
        for (const u of okRes.body.users) {
            assert.ok(u.username !== undefined && u.role !== undefined && u.createdAt !== undefined, "列表条目缺字段");
            assert.ok(!("password_hash" in u), "用户列表不得泄漏密码哈希!");
        }
    });

    // ---------- C11 改密（R13）：旧 Cookie 全端失效 ----------
    const stamp = Date.now().toString(36);
    const pwdUser = `qa_pwd_${stamp}`;
    let oldCookie = null;
    await registerOrLogin(pwdUser, "Passw0rd2026");
    await testCase("C11-1 改密准备：登录并保存改密前的旧会话 Cookie", async () => {
        const login = await loginAs(pwdUser, "Passw0rd2026");
        assert.equal(login.status, 200, `改密账号登录失败：${login.text.slice(0, 150)}`);
        oldCookie = extractSessionCookie(login.setCookies);
        assert.ok(oldCookie, "应拿到改密前的会话 Cookie");
    });

    await testCase("C11-2 验旧密码错误 → 400；改密成功 → 签发新 Cookie", async () => {
        const bad = await httpPost("/api/auth/password", { oldPassword: "WrongOld999", newPassword: "NewPass456" });
        assert.equal(bad.status, 400, `旧密码错误应 400，实际 ${bad.status}`);
        const res = await httpPost("/api/auth/password", { oldPassword: "Passw0rd2026", newPassword: "NewPass456" });
        assert.equal(res.status, 200, `改密失败：${res.text.slice(0, 200)}`);
        const newCookie = extractSessionCookie(res.setCookies);
        assert.ok(newCookie, "改密后应重签新 Cookie");
        setAuthCookie(newCookie);
        const me = await httpGet("/api/auth/me");
        assert.equal(me.status, 200, "新 Cookie 应可正常认证");
    });

    await testCase("C11-3 改密前的旧会话 Cookie 失效（token_version 核对）", async () => {
        setAuthCookie(oldCookie); // 改密前签发的旧会话
        const me = await httpGet("/api/auth/me");
        assert.equal(me.status, 401, `旧会话应被 token_version 踢掉（401），实际 ${me.status}`);
    });

    await testCase("C11-4 改回原密码（保证复跑幂等）+ 新密码登录验证", async () => {
        const relogin = await loginAs(pwdUser, "NewPass456");
        assert.equal(relogin.status, 200, "新密码应可登录");
        const back = await httpPost("/api/auth/password", { oldPassword: "NewPass456", newPassword: "Passw0rd2026" });
        assert.equal(back.status, 200, `改回原密码失败：${back.text.slice(0, 150)}`);
    });

    // ---------- C12 登出 ----------
    await testCase("C12 登出：Set-Cookie 清除指令正确，清空后的 Cookie 不再被接受", async () => {
        const login = await loginAs("qa_iso_b", ISO_PASS);
        assert.equal(login.status, 200, "登录失败");
        const logout = await httpPost("/api/auth/logout", {});
        assert.equal(logout.status, 200, "登出应 200");
        // 服务端下发清 Cookie 指令（空值 + 立即过期）
        const setCookie = (logout.setCookies || []).find((c) => c.startsWith("ma_session="));
        assert.ok(setCookie, "登出应下发 ma_session 清除指令");
        assert.ok(/Max-Age=0|Expires=Thu, 01 Jan 1970/.test(setCookie), `清除指令应立即过期: ${setCookie}`);
        // 模拟遵守指令的浏览器：Cookie 已被清空 → 后续请求携带空会话 → 401
        clearAuthCookie();
        const me = await httpGet("/api/auth/me");
        assert.equal(me.status, 401, "登出后（Cookie 已清）应 401");
    });

    // ---------- C6 登录失败限速（随机用户名，不影响真实账号） ----------
    await testCase("C6 登录连败 5 次后第 6 次触发 429", async () => {
        clearAuthCookie();
        const victim = `qa_limit_${stamp}`;
        let saw429 = false;
        for (let i = 1; i <= 6; i++) {
            const res = await httpPost("/api/auth/login", { username: victim, password: `Bad${i}aaaa` });
            if (res.status === 429) { saw429 = true; break; }
            assert.equal(res.status, 401, `第 ${i} 次失败登录应 401，实际 ${res.status}`);
        }
        assert.ok(saw429, "连败后应触发 429 限速");
        const res429 = await httpPost("/api/auth/login", { username: victim, password: "BadXaaaa" });
        assert.equal(res429.status, 429, "限速窗口内应持续 429");
        assert.ok(String(res429.body?.error).includes("频繁") || String(res429.body?.error).includes("分钟"), "429 应提示退避信息");
    });

    // ---------- C6b 注册限速（集中消耗配额的最后一个注册类用例） ----------
    await testCase("C6b 注册高频触发 429（复跑时直接命中剩余配额）", async () => {
        clearAuthCookie();
        let saw429 = false;
        let sawOther = false;
        for (let i = 1; i <= 8; i++) {
            const res = await httpPost("/api/auth/register", {
                username: `qa_reg_${stamp}_${i}`,
                password: "Passw0rd2026",
            });
            if (res.status === 429) { saw429 = true; break; }
            if (res.status === 200 || res.status === 400) { sawOther = true; continue; }
            assert.fail(`注册出现意外状态 ${res.status}: ${res.text.slice(0, 120)}`);
        }
        assert.ok(saw429, "注册限速应触发 429（窗口内超过 5 次）");
        void sawOther;
    });

} finally {
    // ---------- 清理：测试会议与测试设置 ----------
    clearAuthCookie();
    // 测试账号自动清理（backlog）：删除 qa_pwd_*/qa_reg_* 等一次性测试用户（qaadmin/qa_iso_* 保留）
    // 注：用 SUBSTRING 匹配 'qa_' 前缀，避开 LIKE 下划线通配符的转义陷阱
    try {
        await dbQuery(
            `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE SUBSTRING(username, 1, 3) = 'qa_' AND username NOT IN ('qaadmin', 'qa_iso_a', 'qa_iso_b'))`
        );
        await dbQuery(
            `DELETE FROM user_settings WHERE user_id IN (SELECT id FROM users WHERE SUBSTRING(username, 1, 3) = 'qa_' AND username NOT IN ('qaadmin', 'qa_iso_a', 'qa_iso_b'))`
        );
        await dbQuery(
            `DELETE FROM users WHERE SUBSTRING(username, 1, 3) = 'qa_' AND username NOT IN ('qaadmin', 'qa_iso_a', 'qa_iso_b')`
        );
        console.log(`清理 qa_pwd_*/qa_reg_* 等一次性测试用户完成（qaadmin/qa_iso_* 保留）`);
    } catch (e) {
        console.log(`清理一次性测试用户失败，请人工检查: ${e.message}`);
    }
    // 重置真实测试账号的登录失败计数/锁定（C5 错密码对 qaadmin 计数 +1，跨复跑会累积触发锁定）
    try {
        await dbQuery(
            `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE username IN ('qaadmin', 'qa_iso_a', 'qa_iso_b')`
        );
        console.log(`重置 qaadmin/qa_iso_* 登录失败计数完成`);
    } catch (e) {
        console.log(`重置登录计数失败: ${e.message}`);
    }
    try { await loginAs("qa_iso_a", ISO_PASS); } catch { /* ignore */ }
    for (const id of [...createdIds]) {
        const del = await httpDelete(`/api/meetings?id=${encodeURIComponent(id)}`);
        const ok = del.status === 200 || del.status === 404;
        console.log(`清理会议 ${id}: ${ok ? "已删除" : `失败(status=${del.status})，请人工检查!`}`);
        if (ok) createdIds.splice(createdIds.indexOf(id), 1);
    }
    // 清理 ISO 账号的设置（恢复为空），避免残留测试密钥
    for (const uid of settingsDirty) {
        try {
            const rows = await dbQuery("SELECT username FROM users WHERE id = ?", [uid]);
            const name = rows[0]?.username;
            if (!name) continue;
            const PASS = ISO_PASS;
            await loginAs(name, PASS);
            await httpPut("/api/settings", { clearLlmApiKey: true, clearAsrApiKey: true, llmBaseUrl: "", llmModel: "", asrBaseUrl: "", asrModel: "" });
            console.log(`清理设置 user#${uid}(${name})：已恢复为空配置`);
        } catch (e) {
            console.log(`清理设置 user#${uid} 失败: ${e.message}`);
        }
    }
    clearAuthCookie();
    await closePool();
}

const ok = summary();
process.exit(ok ? 0 : 1);
