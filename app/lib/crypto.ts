/**
 * AES-256-GCM 加解密（app_settings 密钥列专用）
 *
 * - 主密钥：32 字节随机数，base64 存于 `<项目>/.data/enc_key`，首次使用自动生成
 * - 密文格式：`v1:<iv_b64>:<tag_b64>:<cipher_b64>`
 * - 红线：密文只经本模块读写；任何 API 响应不得回传明文 apiKey
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".data");
const KEY_FILE = path.join(DATA_DIR, "enc_key");
const CIPHER_VERSION = "v1";

let cachedKey: Buffer | undefined;

/** 读取（或首次生成）主密钥 */
function getKey(): Buffer {
    if (cachedKey) return cachedKey;

    if (fs.existsSync(KEY_FILE)) {
        const raw = fs.readFileSync(KEY_FILE, "utf-8").trim();
        const key = Buffer.from(raw, "base64");
        if (key.length !== 32) {
            throw new Error(".data/enc_key 格式非法（应为 32 字节的 base64）");
        }
        cachedKey = key;
        return cachedKey;
    }

    // 首次生成：32 字节随机数
    const key = crypto.randomBytes(32);
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(KEY_FILE, key.toString("base64"), "utf-8");
    cachedKey = key;
    return cachedKey;
}

/** 加密明文 → `v1:<iv>:<tag>:<cipher>` */
export function encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
    const enc = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [CIPHER_VERSION, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

/** 解密 `v1:<iv>:<tag>:<cipher>` → 明文；格式非法返回空串（容错，不抛异常中断业务） */
export function decrypt(payload: string | null | undefined): string {
    if (!payload) return "";
    const parts = payload.split(":");
    if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) return "";
    try {
        const iv = Buffer.from(parts[1], "base64");
        const tag = Buffer.from(parts[2], "base64");
        const cipherText = Buffer.from(parts[3], "base64");
        const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString("utf-8");
    } catch (e) {
        console.warn("[crypto] 解密失败（密钥可能已更换）:", e instanceof Error ? e.message : e);
        return "";
    }
}

/**
 * 脱敏展示：保留尾部 4 位，如 `sk-****abcd`；不足 8 位视为敏感不回显，返回 null
 */
export function maskKey(plain: string | null | undefined): string | null {
    if (!plain) return null;
    if (plain.length < 8) return null;
    return `${plain.slice(0, 3)}****${plain.slice(-4)}`;
}
