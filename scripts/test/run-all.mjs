/**
 * 一键回归：依次执行 C（认证/隔离/限速）→ D（凭证深度）→ A（会议 CRUD/并发）→
 *           B（设置同步/脱敏/密文落库）→ E（验证码）→ F（安全强化）。
 *
 * 用法（托管 node，项目根目录下，先 export CODEBUDDY_SAFE_DELETE_ENABLED=0）：
 *   C:\Users\wjy13\.workbuddy\binaries\node\versions\22.22.2-3\node.exe scripts/test/run-all.mjs
 *
 * 前置：dev server(7200) 与 MySQL(3306) 运行中；.env.local 含 QA_TEST_MODE=1（E 组依赖 debugCode）。
 * 注意：D(停 DB 降级) 属于破坏性/编排型用例，请按 QA 报告中的手工步骤执行，不在本脚本内自动化。
 */
import { spawn } from "node:child_process";
import path from "node:path";

const node = process.execPath;
const dir = import.meta.dirname;

function run(file) {
    return new Promise((resolve) => {
        const child = spawn(node, [path.join(dir, file)], { stdio: "inherit" });
        child.on("exit", (code) => resolve(code));
    });
}

// C 必须最先跑：注册/保证 qaadmin 等账号存在，A/B 依赖其登录态账号
const codeC = await run("c-auth.test.mjs");
const codeD = await run("d-auth-deep.test.mjs");
const codeA = await run("a-meetings.test.mjs");
const codeB = await run("b-settings.test.mjs");
const codeE = await run("e-captcha.test.mjs");
const codeF = await run("f-security.test.mjs");
const codeG = await run("g-qa-verdict.test.mjs"); // G：QA 验收专项（真机链路/DB 直查证据）
process.exit(
    codeC === 0 && codeD === 0 && codeA === 0 && codeB === 0 && codeE === 0 && codeF === 0 && codeG === 0 ? 0 : 1
);
