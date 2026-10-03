/**
 * E. 验证码用例组（R1-R5：契约 / 注册强制 / 一次性 / 大小写 / 自适应边界 / 限速）
 *
 * 前置：dev server 运行中、.env.local 含 QA_TEST_MODE=1（测试模式响应附 debugCode）。
 * 约束：
 *   - 注册限速 5 次/小时/IP：每个注册请求用独立随机 X-Forwarded-For，互不消耗配额
 *   - 登录限速 5 次/15min/(IP+用户名)：自适应场景各阶段用独立 IP，避免误触 IP 限速
 *   - 测试用户（qa_cap_*）自注入自清理；不触碰 qaadmin 与 iso 账号
 */
import assert from "node:assert/strict";
import {
    httpGet, httpPost, dbQuery, closePool,
    testCase, summary, fetchCaptcha,
    clearAuthCookie, setForwardedIp,
} from "./helpers.mjs";

const RUN_IP = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
setForwardedIp(RUN_IP);
console.log(`      本轮模拟客户端 IP: ${RUN_IP}`);

const stamp = Date.now().toString(36);
const PASS = "Passw0rd2026";

/** 每次注册/登录用独立随机 IP，规避注册(5/h/IP)与登录(5/15min/IP+un)限速互扰 */
function freshIp() {
    return `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}

/** 与 debugCode 必不相同的安全错码（字符集去混淆集内的 5 位） */
function wrongCode(debugCode) {
    return debugCode === "XXXXX" ? "WW2WW" : "XXXXX";
}

try {
    // ---------- E1 契约 ----------
    await testCase("E1 验证码契约：200 { captchaId, svg, expiresIn:300, debugCode }", async () => {
        const res = await fetchCaptcha();
        assert.ok(res.body.captchaId.length >= 16, "captchaId 应为不可预测随机串");
        assert.ok(res.body.svg.includes("<svg"), "svg 字段应含 <svg 标签");
        assert.equal(res.body.expiresIn, 300, "expiresIn 应为 300 秒");
        assert.equal(typeof res.body.debugCode, "string", "测试模式必须返回 debugCode");
        assert.equal(res.body.debugCode.length, 5, "验证码应为 5 位");
        assert.ok(/^[2-9A-HJKMNP-Z]+$/.test(res.body.debugCode), `验证码应为去混淆字符集，实际 ${res.body.debugCode}`);
    });

    // ---------- E2 注册缺验证码 → 400 ----------
    await testCase("E2 注册缺验证码 → 400 requireCaptcha=true，用户未创建（防机器人 100% 拒）", async () => {
        const u = `qa_cap_e2_${stamp}`;
        const res = await httpPost("/api/auth/register", { username: u, password: PASS }, {
            headers: { "x-forwarded-for": freshIp() },
        });
        assert.equal(res.status, 400, `应 400，实际 ${res.status}：${res.text.slice(0, 120)}`);
        assert.equal(res.body?.requireCaptcha, true, "应带 requireCaptcha 标志");
        const rows = await dbQuery("SELECT id FROM users WHERE username = ?", [u]);
        assert.equal(rows.length, 0, "缺验证码的注册不得创建用户!");
    });

    // ---------- E3 注册错码 → 400 ----------
    await testCase("E3 注册错验证码 → 400 requireCaptcha=true，用户未创建", async () => {
        const u = `qa_cap_e3_${stamp}`;
        const cap = await fetchCaptcha();
        const res = await httpPost("/api/auth/register", {
            username: u, password: PASS, captchaId: cap.body.captchaId, captchaCode: wrongCode(cap.body.debugCode),
        }, { headers: { "x-forwarded-for": freshIp() } });
        assert.equal(res.status, 400, `错码应 400，实际 ${res.status}：${res.text.slice(0, 120)}`);
        assert.equal(res.body?.requireCaptcha, true, "错码响应应带 requireCaptcha 标志");
        const rows = await dbQuery("SELECT id FROM users WHERE username = ?", [u]);
        assert.equal(rows.length, 0, "错码注册不得创建用户!");
    });

    // ---------- E4 注册正确码 → 200 ----------
    await testCase("E4 注册正确验证码 → 200（人工正确输入可注册成功）", async () => {
        const u = `qa_cap_e4_${stamp}`;
        const cap = await fetchCaptcha();
        const res = await httpPost("/api/auth/register", {
            username: u, password: PASS, captchaId: cap.body.captchaId, captchaCode: cap.body.debugCode,
        }, { headers: { "x-forwarded-for": freshIp() } });
        assert.equal(res.status, 200, `正确码注册应 200，实际 ${res.status}：${res.text.slice(0, 150)}`);
        assert.equal(res.body?.user?.username, u, "注册用户名应正确");
    });

    // ---------- E5 一次性复用拒 ----------
    await testCase("E5 验证码一次性：同一 captchaId 第二次使用必须拒绝（防重放）", async () => {
        const u1 = `qa_cap_e5a_${stamp}`;
        const u2 = `qa_cap_e5b_${stamp}`;
        const cap = await fetchCaptcha();
        const ok = await httpPost("/api/auth/register", {
            username: u1, password: PASS, captchaId: cap.body.captchaId, captchaCode: cap.body.debugCode,
        }, { headers: { "x-forwarded-for": freshIp() } });
        assert.equal(ok.status, 200, `首次使用应 200：${ok.text.slice(0, 120)}`);
        const replay = await httpPost("/api/auth/register", {
            username: u2, password: PASS, captchaId: cap.body.captchaId, captchaCode: cap.body.debugCode,
        }, { headers: { "x-forwarded-for": freshIp() } });
        assert.equal(replay.status, 400, `复用同一 captchaId 应 400，实际 ${replay.status}`);
        assert.equal(replay.body?.requireCaptcha, true, "复用响应应带 requireCaptcha 标志");
        const rows = await dbQuery("SELECT id FROM users WHERE username = ?", [u2]);
        assert.equal(rows.length, 0, "复用验证码的注册不得创建用户!");
    });

    // ---------- E6 大小写不敏感 ----------
    await testCase("E6 大小写不敏感：debugCode 全小写输入注册成功", async () => {
        const u = `qa_cap_e6_${stamp}`;
        // 取一个含字母的码（保证大小写转换有效果；纯数字码重取）
        let cap = await fetchCaptcha();
        for (let i = 0; i < 5 && cap.body.debugCode === cap.body.debugCode.toLowerCase(); i++) {
            cap = await fetchCaptcha();
        }
        assert.notEqual(cap.body.debugCode, cap.body.debugCode.toLowerCase(), "抽样码应含字母");
        const res = await httpPost("/api/auth/register", {
            username: u, password: PASS, captchaId: cap.body.captchaId, captchaCode: cap.body.debugCode.toLowerCase(),
        }, { headers: { "x-forwarded-for": freshIp() } });
        assert.equal(res.status, 200, `小写输入应 200，实际 ${res.status}：${res.text.slice(0, 120)}`);
    });

    // ---------- E7 自适应边界（R4：失败 1-2 次无感，第 3 次起强制） ----------
    const adaptUser = `qa_cap_adapt_${stamp}`;
    await testCase("E7-0 自适应账号准备：先带码注册 qa_cap_adapt_*（不存在用户不计数，无法测自适应）", async () => {
        const cap = await fetchCaptcha();
        const res = await httpPost("/api/auth/register", {
            username: adaptUser, password: PASS, captchaId: cap.body.captchaId, captchaCode: cap.body.debugCode,
        }, { headers: { "x-forwarded-for": freshIp() } });
        assert.equal(res.status, 200, `注册自适应账号失败：${res.text.slice(0, 150)}`);
        clearAuthCookie();
    });

    await testCase("E7a 首次错密码：401 且 requireCaptcha=false（正常用户无感）", async () => {
        const res = await httpPost("/api/auth/login", { username: adaptUser, password: "WrongPass999" }, {
            headers: { "x-forwarded-for": freshIp() },
        });
        assert.equal(res.status, 401, `应 401，实际 ${res.status}`);
        assert.equal(res.body?.error, "用户名或密码错误", "失败文案应模糊");
        assert.equal(res.body?.requireCaptcha, false, `第 1 次失败不应要求验证码，实际 ${res.body?.requireCaptcha}`);
    });

    await testCase("E7b 第二次错密码：仍按密码错误处理（401 模糊文案），响应预告需要验证码", async () => {
        const res = await httpPost("/api/auth/login", { username: adaptUser, password: "WrongPass999" }, {
            headers: { "x-forwarded-for": freshIp() },
        });
        assert.equal(res.status, 401, `应 401，实际 ${res.status}`);
        assert.equal(res.body?.error, "用户名或密码错误", "第 2 次失败仍应是密码错误文案（不强制验证码）");
        assert.equal(res.body?.requireCaptcha, true, "第 2 次失败后计数达 2，响应应预告 requireCaptcha=true");
    });

    await testCase("E7c 第 3 次不带验证码 → 401 验证码文案 requireCaptcha=true", async () => {
        const res = await httpPost("/api/auth/login", { username: adaptUser, password: "WrongPass999" }, {
            headers: { "x-forwarded-for": freshIp() },
        });
        assert.equal(res.status, 401, `应 401，实际 ${res.status}`);
        assert.ok(String(res.body?.error).includes("验证码"), `应提示验证码错误，实际：${res.body?.error}`);
        assert.equal(res.body?.requireCaptcha, true, "应带 requireCaptcha 标志");
    });

    // ---------- E8 验证码错误不计数（防锁定 DoS） ----------
    await testCase("E8 验证码错误不计数：连错 2 次验证码后仍可用正确码+正确密码成功", async () => {
        for (let i = 0; i < 2; i++) {
            const cap = await fetchCaptcha();
            const res = await httpPost("/api/auth/login", {
                username: adaptUser, password: PASS, captchaId: cap.body.captchaId, captchaCode: wrongCode(cap.body.debugCode),
            }, { headers: { "x-forwarded-for": freshIp() } });
            assert.equal(res.status, 401, `错验证码应 401，实际 ${res.status}`);
            assert.ok(String(res.body?.error).includes("验证码"), "错验证码应提示验证码文案");
        }
        // 若错码计数 +1/次，此时计数已达 3+2=5 → 会锁定，正确密码也将 429（用例失败即暴露）
        const cap = await fetchCaptcha();
        const ok = await httpPost("/api/auth/login", {
            username: adaptUser, password: PASS, captchaId: cap.body.captchaId, captchaCode: cap.body.debugCode,
        }, { headers: { "x-forwarded-for": freshIp() } });
        assert.equal(ok.status, 200, `正确码+正确密码应 200，实际 ${ok.status}：${ok.text.slice(0, 150)}`);
        clearAuthCookie();
    });

    // ---------- E9 成功登录清零 ----------
    await testCase("E9 成功登录清零：成功后再错 1 次密码，requireCaptcha 应回到 false", async () => {
        const res = await httpPost("/api/auth/login", { username: adaptUser, password: "WrongPass999" }, {
            headers: { "x-forwarded-for": freshIp() },
        });
        assert.equal(res.status, 401, `应 401，实际 ${res.status}`);
        assert.equal(res.body?.requireCaptcha, false, "成功登录清零后首次失败不应要求验证码");
    });

    // ---------- E10 验证码接口限速（30 次/分钟/IP） ----------
    await testCase("E10 验证码接口限速：同 IP 1 分钟 30 次后第 31 次 429", async () => {
        const ip = freshIp();
        let saw429 = false;
        for (let i = 1; i <= 31; i++) {
            const res = await httpGet("/api/auth/captcha", { headers: { "x-forwarded-for": ip } });
            if (res.status === 429) { saw429 = true; break; }
            assert.equal(res.status, 200, `第 ${i} 次取码应 200，实际 ${res.status}`);
        }
        assert.ok(saw429, "31 次内应触发 429 限速");
    });

} finally {
    clearAuthCookie();
    // 自注入自清理：sessions/user_settings 先删（FK），再删用户
    try {
        await dbQuery(
            `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'qa_cap_%')`
        );
        await dbQuery(
            `DELETE FROM user_settings WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'qa_cap_%')`
        );
        await dbQuery(`DELETE FROM users WHERE username LIKE 'qa_cap_%'`);
        console.log(`清理 qa_cap_* 测试用户完成`);
    } catch (e) {
        console.log(`清理 qa_cap_* 失败，请人工检查: ${e.message}`);
    }
    await closePool();
}

const ok = summary();
process.exit(ok ? 0 : 1);
