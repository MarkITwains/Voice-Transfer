/**
 * 自研图形验证码（零依赖，PRD R1/R2；Q1/Q4 定稿）
 *
 * - 生成：纯字符串拼 SVG——随机字符 <text>（随机旋转/基线/字号/颜色）
 *   + 随机贝塞尔干扰线 + 噪点；随机数全部来自 node:crypto
 * - 规格：5 位，字符集 = 数字+大写字母去混淆集（31 字符，去除 0/O/1/I/L），
 *   有效期 300s，校验大小写不敏感（统一 toUpperCase）
 * - 存储：内存 Map TTL 300s / 容量 2000，惰性清理（单实例自托管，重启清零属已知限制）
 * - 一次性语义（共享知识 8-2）：verifyCaptcha 先 pop 再比对——对错都作废，
 *   前端任何失败后必须重新 GET 换码
 * - 测试模式（共享知识 8-3）：QA_TEST_MODE=1 且 NODE_ENV!=="production" 双条件，
 *   才允许响应附带 debugCode；next start 生产被 NODE_ENV 硬门阻断
 */
import crypto from "crypto";

const CHARSET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 31 字符去混淆集
const CODE_LENGTH = 5;
const TTL_MS = 300_000; // 300s 有效期
const MAX_ENTRIES = 2000; // 内存容量上限，超限惰性清理

/** SVG 画布尺寸（前端按容器缩放渲染） */
const SVG_WIDTH = 150;
const SVG_HEIGHT = 44;

interface CaptchaEntry {
    code: string;
    expiresAt: number;
}

/** issueCaptcha 的返回契约（GET /api/auth/captcha 响应体） */
export interface CaptchaIssue {
    id: string;
    svg: string;
    expiresIn: number;
    /** 仅 QA_TEST_MODE=1 且非生产时返回（自动化测试识别明文） */
    debugCode?: string;
}

const store = new Map<string, CaptchaEntry>();

/** 测试模式双条件硬门：env 开关 + 非 production（next start 强制 NODE_ENV=production） */
export function isCaptchaTestMode(): boolean {
    return process.env.QA_TEST_MODE === "1" && process.env.NODE_ENV !== "production";
}

/** 惰性清理：先删过期项；仍超容量则按插入序删最旧（Map 保序） */
function prune(now: number): void {
    if (store.size <= MAX_ENTRIES) return;
    for (const [k, e] of store) {
        if (e.expiresAt <= now) store.delete(k);
    }
    while (store.size > MAX_ENTRIES) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
    }
}

/** 从字符集随机取一个字符（rejection-free：randomBytes 逐字节取模，31 非均匀偏差可忽略） */
function randomChar(): string {
    return CHARSET[crypto.randomBytes(1)[0] % CHARSET.length];
}

/** [min, max] 随机整数 */
function randInt(min: number, max: number): number {
    return min + (crypto.randomBytes(2).readUInt16BE(0) % (max - min + 1));
}

/** 随机柔和色（HSL → 兼容 SVG 的 hsl() 语法），偏深以保证可读 */
function randomColor(): string {
    const h = randInt(0, 360);
    const s = randInt(30, 60);
    const l = randInt(25, 45);
    return `hsl(${h}, ${s}%, ${l}%)`;
}

/** 生成一条随机贝塞尔干扰线 path 的 d 属性 */
function randomCurve(): string {
    const x1 = randInt(-10, 20);
    const y1 = randInt(5, SVG_HEIGHT - 5);
    const cx1 = randInt(20, SVG_WIDTH / 2);
    const cy1 = randInt(-10, SVG_HEIGHT + 10);
    const cx2 = randInt(SVG_WIDTH / 2, SVG_WIDTH - 20);
    const cy2 = randInt(-10, SVG_HEIGHT + 10);
    const x2 = randInt(SVG_WIDTH - 20, SVG_WIDTH + 10);
    const y2 = randInt(5, SVG_HEIGHT - 5);
    return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
}

/** 拼 SVG 字符串：背景 + 干扰线 + 噪点 + 扭曲字符 */
function buildSvg(code: string): string {
    const parts: string[] = [];
    // 背景（浅色，与字符深色对比）
    parts.push(`<rect x="0" y="0" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#f5f5f4"/>`);

    // 干扰线：3-4 条贝塞尔曲线
    const curveCount = randInt(3, 4);
    for (let i = 0; i < curveCount; i++) {
        parts.push(
            `<path d="${randomCurve()}" fill="none" stroke="${randomColor()}" stroke-width="${randInt(1, 2)}" opacity="0.55"/>`
        );
    }

    // 噪点：20 个随机小圆
    for (let i = 0; i < 20; i++) {
        parts.push(
            `<circle cx="${randInt(0, SVG_WIDTH)}" cy="${randInt(0, SVG_HEIGHT)}" r="${randInt(1, 2)}" fill="${randomColor()}" opacity="0.4"/>`
        );
    }

    // 字符：5 位，逐位随机旋转/基线抖动/字号/颜色
    const slot = SVG_WIDTH / (CODE_LENGTH + 1);
    for (let i = 0; i < code.length; i++) {
        const x = slot * (i + 1) + randInt(-4, 4);
        const y = SVG_HEIGHT / 2 + randInt(-4, 6); // 基线抖动
        const rotate = randInt(-25, 25);
        const fontSize = randInt(24, 32);
        const fontFamily = ["Georgia, serif", "Arial, sans-serif", "Courier New, monospace"][i % 3];
        parts.push(
            `<text x="${x}" y="${y}" font-size="${fontSize}" font-family="${fontFamily}" ` +
                `fill="${randomColor()}" font-weight="bold" ` +
                `transform="rotate(${rotate} ${x} ${y})" text-anchor="middle">${code[i]}</text>`
        );
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-label="验证码">${parts.join("")}</svg>`;
}

/**
 * 签发一张新验证码：生成 id + code + SVG 并写入内存存储。
 * @returns { id, svg, expiresIn(秒), debugCode? }
 */
export function issueCaptcha(): CaptchaIssue {
    const now = Date.now();
    prune(now);

    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += randomChar();
    const id = crypto.randomBytes(16).toString("hex"); // 32 字符，不可预测
    store.set(id, { code, expiresAt: now + TTL_MS });

    const issue: CaptchaIssue = {
        id,
        svg: buildSvg(code),
        expiresIn: Math.floor(TTL_MS / 1000),
    };
    if (isCaptchaTestMode()) {
        issue.debugCode = code;
    }
    return issue;
}

/**
 * 校验并一次性消费（共享知识 8-2）：先 pop 再比对——对错都作废。
 * @param id captchaId
 * @param input 用户输入（大小写不敏感，自动 trim + toUpperCase）
 */
export function verifyCaptcha(id: string, input: string): boolean {
    if (!id || !input) return false;
    const entry = store.get(id);
    store.delete(id); // 一次性语义：无论对错立即作废
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) return false; // 过期
    const normalized = input.trim().toUpperCase();
    if (normalized.length !== entry.code.length) return false;
    // 恒定时间比较，防时序侧信道
    return crypto.timingSafeEqual(Buffer.from(normalized), Buffer.from(entry.code));
}
