"use client";

/**
 * 验证码行组件（PRD R10/R5）：验证码图 + "看不清？换一张" 刷新按钮 + 输入框。
 *
 * - 图片经 dangerouslySetInnerHTML 渲染服务端拼装的 SVG（零 <img> 请求，同源内联）
 * - 挂载时与 refreshSignal 变化时自动 GET /api/auth/captcha 换新码；
 *   父组件在"校验失败"后 bump refreshSignal 即可实现自动换码（一次性语义）
 * - 换新码后自动清空输入框并回传新 captchaId
 */
import { useCallback, useEffect, useState } from "react";

interface CaptchaFieldProps {
    /** 用户输入的验证码（受控） */
    code: string;
    onCodeChange: (code: string) => void;
    /** 新验证码的 id 回传给父组件（随请求体提交） */
    onCaptchaIdChange: (id: string) => void;
    /** 父组件 bump 该值（+1）即触发换一张（如校验失败后自动换码） */
    refreshSignal: number;
}

export default function CaptchaField({
    code,
    onCodeChange,
    onCaptchaIdChange,
    refreshSignal,
}: CaptchaFieldProps) {
    const [svg, setSvg] = useState("");
    const [loading, setLoading] = useState(false);
    const [nonce, setNonce] = useState(0);

    const refresh = useCallback(() => setNonce((n) => n + 1), []);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetch("/api/auth/captcha")
            .then((r) => r.json())
            .then((d: { captchaId?: string; svg?: string }) => {
                if (cancelled) return;
                setSvg(d.svg || "");
                onCaptchaIdChange(d.captchaId || "");
                onCodeChange(""); // 换新码后清空旧输入
            })
            .catch(() => {
                if (cancelled) return;
                setSvg("");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nonce, refreshSignal]);

    return (
        <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">验证码</label>
            <div className="flex items-stretch gap-2">
                <div
                    className="w-[130px] h-10 shrink-0 bg-stone-100 border border-stone-300 rounded-[2px] overflow-hidden flex items-center justify-center select-none"
                    aria-label="验证码图片"
                >
                    {svg ? (
                        <div
                            className="w-full h-full [&>svg]:w-full [&>svg]:h-full"
                            dangerouslySetInnerHTML={{ __html: svg }}
                        />
                    ) : (
                        <span className="text-[11px] text-stone-400">
                            {loading ? "加载中..." : "加载失败"}
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={refresh}
                    disabled={loading}
                    className="shrink-0 px-2 text-[11px] text-stone-600 hover:text-stone-900 border border-stone-300 rounded-[2px] hover:bg-stone-100 transition-colors disabled:opacity-50"
                    title="换一张新验证码"
                >
                    换一张
                </button>
                <input
                    type="text"
                    value={code}
                    onChange={(e) => onCodeChange(e.target.value)}
                    placeholder="输入图中字符"
                    autoComplete="off"
                    maxLength={5}
                    required
                    className="w-full min-w-0 px-3 py-2 text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 text-stone-800 tracking-widest uppercase"
                />
            </div>
        </div>
    );
}
