/**
 * CI 集成回归编排：起 dev server → 等就绪 → 跑全量回归 → 回收进程。
 *
 * 目的：把「起服务 + 等就绪 + 跑测试」收敛到单个 Node 进程内，
 * 规避 GitHub Actions「每个 step 是独立 shell，后台进程不跨 step 存活」
 * 以及 bash 后台任务信号转发带来的不确定性。
 *
 * 用法（项目根目录）：
 *   node scripts/test/ci-integration.mjs
 *
 * 前置：MySQL(3306) 已就绪；.env.local 含 DATABASE_URL 与 QA_TEST_MODE=1。
 * 退出码：0 全部通过；1 服务起不来或有用例失败。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(import.meta.dirname, "../..");
const node = process.execPath;
const PORT = process.env.QA_PORT || "7200";
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = path.join(root, "scripts", "_ci_devserver.log");

const logStream = fs.createWriteStream(LOG, { flags: "w" });

// 自身诊断日志（同时写日志文件，便于 CI 失败时通过 artifact 取回）
const SELF_LOG = path.join(root, "scripts", "_ci_integration.log");
const selfStream = fs.createWriteStream(SELF_LOG, { flags: "w" });

function log(msg) {
    process.stdout.write(`${msg}\n`);
    selfStream.write(`${msg}\n`);
}

/** 轮询 /api/health 直到就绪或超时 */
async function waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) return true;
        } catch {
            /* 尚未就绪，继续等 */
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
}

/** 运行一个子进程并返回退出码 */
function runProcess(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd: root, stdio: "inherit", ...opts });
        child.on("exit", (code) => resolve(code ?? 1));
    });
}

// 1) 起 dev server（显式绑定 IPv4，避免 localhost→::1 的不一致）
//    直接用 node 执行 next 的 bin 脚本：绕开 npx（CI 上会尝试访问 registry，
//    既慢又可能在受限网络下失败），也绕开 npm 的信号转发损耗。
log("===== 启动 dev server =====");
const NEXT_BIN = path.join(root, "node_modules", "next", "dist", "bin", "next");
if (!fs.existsSync(NEXT_BIN)) {
    log(`::error::未找到 next 可执行文件：${NEXT_BIN}（请先 npm ci）`);
    process.exit(1);
}
const dev = spawn(
    node,
    [NEXT_BIN, "dev", "-H", "127.0.0.1", "-p", PORT],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
);

dev.stdout.pipe(logStream);
dev.stderr.pipe(logStream);

let devExited = false;
let devExitCode = null;
dev.on("exit", (code) => {
    devExited = true;
    devExitCode = code;
    log(`[dev] 进程退出，code=${code}`);
});

function shutdown() {
    if (!devExited) {
        log("[dev] 正在关闭 dev server...");
        try {
            dev.kill("SIGTERM");
        } catch {
            /* 已退出 */
        }
    }
}

// 任何异常退出都要回收 dev server
process.on("SIGINT", () => {
    shutdown();
    process.exit(1);
});
process.on("SIGTERM", () => {
    shutdown();
    process.exit(1);
});

// 2) 等就绪
log(`===== 等待 ${BASE}/api/health 就绪（上限 180s）=====`);
const ready = await waitReady(180_000);

if (!ready || devExited) {
    log("::error::dev server 未能就绪");
    log(`dev 日志（${LOG}）：`);
    try {
        log(fs.readFileSync(LOG, "utf-8"));
    } catch {
        log("（日志不可读）");
    }
    shutdown();
    process.exit(1);
}
log("dev server 已就绪");

// 3) 跑全量回归
log("===== 开始执行回归测试 =====");
const testCode = await runProcess(node, [path.join(root, "scripts/test/run-all.mjs")]);
log(`REGRESS_EXIT=${testCode}`);

// 4) 收尾
log("===== dev server 日志（尾部 40 行）=====");
try {
    const lines = fs.readFileSync(LOG, "utf-8").split("\n");
    log(lines.slice(-40).join("\n"));
} catch {
    /* ignore */
}

shutdown();
// 给进程一点时间优雅退出
await new Promise((r) => setTimeout(r, 500));
process.exit(testCode);
