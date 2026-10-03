/**
 * 会话令牌签发/校验（自签名 HMAC Cookie，非 JWT 库）
 *
 * Token 格式：`v2.<base64url(JSON payload)>.<base64url(HMAC-SHA256 签名)>`
 * payload = { uid, un, role, ver, jti, iat, exp }
 *   // ver = users.token_version；jti = 会话标识（sessions 表 PK，服务端吊销载体）
 *
 * 铁律（共享知识 5 / 共享知识 8-1）：
 * - 本模块【禁止 import 任何 DB 模块】——proxy（体验闸门）与 Route Handler 共用，
 *   只做"签名 + 过期 + jti 存在性"的纯密码学校验；token_version 与 sessions 行核对
 *   在 app/lib/auth.ts（requireUser，users JOIN sessions 单查询）
 * - 签名密钥：AUTH_SECRET env 优先；缺省首次自动生成 64 字节随机数落盘 data/auth_secret
 * - 签名比较为恒定时间比较（timingSafeEqual）
 * - v1 → v2 前缀升级 = 存量 v1 Cookie 全部失效（部署后全员重新登录，已知一次性影响）
 */
import crypto from "crypto";

const TOKEN_PREFIX = "v2";
export const SESSION_COOKIE = "ma_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 3600; // 7 天绝对过期
/** 剩余有效期低于该值时，/api/auth/me 重签新 Cookie（滑动续期） */
export const RENEW_THRESHOLD_SECONDS = 3 * 24 * 3600;

const DATA_DIR = "data";

/** 会话 payload 契约（共享知识 8-1：缺 jti 一律校验失败） */
export interface SessionPayload {
    uid: number;
    un: string;
    role: string;
    ver: number;
    /** 会话标识 = crypto.randomBytes(16) hex，与 sessions.jti 一一对应 */
    jti: string;
    iat: number;
    exp: number;
}

/** signToken 的返回：token 下发 Cookie，jti 写入 sessions 表 */
export interface TokenWithJti {
    token: string;
    jti: string;
}

// ---------------- 签名密钥 ----------------

let cachedSecret: Buffer | undefined;

async function loadSecret(): Promise<Buffer> {
    if (cachedSecret) return cachedSecret;

    const envSecret = process.env.AUTH_SECRET;
    if (envSecret && envSecret.trim()) {
        cachedSecret = Buffer.from(envSecret.trim(), "utf-8");
        return cachedSecret;
    }

    // 缺省：读/生成 data/auth_secret（64 字节随机数 base64）
    const fs = await import("fs");
    const path = await import("path");
    const dataDir = path.join(process.cwd(), DATA_DIR);
    const secretFile = path.join(dataDir, "auth_secret");
    if (fs.existsSync(secretFile)) {
        const raw = fs.readFileSync(secretFile, "utf-8").trim();
        const buf = Buffer.from(raw, "base64");
        if (buf.length >= 32) {
            cachedSecret = buf;
            return cachedSecret;
        }
        throw new Error("data/auth_secret 格式非法（应为 ≥32 字节的 base64）");
    }
    const buf = crypto.randomBytes(64);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretFile, buf.toString("base64"), "utf-8");
    cachedSecret = buf;
    return cachedSecret;
}

// ---------------- base64url ----------------

function b64urlEncode(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

function b64urlDecode(s: string): Buffer {
    return Buffer.from(s, "base64url");
}

// ---------------- 签名 ----------------

/** 计算对 `${prefix}.${payloadB64}` 的 HMAC-SHA256 */
async function hmac(prefix: string, payloadB64: string): Promise<Buffer> {
    const secret = await loadSecret();
    return crypto.createHmac("sha256", secret).update(`${prefix}.${payloadB64}`).digest();
}

// ---------------- 对外 API ----------------

/**
 * 签发会话令牌（v2）：自动生成 jti（16 字节随机数 hex）。
 * @param base 身份字段（uid/un/role/ver）；iat/exp/jti 在此生成（每次登录全新 iat + 全新 jti）
 * @returns { token, jti } —— token 下发 Cookie；jti 必须同步写入 sessions 表
 */
export async function signToken(
    base: Pick<SessionPayload, "uid" | "un" | "role" | "ver">,
    ttlSeconds = SESSION_TTL_SECONDS
): Promise<TokenWithJti> {
    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
        ...base,
        uid: Number(base.uid),
        ver: Number(base.ver),
        jti: crypto.randomBytes(16).toString("hex"), // 32 字符，匹配 sessions.jti VARCHAR(32)
        iat: now,
        exp: now + ttlSeconds,
    };
    const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf-8"));
    const sig = await hmac(TOKEN_PREFIX, payloadB64);
    const token = `${TOKEN_PREFIX}.${payloadB64}.${b64urlEncode(sig)}`;
    return { token, jti: payload.jti };
}

/**
 * 校验令牌（纯密码学：签名 + 过期 + jti 存在；不查 DB）。
 * 返回 payload；任何一步不合法返回 null（含缺 jti 的 v1 旧 token / 手工构造 token）。
 */
export async function verifyToken(token: string | undefined | null): Promise<SessionPayload | null> {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;

    const [, payloadB64, sigB64] = parts;
    let expected: Buffer;
    try {
        expected = await hmac(TOKEN_PREFIX, payloadB64);
    } catch {
        return null;
    }
    const provided = b64urlDecode(sigB64);
    // 恒定时间比较：长度不等直接拒绝；等长用 timingSafeEqual
    if (provided.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(provided, expected)) return null;

    try {
        const payload = JSON.parse(b64urlDecode(payloadB64).toString("utf-8")) as SessionPayload;
        if (typeof payload.uid !== "number" || typeof payload.exp !== "number") return null;
        // v2 契约：缺 jti 一律拒绝（共享知识 8-1）
        if (typeof payload.jti !== "string" || payload.jti.length === 0) return null;
        if (payload.exp <= Math.floor(Date.now() / 1000)) return null; // 过期
        return payload;
    } catch {
        return null;
    }
}
