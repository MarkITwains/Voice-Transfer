"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { validateUsername, validatePassword } from "@/app/lib/validation";
import CaptchaField from "@/app/components/CaptchaField";

export default function RegisterPage() {
    const router = useRouter();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [captchaId, setCaptchaId] = useState("");
    const [captchaCode, setCaptchaCode] = useState("");
    const [captchaNonce, setCaptchaNonce] = useState(0); // bump = 换一张
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const refreshCaptcha = () => setCaptchaNonce((n) => n + 1);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        // 前端校验（与后端共用 validation.ts，共享知识 9）
        const usernameError = validateUsername(username.trim());
        if (usernameError) {
            setError(usernameError);
            return;
        }
        const passwordError = validatePassword(password);
        if (passwordError) {
            setError(passwordError);
            return;
        }
        if (password !== confirmPassword) {
            setError("两次输入的密码不一致");
            return;
        }
        if (!captchaCode.trim()) {
            setError("请输入验证码");
            refreshCaptcha();
            return;
        }

        setLoading(true);
        try {
            const res = await fetch("/api/auth/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    username: username.trim(),
                    password,
                    captchaId,
                    captchaCode: captchaCode.trim(),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                setError(data.error || "注册未成功，请稍后再试");
                // 验证码一次性语义：任何失败后必须换新码重试
                refreshCaptcha();
                return;
            }
            // 注册即登录，进入工作台
            router.push("/");
            router.refresh();
        } catch {
            setError("网络异常，请稍后再试");
            refreshCaptcha();
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
                        <h1 className="text-sm font-serif font-bold text-stone-900">创建新账号</h1>
                        <p className="text-[11px] text-stone-400">开放注册，首个注册用户将成为管理员</p>
                    </div>
                </div>

                <form onSubmit={handleSubmit} className="space-y-3.5">
                    <div>
                        <label className="block text-xs font-medium text-stone-700 mb-1">用户名</label>
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder="3-24 位字母、数字或下划线，或邮箱"
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
                            placeholder="至少 8 位，须包含字母和数字"
                            autoComplete="new-password"
                            required
                            className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 text-stone-800"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-stone-700 mb-1">确认密码</label>
                        <input
                            type="password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="再次输入密码"
                            autoComplete="new-password"
                            required
                            className="w-full px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 text-stone-800"
                        />
                    </div>

                    {/* 验证码行（注册必显，R3/R10） */}
                    <CaptchaField
                        code={captchaCode}
                        onCodeChange={setCaptchaCode}
                        onCaptchaIdChange={setCaptchaId}
                        refreshSignal={captchaNonce}
                    />

                    {error && (
                        <p className="text-xs text-rose-600 leading-relaxed">✕ {error}</p>
                    )}

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-2.5 bg-stone-900 hover:bg-stone-800 active:bg-stone-950 disabled:opacity-50 text-stone-50 rounded-[2px] transition-all font-medium text-sm flex items-center justify-center gap-1.5"
                    >
                        {loading ? (
                            <>
                                <span className="inline-block w-3.5 h-3.5 border-2 border-stone-400 border-t-white rounded-full animate-spin" />
                                <span>注册中...</span>
                            </>
                        ) : (
                            "注 册"
                        )}
                    </button>
                </form>

                <p className="text-center text-xs text-stone-500">
                    已有账号？
                    <Link href="/login" className="ml-1 text-stone-800 font-medium underline hover:text-stone-950">
                        直接登录
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
