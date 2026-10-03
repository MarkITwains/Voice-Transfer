/**
 * 内存固定窗口限速器（共享知识 10：仅 auth 类接口使用；单实例自托管，重启清零属已知限制）
 *
 * - Map<key, {count, windowStart}>；条目数超过 500 时惰性清理过期项
 * - hit() 命中则计数 +1 并判定是否放行；clear() 用于成功登录后清零失败计数
 */

interface Bucket {
    count: number;
    windowStart: number;
}

const store = new Map<string, Bucket>();
const MAX_ENTRIES = 500;

export interface RateLimitResult {
    allowed: boolean;
    /** 距离窗口重置的秒数（429 响应可提示） */
    retryAfterSeconds: number;
}

/**
 * 计数并判定：窗口内未超限返回 allowed=true（并计数）；超限返回 allowed=false。
 * @param key 限速键（如 login:<ip>:<username>）
 * @param limit 窗口内允许次数
 * @param windowMs 窗口毫秒数
 */
export function hit(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = Date.now();

    if (store.size > MAX_ENTRIES) {
        // 惰性清理过期条目
        for (const [k, b] of store) {
            if (now - b.windowStart > windowMs) store.delete(k);
        }
    }

    const bucket = store.get(key);
    if (!bucket || now - bucket.windowStart > windowMs) {
        store.set(key, { count: 1, windowStart: now });
        return { allowed: true, retryAfterSeconds: 0 };
    }

    bucket.count += 1;
    if (bucket.count > limit) {
        return {
            allowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000)),
        };
    }
    return { allowed: true, retryAfterSeconds: 0 };
}

/** 清零某个键（成功登录后清失败计数） */
export function clear(key: string): void {
    store.delete(key);
}
