/**
 * 校验规则唯一来源（共享知识 9：前后端 import 同一份，禁止另写正则）
 *
 * - 密码：8–64 位，须同时含字母 [A-Za-z] 与数字 \d
 * - 用户名：3–24 位字母数字下划线，或合法邮箱格式（为未来邮箱验证预留）
 * - 校验函数返回 null 表示通过，否则返回面向用户的中文错误信息
 */

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 64;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,24}$/;
const EMAIL_PATTERN = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$/;

/** 校验密码强度；通过返回 null，否则返回错误信息 */
export function validatePassword(password: unknown): string | null {
    if (typeof password !== "string" || !password) {
        return "请输入密码";
    }
    if (password.length < PASSWORD_MIN) {
        return `密码至少 ${PASSWORD_MIN} 位`;
    }
    if (password.length > PASSWORD_MAX) {
        return `密码最多 ${PASSWORD_MAX} 位`;
    }
    if (!/[A-Za-z]/.test(password)) {
        return "密码须同时包含字母和数字";
    }
    if (!/\d/.test(password)) {
        return "密码须同时包含字母和数字";
    }
    return null;
}

/** 校验用户名（普通格式或邮箱）；通过返回 null，否则返回错误信息 */
export function validateUsername(username: unknown): string | null {
    if (typeof username !== "string" || !username.trim()) {
        return "请输入用户名";
    }
    const name = username.trim();
    if (USERNAME_PATTERN.test(name)) return null;
    if (EMAIL_PATTERN.test(name)) return null;
    return "用户名需为 3-24 位字母、数字或下划线，或合法邮箱地址";
}
