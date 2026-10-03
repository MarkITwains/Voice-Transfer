"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import CaptchaField from "@/app/components/CaptchaField";

/** 锁定倒计时剩余秒数格式化：X 分 Y 秒 */
function formatLockCountdown(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

export default function LoginPage() {
    const router = useRouter();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    // 自适应验证码（R4/R10）：默认隐藏；响应 requireCaptcha=true 时显示
    const [captchaRequired, setCaptchaRequired] = useState(false);
    const [captchaId, setCaptchaId] = useState("");
    const [captchaCode, setCaptchaCode] = useState("");
    const [captchaNonce, setCaptchaNonce] = useState(0); // bump = 换一张
    // 账号锁定倒计时（R11）：提示条展示剩余时间，不泄露内部状态
    const [lockRemaining, setLockRemaining] = useState(0);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const lockTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const locked = lockRemaining > 0;

    // 锁定倒计时：每秒递减，归零自动清除提示条。
    // 倒计时读写全部走函数式更新，故 effect 只依赖布尔量 locked，
    // 不会因每秒 setState 而反复重建 interval。
    useEffect(() => {
        if (!locked) {
            if (lockTimer.current) {
                clearInterval(lockTimer.current);
                lockTimer.current = null;
            }
            return;
        }
        lockTimer.current = setInterval(() => {
            setLockRemaining((s) => (s <= 1 ? 0 : s - 1));
        }, 1000);
        return () => {
            if (lockTimer.current) {
                clearInterval(lockTimer.current);
                lockTimer.current = null;
            }
        };
    }, [locked]);

    const refreshCaptcha = () => setCaptchaNonce((n) => n + 1);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLockRemaining(0);

        const payload: Record<string, string> = {
            username: username.trim(),
            password,
        };
        if (captchaRequired) {
            if (!captchaCode.trim()) {
                setError("请输入验证码");
                refreshCaptcha();
                return;
            }
            payload.captchaId = captchaId;
            payload.captchaCode = captchaCode.trim();
        }

        setLoading(true);
        try {
            const res = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                setError(data.error || "登录未成功，请稍后再试");
                // 自适应触发：响应要求验证码 → 展示验证码行并换新码
                if (data.requireCaptcha === true) {
                    setCaptchaRequired(true);
                    refreshCaptcha(); // 一次性语义：失败后必须换新码
                }
                // 账号锁定：展示倒计时提示条
                if (typeof data.lockedSeconds === "number" && data.lockedSeconds > 0) {
                    setLockRemaining(Math.min(data.lockedSeconds, 15 * 60));
                }
                return;
            }
            router.push("/");
            router.refresh();
        } catch {
            setError("网络异常，请稍后再试");
        } finally {
            setLoading(false);
        }
    };

    return (
        <main className="min-h-screen bg-stone-100/60 text-stone-800 flex items-center justify-center px-4 font-sans">
            <div className="w-full max-w-sm bg-white border border-stone-200 rounded-[2px] p-6 sm:p-7 shadow-2xs space-y-5">
                <div className="flex items-center gap-2.5 pb-3 border-b border-stone-200">
                    <div className="w-7 h-7 rounded-[2px] bg-stone-900 text-stone-100 flex items-center justify-center font-serif text-sm font-semibold">
                        言
                    </div>
                    <div>
                        <h1 className="text-sm font-serif font-bold text-stone-900">言简 · 会议纪要</h1>
                        <p className="text-[11px] text-stone-400">登录后开始整理你的会议备忘</p>
                    </div>
                </div>

                <form onSubmit={handleSubmit} className="space-y-3.5">
                    <div>
                        <label className="block text-xs font-medium text-stone-700 mb-1">用户名</label>
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder="用户名或邮箱"
                            autoComplete="username"
                            required
                            className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 text-stone-800"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-stone-700 mb-1">密码</label>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="密码"
                            autoComplete="current-password"
                            required
                            className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 text-stone-800"
                        />
                    </div>

                    {/* 自适应验证码行：失败 ≥2 次后由服务端响应触发显示 */}
                    {captchaRequired && (
                        <CaptchaField
                            code={captchaCode}
                            onCodeChange={setCaptchaCode}
                            onCaptchaIdChange={setCaptchaId}
                            refreshSignal={captchaNonce}
                        />
                    )}

                    {/* 锁定倒计时提示条（R11）：不泄露内部状态，仅展示剩余等待时间 */}
                    {lockRemaining > 0 && (
                        <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-[2px] text-xs text-amber-800 leading-relaxed">
                            <span className="shrink-0">⏳</span>
                            <span>
                                账号已临时锁定，请等待 <strong>{formatLockCountdown(lockRemaining)}</strong> 后重试
                            </span>
                        </div>
                    )}

                    {error && (
                        <p className="text-xs text-rose-600 leading-relaxed">✕ {error}</p>
                    )}

                    <button
                        type="submit"
                        disabled={loading || lockRemaining > 0}
                        className="w-full py-2.5 bg-stone-900 hover:bg-stone-800 active:bg-stone-950 disabled:opacity-50 text-stone-50 rounded-[2px] transition-all font-medium text-sm flex items-center justify-center gap-1.5"
                    >
                        {loading ? (
                            <>
                                <span className="inline-block w-3.5 h-3.5 border-2 border-stone-400 border-t-white rounded-full animate-spin" />
                                <span>登录中...</span>
                            </>
                        ) : (
                            "登 录"
                        )}
                    </button>
                </form>

                <p className="text-center text-xs text-stone-500">
                    还没有账号？
                    <Link href="/register" className="ml-1 text-stone-800 font-medium underline hover:text-stone-950">
                        注册新账号
                    </Link>
                </p>

                <p className="text-center text-[11px] text-stone-400 pt-0.5">
                    第一次使用？
                    <Link href="/help" className="ml-1 underline underline-offset-2 hover:text-stone-700 transition-colors">
                        查看使用说明
                    </Link>
                </p>
            </div>
        </main>
    );
}
