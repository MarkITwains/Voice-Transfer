/**
 * B. 设置同步（PRD 核心：换浏览器免重配）+ C2 迁移标记核查
 *
 * 前置：dev server 运行中、MySQL 运行中；若 DB 尚无密钥（全新库），脚本先注入测试密钥 sk-test-abcd。
 * 约束：测完把配置恢复到测试前状态（原本无密钥则清除，不留测试数据）。
 */
import assert from "node:assert/strict";
import {
    httpGet, httpPut, httpPost, httpDelete, dbQuery, closePool,
    testCase, summary, registerOrLogin, setForwardedIp,
    startMockLlm, createMeetingViaSummarize,
} from "./helpers.mjs";

let originalModel = null;
let originalBaseUrl = null;
let originalMasked = null;
let seeded = false; // 本次是否注入了测试密钥（原本无密钥，测后清理为无密钥状态）

// 独立模拟客户端 IP：登录限速键 login:<ip>:<username> 按套件隔离，复跑不与其他套件共享 local 配额
setForwardedIp(`10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`);

try {
    // ---------- 前置：登录（qaadmin 由 c-auth 套件保证存在） ----------
    const auth = await registerOrLogin("qaadmin", "Passw0rd2026");
    assert.equal(auth.status, 200, `测试账号登录失败（c-auth 套件应先运行）：${auth.text.slice(0, 200)}`);
    const idRows = await dbQuery("SELECT id FROM users WHERE username = 'qaadmin'");
    const ADMIN_ID = Number(idRows[0].id);
    console.log(`      登录身份: qaadmin (userId=${ADMIN_ID})`);

    // 记录原始配置，测试后恢复
    const first = await httpGet("/api/settings");
    assert.equal(first.status, 200, `GET /api/settings 失败：${first.text.slice(0, 200)}`);
    originalModel = first.body.settings.llmModel;
    originalBaseUrl = first.body.settings.llmBaseUrl;
    originalMasked = first.body.settings.llmApiKeyMasked;
    console.log(`      原始配置: model=${originalModel} baseUrl=${originalBaseUrl} masked=${originalMasked}`);

    // 前置：若 DB 尚无密钥（全新 MySQL 库），先注入测试密钥，保证 B1/B1b/B2/B4 可断言
    if (originalMasked === null || originalMasked === undefined) {
        const seed = await httpPut("/api/settings", { llmApiKey: "sk-test-abcd" });
        assert.equal(seed.status, 200, `注入测试密钥失败：${seed.text.slice(0, 200)}`);
        seeded = true;
        originalMasked = "sk-****abcd"; // 断言基线更新为注入后的状态（B2 以此校验“密钥保留”）
        console.log("      前置：DB 无密钥，已注入测试密钥 sk-test-abcd（测后按原状态清理）");
    }

    // ---------- B1 脱敏断言 ----------
    await testCase("B1 GET /api/settings 响应中无任何明文 apiKey", async () => {
        const res = await httpGet("/api/settings");
        assert.equal(res.status, 200, `期望 200，实际 ${res.status}`);
        const raw = res.text;
        // 已知明文测试密钥绝不能出现
        assert.ok(!raw.includes("sk-test-abcd"), "响应泄漏了已知明文密钥 sk-test-abcd");
        // 通用检查：任何未脱敏的长密钥（sk- 后跟 >4 位可见字符）不得出现
        const leak = raw.match(/sk-[A-Za-z0-9_-]{5,}/g);
        assert.ok(!leak, `响应疑似泄漏明文密钥片段: ${leak?.join(",")}`);
        assert.equal(res.body.settings.llmHasApiKey, true, "llmHasApiKey 应为 true");
    });

    await testCase("B1b 密钥脱敏格式正确（sk-****+尾4位）", async () => {
        const s = (await httpGet("/api/settings")).body.settings;
        assert.match(s.llmApiKeyMasked, /^.{3}\*\*\*\*.{4}$/, `脱敏格式异常: ${s.llmApiKeyMasked}`);
        assert.match(s.llmApiKeyMasked, /^sk-\*\*\*\*abcd$/, `脱敏值应为 sk-****abcd，实际 ${s.llmApiKeyMasked}`);
    });

    // ---------- B2 PUT 只改 model 不带 apiKey → 保留旧密钥 ----------
    await testCase("B2 PUT 只改 model（不带 apiKey）→ masked 值不变", async () => {
        const put = await httpPut("/api/settings", { llmModel: "qa-test-model-temp" });
        assert.equal(put.status, 200, `PUT 失败：${put.text.slice(0, 200)}`);
        const after = (await httpGet("/api/settings")).body.settings;
        assert.equal(after.llmApiKeyMasked, originalMasked, `masked 变化：${originalMasked} → ${after.llmApiKeyMasked}`);
        assert.equal(after.llmHasApiKey, true, "llmHasApiKey 不应为 false");
        assert.equal(after.llmModel, "qa-test-model-temp", "llmModel 应已更新");
    });

    // ---------- B4 DB 落库核实（密文 + 非明文） ----------
    await testCase("B4 user_settings.llm_api_key_enc 为 v1: 开头密文（非明文，按用户落库）", async () => {
        const rows = await dbQuery("SELECT llm_api_key_enc FROM user_settings WHERE user_id = ?", [ADMIN_ID]);
        assert.ok(rows.length === 1, `qaadmin 的 user_settings 应恰有一行，实际 ${rows.length}`);
        const enc = rows[0].llm_api_key_enc;
        assert.ok(enc && enc.startsWith("v1:"), `密文应 v1: 开头，实际前缀: ${String(enc).slice(0, 12)}`);
        const parts = enc.split(":");
        assert.equal(parts.length, 4, "密文格式应为 v1:<iv>:<tag>:<cipher> 共 4 段");
        assert.ok(!enc.includes("sk-test-abcd"), "数据库中出现明文密钥!");
        console.log(`      密文前缀: ${enc.slice(0, 24)}...`);
    });

    // ---------- B3 清除后恢复 ----------
    await testCase("B3-1 PUT clearLlmApiKey=true → llmHasApiKey=false", async () => {
        const put = await httpPut("/api/settings", { clearLlmApiKey: true });
        assert.equal(put.status, 200, `PUT 失败：${put.text.slice(0, 200)}`);
        const after = (await httpGet("/api/settings")).body.settings;
        assert.equal(after.llmHasApiKey, false, "清除后 llmHasApiKey 应为 false");
        assert.equal(after.llmApiKeyMasked, null, "清除后 masked 应为 null");
    });

    await testCase("B3-2 恢复原密钥 sk-test-abcd → masked 回到 sk-****abcd", async () => {
        const put = await httpPut("/api/settings", { llmApiKey: "sk-test-abcd" });
        assert.equal(put.status, 200, `PUT 失败：${put.text.slice(0, 200)}`);
        const after = (await httpGet("/api/settings")).body.settings;
        assert.equal(after.llmHasApiKey, true, "恢复后 llmHasApiKey 应为 true");
        assert.equal(after.llmApiKeyMasked, "sk-****abcd", `masked 应为 sk-****abcd，实际 ${after.llmApiKeyMasked}`);
    });

    // ---------- C2 迁移标记 ----------
    await testCase("C2 migration_markers 含 meetings_json_v1 与 claim_meetings_v1", async () => {
        const rows = await dbQuery("SELECT name FROM migration_markers ORDER BY name");
        const names = rows.map((r) => r.name);
        assert.deepEqual(names, ["claim_meetings_v1", "meetings_json_v1"], `标记应为 claim_meetings_v1 + meetings_json_v1，实际: ${names.join(",")}`);
    });

    // ---------- B5 chat 从 DB 拿配置 ----------
    await testCase("B5 /api/chat(带 roomId) 能从 DB 取配置发起请求（非「未配置密钥」）", async () => {
        // 自建临时会议：CI 为全新空库，qaadmin 名下未必有存量会议可挑
        const MOCK_PORT = 7301; // 避开 A 组用的 7300
        const mockServer = await startMockLlm(MOCK_PORT);
        let roomId = null;
        try {
            roomId = await createMeetingViaSummarize(MOCK_PORT);
            const res = await httpPost("/api/chat", { roomId, question: "这场会议的主要结论是什么？" });
            console.log(`      chat 响应: status=${res.status} body=${res.text.slice(0, 200)}`);
            // 不能因为「未配置密钥」而 401 —— DB 中有测试密钥，配置解析必须成功
            const notConfigured = typeof res.body?.error === "string" && res.body.error.includes("未配置");
            assert.ok(!notConfigured, `chat 返回「未配置密钥」类错误，DB 配置读取链路失败: ${res.body?.error}`);
            assert.ok([200, 401, 500].includes(res.status), `chat 状态异常: ${res.status}`);
            if (res.status === 500) {
                // 500 必须来自上游 LLM 调用失败（假密钥预期），而不是配置/DB 崩溃
                assert.ok(
                    !/relation|doesn'?t exist|Unknown column|ECONNREFUSED|Access denied|ER_/i.test(String(res.body?.error)),
                    `疑似 DB/配置错误: ${res.body?.error}`
                );
            }
        } finally {
            // 清理临时会议与 mock server，不在库里留测试数据
            if (roomId) {
                const del = await httpDelete(`/api/meetings?id=${encodeURIComponent(roomId)}`);
                console.log(`      清理临时会议 ${roomId}: ${del.status === 200 || del.status === 404 ? "OK" : `status=${del.status}`}`);
            }
            mockServer?.close?.();
        }
    });
} finally {
    // ---------- 恢复原始设置 ----------
    try {
        // 恢复到测试前状态：原本无密钥则清除，不在库里留测试密钥
        const restore = seeded
            ? { clearLlmApiKey: true }
            : { llmApiKey: "sk-test-abcd" };
        restore.llmModel = originalModel ?? "";
        restore.llmBaseUrl = originalBaseUrl ?? "";
        await httpPut("/api/settings", restore);
        const check = (await httpGet("/api/settings")).body.settings;
        const expectMasked = seeded ? null : "sk-****abcd";
        console.log(
            `恢复后设置: model=${check.llmModel} baseUrl=${check.llmBaseUrl} masked=${check.llmApiKeyMasked} ` +
            `(期望 masked=${expectMasked} ${check.llmApiKeyMasked === expectMasked ? "OK" : "请人工核对"})`
        );
    } catch (e) {
        console.log(`恢复设置失败，请人工核对: ${e.message}`);
    }
    await closePool();
}

const ok = summary();
process.exit(ok ? 0 : 1);
