/**
 * D. 会话凭证深度验证（v2：会话过期 / 签名篡改 / token_version 纵深防御 / 服务端吊销）
 *
 * 依赖：data/auth_secret（服务端自动生成的会话签名密钥，与 dev server 同机读取）。
 * 用最小同构实现重算 HMAC 构造 v2 token（payload 含 jti），验证服务端校验逻辑：
 *   D4 对照组：同构实现签发"未过期"token + sessions 插行 → 200（证明构造与校验一致）
 *   D1 篡改签名 → 401（恒定时间比较不被绕过）
 *   D2 过期 token（exp 在过去，签名有效）→ 401（"会话过期"实测，非仅 Max-Age 属性）
 *   D3 签名有效但 ver 与 DB token_version 不符 → 401（requireUser 纵深防御）
 *   D5 签名有效、ver 正确，但 jti 无 sessions 行（已吊销/未登记）→ 401（服务端吊销语义）
 *
 * 约束：只读 users 表 + 增删本脚本自建的 sessions 行（测试后清理），不改任何用户数据。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    httpGet, dbQuery, closePool, testCase, summary,
    registerOrLogin, clearAuthCookie, setForwardedIp,
} from "./helpers.mjs";

// 独立模拟客户端 IP：登录限速键 login:<ip>:<username> 按套件隔离，复跑不与其他套件共享 local 配额
setForwardedIp(`10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`);

// ---- 与 app/lib/authToken.ts 同构的最小签发实现（v2，仅测试用） ----
const SECRET_FILE = path.join(import.meta.dirname, "../../data/auth_secret");
const secret = (() => {
    const raw = fs.readFileSync(SECRET_FILE, "utf-8").trim();
    const buf = Buffer.from(raw, "base64");
    assert.ok(buf.length >= 32, "data/auth_secret 应为 ≥32 字节 base64");
    return buf;
})();

function sign(payload) {
    const payloadB64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(`v2.${payloadB64}`).digest();
    return `v2.${payloadB64}.${sig.toString("base64url")}`;
}

function cookieOf(token) {
    return `ma_session=${token}`;
}

/** 为 jti 插入 sessions 行（有效期 1 小时），返回清理函数登记用 */
const createdJtis = [];
async function ensureSession(jti, userId) {
    await dbQuery(
        `INSERT INTO sessions (jti, user_id, expires_at) VALUES (?, ?, ?)`,
        [jti, userId, new Date(Date.now() + 3600 * 1000)]
    );
    createdJtis.push(jti);
}

// ---- 取一个真实账号的身份字段 ----
clearAuthCookie();
const boot = await registerOrLogin("qaadmin", "Passw0rd2026");
assert.equal(boot.status, 200, `qaadmin 登录失败，无法构造深度用例：${boot.status}`);

const userRows = await dbQuery("SELECT id, username, role, token_version FROM users WHERE username = 'qaadmin'");
assert.ok(userRows.length === 1, "qaadmin 应存在于 users 表");
const u = userRows[0];
console.log(`      构造身份: uid=${u.id} un=${u.username} role=${u.role} ver=${u.token_version}`);

const now = Math.floor(Date.now() / 1000);
const base = { uid: Number(u.id), un: u.username, role: u.role, ver: Number(u.token_version) };

try {
    // D4 对照组先跑：证明本文件的签名构造与服务端一致（含 jti + sessions 行核对链路）
    await testCase("D4 对照组：同构实现签发的有效 token（jti 已登记 sessions）可通过认证", async () => {
        const jti = crypto.randomBytes(16).toString("hex");
        const tok = sign({ ...base, jti, iat: now, exp: now + 3600 });
        await ensureSession(jti, Number(u.id));
        const me = await httpGet("/api/auth/me", { headers: { cookie: cookieOf(tok) } });
        assert.equal(me.status, 200, `对照组应 200，实际 ${me.status}：${me.text.slice(0, 120)}`);
        assert.equal(me.body?.user?.username, u.username, "对照组身份应正确");
    });

    await testCase("D1 篡改签名 → 401（签名校验不可绕过）", async () => {
        const jti = crypto.randomBytes(16).toString("hex");
        const tok = sign({ ...base, jti, iat: now, exp: now + 3600 });
        const parts = tok.split(".");
        const sig = Buffer.from(parts[2], "base64url");
        sig[0] = sig[0] ^ 0xff; // 翻转签名首字节
        const tampered = `${parts[0]}.${parts[1]}.${sig.toString("base64url")}`;
        const me = await httpGet("/api/auth/me", { headers: { cookie: cookieOf(tampered) } });
        assert.equal(me.status, 401, `篡改签名应 401，实际 ${me.status}`);
    });

    await testCase("D2 过期 token（签名有效但 exp 已过）→ 401（会话过期实测）", async () => {
        const jti = crypto.randomBytes(16).toString("hex");
        const tok = sign({ ...base, jti, iat: now - 7200, exp: now - 3600 }); // 1 小时前已过期
        const me = await httpGet("/api/auth/me", { headers: { cookie: cookieOf(tok) } });
        assert.equal(me.status, 401, `过期 token 应 401，实际 ${me.status}：${me.text.slice(0, 120)}`);
        const meetings = await httpGet("/api/meetings", { headers: { cookie: cookieOf(tok) } });
        assert.equal(meetings.status, 401, `过期 token 访问业务 API 也应 401，实际 ${meetings.status}`);
    });

    await testCase("D3 签名有效但 ver 与 DB token_version 不符 → 401（纵深防御）", async () => {
        const jti = crypto.randomBytes(16).toString("hex");
        const tok = sign({ ...base, ver: Number(u.token_version) + 99, jti, iat: now, exp: now + 3600 });
        await ensureSession(jti, Number(u.id)); // 会话行在，ver 不符照样拒
        const me = await httpGet("/api/auth/me", { headers: { cookie: cookieOf(tok) } });
        assert.equal(me.status, 401, `ver 不符应 401，实际 ${me.status}：${me.text.slice(0, 120)}`);
    });

    await testCase("D5 签名有效、ver 正确，但 jti 无 sessions 行（已吊销/未登记）→ 401（服务端吊销）", async () => {
        const jti = crypto.randomBytes(16).toString("hex"); // 故意不插 sessions 行
        const tok = sign({ ...base, jti, iat: now, exp: now + 3600 });
        const me = await httpGet("/api/auth/me", { headers: { cookie: cookieOf(tok) } });
        assert.equal(me.status, 401, `无会话行的 token 应 401（吊销语义），实际 ${me.status}：${me.text.slice(0, 120)}`);
        // 对照：登出吊销后的真实 Cookie 同样 401 已由 F2 覆盖，此处验证"裸构造 token 不可凭空获得会话"
    });
} finally {
    // 清理本脚本自建的 sessions 行
    for (const jti of createdJtis) {
        try {
            await dbQuery(`DELETE FROM sessions WHERE jti = ?`, [jti]);
        } catch { /* ignore */ }
    }
    clearAuthCookie();
    await closePool();
}

const ok = summary();
process.exit(ok ? 0 : 1);
