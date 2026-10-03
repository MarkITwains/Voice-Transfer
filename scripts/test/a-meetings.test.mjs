/**
 * A. 会议 CRUD 与数据一致性（含 D3 result 页面探活）
 *
 * 前置：dev server 运行中（http://127.0.0.1:7200）、MySQL 运行中。
 * 约束：存量 4 条会议只读不碰；本脚本创建的测试会议结束时全部清理。
 */
import assert from "node:assert/strict";
import {
    httpGet, httpPatch, httpDelete, dbQuery, closePool,
    testCase, summary, startMockLlm, createMeetingViaSummarize, safeDeleteMeeting,
    registerOrLogin, extractSessionCookie, setForwardedIp,
} from "./helpers.mjs";

const MOCK_PORT = 7300;
const createdIds = []; // 本脚本创建、需要清理的会议 id

// 独立模拟客户端 IP：登录限速键 login:<ip>:<username> 按套件隔离，复跑不与 D/E/F 等共享 local 配额
setForwardedIp(`10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`);

try {
    await startMockLlm(MOCK_PORT);

    // ---------- C0 前置：登录（qaadmin 由 c-auth 套件保证存在；不存在则现场注册） ----------
    const auth = await registerOrLogin("qaadmin", "Passw0rd2026");
    assert.equal(auth.status, 200, `测试账号登录失败（c-auth 套件应先运行）：${auth.text.slice(0, 200)}`);
    const sessionCookie = extractSessionCookie(auth.setCookies);
    assert.ok(sessionCookie, "登录应下发会话 Cookie");
    console.log(`      登录身份: ${auth.body?.user?.username} (${auth.body?.user?.role})`);

    // ---------- A1 列表与 404 ----------
    await testCase("A1-1 GET /api/meetings 返回列表且字段完整", async () => {
        const res = await httpGet("/api/meetings");
        assert.equal(res.status, 200, `期望 200，实际 ${res.status}：${res.text.slice(0, 200)}`);
        assert.equal(res.body?.success, true, "success 字段应为 true");
        const list = res.body?.meetings;
        assert.ok(Array.isArray(list), "meetings 应为数组");
        assert.ok(list.length >= 4, `存量会议应 >= 4 条，实际 ${list.length}`);
        for (const m of list) {
            for (const key of ["id", "title", "createdAt"]) {
                assert.ok(m[key] !== undefined && m[key] !== null && m[key] !== "", `条目缺字段 ${key}`);
            }
        }
        console.log(`      当前列表条数: ${list.length}; 标题抽样: ${list.slice(0, 4).map((m) => m.title).join(" | ")}`);
    });

    await testCase("A1-2 GET /api/meetings?id=不存在 返回 404", async () => {
        const res = await httpGet("/api/meetings?id=qa-no-such-room-xyz");
        assert.equal(res.status, 404, `期望 404，实际 ${res.status}：${res.text.slice(0, 200)}`);
    });

    // ---------- A2 新建 → 查 → 改 → 查 → 删 → 404（走 summarize→saveMeeting 真实链路） ----------
    await testCase("A2-1 POST 经 /api/summarize 新建会议成功", async () => {
        const roomId = await createMeetingViaSummarize(MOCK_PORT);
        createdIds.push(roomId);
        console.log(`      新建 roomId: ${roomId}`);
    });

    let qaRoomId = createdIds[0];
    await testCase("A2-2 GET 可查到新建会议且标题正确", async () => {
        const res = await httpGet(`/api/meetings?id=${qaRoomId}`);
        assert.equal(res.status, 200, `期望 200，实际 ${res.status}`);
        assert.equal(res.body?.meeting?.title, "QA集成测试会议", `标题不符：${res.body?.meeting?.title}`);
        assert.equal(res.body?.meeting?.id, qaRoomId, "id 不符");
    });

    await testCase("A2-3 PATCH 修改 title 成功", async () => {
        const res = await httpPatch("/api/meetings", { id: qaRoomId, title: "QA集成测试会议-已改名" });
        assert.equal(res.status, 200, `期望 200，实际 ${res.status}：${res.text.slice(0, 200)}`);
    });

    await testCase("A2-4 GET 确认 title 已修改", async () => {
        const res = await httpGet(`/api/meetings?id=${qaRoomId}`);
        assert.equal(res.body?.meeting?.title, "QA集成测试会议-已改名", `标题不符：${res.body?.meeting?.title}`);
    });

    await testCase("A2-5 DELETE 删除会议成功", async () => {
        const res = await httpDelete(`/api/meetings?id=${qaRoomId}`);
        assert.equal(res.status, 200, `期望 200，实际 ${res.status}：${res.text.slice(0, 200)}`);
        createdIds.splice(createdIds.indexOf(qaRoomId), 1);
    });

    await testCase("A2-6 DELETE 后 GET 返回 404", async () => {
        const res = await httpGet(`/api/meetings?id=${qaRoomId}`);
        assert.equal(res.status, 404, `期望 404，实际 ${res.status}`);
    });

    // ---------- A3 并发混合压测 ----------
    await testCase("A3 5 个并发 PATCH/DELETE/新建混合请求无 500 且数据对账一致", async () => {
        // 准备：再建两个临时会议 M1（被删+被改）、M2（被改）
        const m1 = await createMeetingViaSummarize(MOCK_PORT, "-并发M1");
        const m2 = await createMeetingViaSummarize(MOCK_PORT, "-并发M2");
        createdIds.push(m1, m2);

        const before = await dbQuery("SELECT COUNT(*) AS c FROM meetings");
        const countBefore = before[0].c;

        // 5 个并发：2 新建 + 2 PATCH(同一行，制造写写竞争) + 1 DELETE
        const tasks = [
            createMeetingViaSummarize(MOCK_PORT, "-并发新建C1").then((id) => createdIds.push(id) && ({ tag: "createC1", status: 200 })),
            createMeetingViaSummarize(MOCK_PORT, "-并发新建C2").then((id) => createdIds.push(id) && ({ tag: "createC2", status: 200 })),
            httpPatch("/api/meetings", { id: m1, title: "QA并发改名-甲" }).then((r) => ({ tag: "patchM1-a", status: r.status, body: r.body })),
            httpPatch("/api/meetings", { id: m1, summary: "QA并发改摘要-乙" }).then((r) => ({ tag: "patchM1-b", status: r.status, body: r.body })),
            httpDelete(`/api/meetings?id=${m1}`).then((r) => ({ tag: "deleteM1", status: r.status, body: r.body })),
        ];
        const outcomes = await Promise.all(tasks);

        // 断言：无 500
        for (const o of outcomes) {
            assert.ok(o.status < 500, `并发请求 ${o.tag} 出现 500：${JSON.stringify(o.body ?? o).slice(0, 200)}`);
        }
        // PATCH/DELETE 对已删行的竞争返回 404 属预期；不允许其它非 2xx
        for (const o of outcomes) {
            if (o.tag.startsWith("patchM1") || o.tag === "deleteM1") {
                assert.ok([200, 404].includes(o.status), `并发请求 ${o.tag} 状态异常：${o.status}`);
            }
        }

        const after = await dbQuery("SELECT COUNT(*) AS c FROM meetings");
        const countAfter = after[0].c;
        // 新建 2 场（C1/C2），删除 1 场（M1），M2 保留 → countAfter = countBefore + 1
        assert.equal(countAfter, countBefore + 1, `对账失败：before=${countBefore} after=${countAfter}（期望 +1）`);

        // M2 必须仍存在且未被并发破坏
        const m2res = await httpGet(`/api/meetings?id=${m2}`);
        assert.equal(m2res.status, 200, "未参与删除的 M2 不应丢失");
        console.log(`      对账：before=${countBefore} after=${countAfter}（新建2 删除1）`);
    });

    // ---------- D3 result 页面 ----------
    await testCase("D3 /result/<真实roomId> 页面 HTTP 200（携带登录态）", async () => {
        const list = await httpGet("/api/meetings");
        const realId = list.body?.meetings?.[0]?.id;
        assert.ok(realId, "列表中无可用 roomId");
        const res = await fetch(`http://127.0.0.1:7200/result/${realId}`, {
            headers: { cookie: `ma_session=${sessionCookie}` },
        });
        const html = await res.text();
        assert.equal(res.status, 200, `期望 200，实际 ${res.status}`);
        assert.ok(html.length > 100, "result 页面内容为空，疑似渲染失败");
    });
} finally {
    // ---------- 清理：只删本脚本创建的会议 ----------
    for (const id of [...createdIds]) {
        const del = await httpDelete(`/api/meetings?id=${encodeURIComponent(id)}`);
        // 200 = 本次删除；404 = 已在用例中删除（如并发用例的 M1），同样视为清理成功
        const ok = del.status === 200 || del.status === 404;
        console.log(`清理 ${id}: ${ok ? "已删除" : `删除失败(status=${del.status})，请人工检查!`}`);
        if (ok) createdIds.splice(createdIds.indexOf(id), 1);
    }
    await closePool();
}

const ok = summary();
process.exit(ok ? 0 : 1);
