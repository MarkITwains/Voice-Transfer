"use client";

import { useEffect, useState } from "react";
import {
    loadSettings,
    persistSettings,
    clearApiSettings,
    gotoLoginOn401,
    type SettingsView,
} from "@/app/lib/settings";
import { validatePassword } from "@/app/lib/validation";

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSaved?: () => void;
    isRequiredPrompt?: boolean;
}

export default function SettingsModal({
    isOpen,
    onClose,
    onSaved,
    isRequiredPrompt = false,
}: SettingsModalProps) {
    if (!isOpen) return null;
    return (
        <SettingsDialog
            onClose={onClose}
            onSaved={onSaved}
            isRequiredPrompt={isRequiredPrompt}
        />
    );
}

function SettingsDialog({
    onClose,
    onSaved,
    isRequiredPrompt,
}: {
    onClose: () => void;
    onSaved?: () => void;
    isRequiredPrompt?: boolean;
}) {
    // 服务端脱敏视图（DB 为准；密钥只回显尾 4 位）
    const [view, setView] = useState<SettingsView | null>(null);
    const [loadError, setLoadError] = useState("");

    // 大模型配置
    const [llmBaseUrl, setLlmBaseUrl] = useState("");
    const [llmApiKey, setLlmApiKey] = useState("");
    const [llmModel, setLlmModel] = useState("");

    // 语音转写配置
    const [sameAsLlm, setSameAsLlm] = useState(false);
    const [asrBaseUrl, setAsrBaseUrl] = useState("");
    const [asrApiKey, setAsrApiKey] = useState("");
    const [asrModel, setAsrModel] = useState("");

    // 挂载时从服务端拉取脱敏设置
    useEffect(() => {
        let cancelled = false;
        loadSettings()
            .then((s) => {
                if (cancelled) return;
                setView(s);
                setLlmBaseUrl(s.llmBaseUrl || "");
                setLlmModel(s.llmModel || "");
                setAsrBaseUrl(s.asrBaseUrl || "");
                setAsrModel(s.asrModel || "");
                // 密钥框保持留空：留空 = 保留服务端旧值；placeholder 提示脱敏回显
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setLoadError(e instanceof Error ? e.message : "读取设置失败，请确认数据库服务已启动");
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // ESC 关闭 + 点击遮罩关闭（强制配置模式下不允许逃逸，须先完成保存）
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !isRequiredPrompt) onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [isRequiredPrompt, onClose]);

    // 显隐密码
    const [showLlmKey, setShowLlmKey] = useState(false);
    const [showAsrKey, setShowAsrKey] = useState(false);

    // 拉取模型列表状态
    const [fetchingLlmModels, setFetchingLlmModels] = useState(false);
    const [llmModelsList, setLlmModelsList] = useState<string[]>([]);
    const [llmFetchMsg, setLlmFetchMsg] = useState<{ success: boolean; text: string } | null>(null);

    const [fetchingAsrModels, setFetchingAsrModels] = useState(false);
    const [asrModelsList, setAsrModelsList] = useState<string[]>([]);
    const [asrFetchMsg, setAsrFetchMsg] = useState<{ success: boolean; text: string } | null>(null);

    const [savedNotice, setSavedNotice] = useState(false);
    const [saving, setSaving] = useState(false);

    // 修改密码（R13）
    const [oldPassword, setOldPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmNewPassword, setConfirmNewPassword] = useState("");
    const [pwdMsg, setPwdMsg] = useState<{ success: boolean; text: string } | null>(null);
    const [changingPwd, setChangingPwd] = useState(false);

    // 提交修改密码
    const handleChangePassword = async () => {
        setPwdMsg(null);
        if (!oldPassword) {
            setPwdMsg({ success: false, text: "请输入原密码" });
            return;
        }
        if (newPassword !== confirmNewPassword) {
            setPwdMsg({ success: false, text: "两次输入的新密码不一致" });
            return;
        }
        const pwdError = validatePassword(newPassword);
        if (pwdError) {
            setPwdMsg({ success: false, text: pwdError });
            return;
        }
        setChangingPwd(true);
        try {
            const res = await fetch("/api/auth/password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ oldPassword, newPassword }),
            });
            if (gotoLoginOn401(res.status)) return;
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                setPwdMsg({ success: false, text: data.error || "修改密码未成功" });
                return;
            }
            setPwdMsg({ success: true, text: data.message || "密码已修改，已退出所有设备上的旧会话" });
            setOldPassword("");
            setNewPassword("");
            setConfirmNewPassword("");
        } catch (e: unknown) {
            setPwdMsg({ success: false, text: e instanceof Error ? e.message : "网络错误" });
        } finally {
            setChangingPwd(false);
        }
    };

    // 常用提供方地址
    const PRESET_URLS = [
        { label: "DeepSeek", url: "https://api.deepseek.com", defaultModel: "deepseek-chat" },
        { label: "OpenAI", url: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
        { label: "通义千问", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus" },
        { label: "硅基流动", url: "https://api.siliconflow.cn/v1", defaultModel: "deepseek-ai/DeepSeek-V3" },
        { label: "月之暗面 (Kimi)", url: "https://api.moonshot.cn/v1", defaultModel: "moonshot-v1-8k" },
        { label: "本地 Ollama", url: "http://localhost:11434/v1", defaultModel: "qwen2.5:7b" },
    ];

    // 获取大模型列表（保存前测试刚输入的密钥，走 /api/models 请求体语义）
    const handleFetchLlmModels = async () => {
        if (!llmApiKey.trim()) {
            setLlmFetchMsg({ success: false, text: "请先填入接口密钥 (Key) 再获取模型列表" });
            return;
        }

        setFetchingLlmModels(true);
        setLlmFetchMsg(null);
        try {
            const res = await fetch("/api/models", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    baseURL: llmBaseUrl.trim() || "https://api.openai.com/v1",
                    apiKey: llmApiKey.trim(),
                }),
            });
            const data = await res.json();
            if (data.success && Array.isArray(data.models) && data.models.length > 0) {
                setLlmModelsList(data.models);
                setLlmFetchMsg({
                    success: true,
                    text: `已检索到 ${data.models.length} 个可用模型，请在下方选择`,
                });
                if (!llmModel) {
                    setLlmModel(data.models[0]);
                }
            } else {
                setLlmFetchMsg({
                    success: false,
                    text: data.error || "未检索到模型列表，请确认地址与密钥是否正确",
                });
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "网络错误";
            setLlmFetchMsg({ success: false, text: `拉取失败: ${msg}` });
        } finally {
            setFetchingLlmModels(false);
        }
    };

    // 获取 ASR 模型列表
    const handleFetchAsrModels = async () => {
        const key = sameAsLlm ? llmApiKey : asrApiKey;
        const url = sameAsLlm ? llmBaseUrl : asrBaseUrl;

        if (!key.trim()) {
            setAsrFetchMsg({ success: false, text: "请先填入转写接口密钥再获取" });
            return;
        }

        setFetchingAsrModels(true);
        setAsrFetchMsg(null);
        try {
            const res = await fetch("/api/models", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    baseURL: url.trim() || "https://api.siliconflow.cn/v1",
                    apiKey: key.trim(),
                }),
            });
            const data = await res.json();
            if (data.success && Array.isArray(data.models) && data.models.length > 0) {
                setAsrModelsList(data.models);
                setAsrFetchMsg({
                    success: true,
                    text: `已检索到 ${data.models.length} 个可用模型`,
                });
                if (!asrModel) {
                    setAsrModel(data.models[0]);
                }
            } else {
                setAsrFetchMsg({
                    success: false,
                    text: data.error || "获取失败，请确认地址与密钥",
                });
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "网络错误";
            setAsrFetchMsg({ success: false, text: `拉取失败: ${msg}` });
        } finally {
            setFetchingAsrModels(false);
        }
    };

    // 保存设置（走 PUT /api/settings；密钥框留空 = 保留服务端旧值）
    const handleSave = async () => {
        // 仅当服务端也没有密钥时才强制要求填写
        if (!llmApiKey.trim() && !view?.llmHasApiKey) {
            alert("请填写大语言模型接口密钥 (Key)");
            return;
        }

        setSaving(true);
        try {
            const saved = await persistSettings({
                llmBaseUrl: llmBaseUrl.trim() || "https://api.openai.com/v1",
                llmModel: llmModel.trim() || undefined,
                llmApiKey: llmApiKey.trim() || undefined,
                asrBaseUrl: (sameAsLlm ? llmBaseUrl : asrBaseUrl).trim() || undefined,
                asrApiKey: (sameAsLlm ? llmApiKey : asrApiKey).trim() || undefined,
                asrModel: asrModel.trim() || undefined,
            });
            setView(saved);
            setSavedNotice(true);
            onSaved?.();

            setTimeout(() => {
                setSavedNotice(false);
                onClose();
            }, 500);
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : "保存失败，请稍后再试");
        } finally {
            setSaving(false);
        }
    };

    // 清空配置：本地旧缓存 + 服务端密钥（显式清除）
    const handleClear = async () => {
        if (confirm("确定要清空已保存的接口设置吗？（将同时清除服务端密钥）")) {
            clearApiSettings();
            try {
                const saved = await persistSettings({
                    clearLlmApiKey: true,
                    clearAsrApiKey: true,
                    llmBaseUrl: "",
                    llmModel: "",
                    asrBaseUrl: "",
                    asrModel: "",
                });
                setView(saved);
            } catch {
                // 服务端清空失败时仅提示，不阻断本地清空
                alert("服务端设置清除未成功，请确认数据库服务后重试");
            }
            setLlmBaseUrl("");
            setLlmApiKey("");
            setLlmModel("");
            setAsrBaseUrl("");
            setAsrApiKey("");
            setAsrModel("");
            setLlmModelsList([]);
            setAsrModelsList([]);
            setLlmFetchMsg(null);
            setAsrFetchMsg(null);
            onSaved?.();
        }
    };

    // 显式清除单个密钥
    const handleClearLlmKey = async () => {
        try {
            const saved = await persistSettings({ clearLlmApiKey: true });
            setView(saved);
            setLlmApiKey("");
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : "清除密钥未成功");
        }
    };

    const handleClearAsrKey = async () => {
        try {
            const saved = await persistSettings({ clearAsrApiKey: true });
            setView(saved);
            setAsrApiKey("");
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : "清除密钥未成功");
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/50 backdrop-blur-xs animate-in fade-in duration-150"
            onClick={(e) => {
                if (e.target === e.currentTarget && !isRequiredPrompt) onClose();
            }}
        >
            <div className="relative w-full max-w-xl bg-white border border-stone-200 rounded-[2px] shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
                {/* 顶栏 */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200 bg-stone-50/70">
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-serif font-bold text-stone-900">
                                接口服务设置
                            </span>
                            {isRequiredPrompt && (
                                <span className="text-[11px] px-2 py-0.5 rounded-[2px] bg-stone-200 text-stone-800 font-medium">
                                    请先配置密钥
                                </span>
                            )}
                        </div>
                        <p className="text-xs text-stone-500 mt-0.5">
                            支持通用 OpenAI 规范接口 · 配置保存于本机服务端，密钥加密存储
                        </p>
                    </div>
                    {!isRequiredPrompt && (
                        <button
                            type="button"
                            onClick={onClose}
                            className="text-stone-400 hover:text-stone-700 w-7 h-7 flex items-center justify-center rounded-[2px] hover:bg-stone-200/50 text-xs"
                        >
                            ✕
                        </button>
                    )}
                </div>

                {/* 表单内容 */}
                <div className="p-6 overflow-y-auto space-y-6 text-xs sm:text-sm">
                    {/* 说明条 */}
                    <div className="p-3 bg-stone-50 border border-stone-200 rounded-[2px] flex items-start gap-2.5 text-xs text-stone-600 leading-relaxed">
                        <span className="w-1 h-3.5 bg-stone-800 shrink-0 mt-0.5" />
                        <div>
                            <span className="font-semibold text-stone-800">安全存储：</span>
                            配置保存于本机数据库，密钥经 AES-256-GCM 加密；密钥框留空表示保留已保存的密钥，不回传明文。
                        </div>
                    </div>

                    {loadError && (
                        <div className="p-3 bg-rose-50 border border-rose-200 rounded-[2px] text-xs text-rose-700 leading-relaxed">
                            ✕ {loadError}
                        </div>
                    )}

                    {/* 一、大模型文本服务设置 (必填) */}
                    <div className="p-4 rounded-[2px] border border-stone-200 bg-white space-y-3.5">
                        <div className="flex items-center justify-between border-b border-stone-100 pb-2">
                            <div className="flex items-center gap-2">
                                <span className="w-1.5 h-1.5 bg-stone-900 rounded-none" />
                                <h3 className="font-semibold text-stone-900 text-xs sm:text-sm">
                                    一、语言模型配置（用于纪要提炼、待办萃取与问答）
                                </h3>
                            </div>
                            <span className="text-[11px] text-stone-500 font-medium">必填</span>
                        </div>

                        {/* 快捷填入 */}
                        <div>
                            <span className="text-[11px] text-stone-400 block mb-1.5">
                                快捷选择常用服务地址：
                            </span>
                            <div className="flex flex-wrap gap-1.5">
                                {PRESET_URLS.map((item, idx) => (
                                    <button
                                        key={idx}
                                        type="button"
                                        onClick={() => {
                                            setLlmBaseUrl(item.url);
                                            if (!llmModel) setLlmModel(item.defaultModel);
                                        }}
                                        className="px-2 py-0.5 text-[11px] bg-stone-50 hover:bg-stone-100 text-stone-700 rounded-[2px] transition-colors border border-stone-200"
                                    >
                                        {item.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* 接口地址 */}
                        <div>
                            <label className="block text-xs font-medium text-stone-700 mb-1">
                                接口地址 (Base URL)
                            </label>
                            <input
                                type="text"
                                value={llmBaseUrl}
                                onChange={(e) => setLlmBaseUrl(e.target.value)}
                                placeholder="例如: https://api.deepseek.com 或 https://api.openai.com/v1"
                                className="w-full px-3 py-1.5 text-xs sm:text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 text-stone-800"
                            />
                        </div>

                        {/* API 密钥（留空 = 保留旧值） */}
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label className="block text-xs font-medium text-stone-700">
                                    接口密钥 (API Key)
                                </label>
                                {view?.llmHasApiKey && (
                                    <span className="text-[10px] text-stone-500 flex items-center gap-1.5">
                                        已保存: {view.llmApiKeyMasked || "****"}
                                        <button
                                            type="button"
                                            onClick={handleClearLlmKey}
                                            className="text-rose-500 hover:text-rose-700 underline"
                                        >
                                            清除
                                        </button>
                                    </span>
                                )}
                            </div>
                            <div className="relative">
                                <input
                                    type={showLlmKey ? "text" : "password"}
                                    value={llmApiKey}
                                    onChange={(e) => setLlmApiKey(e.target.value)}
                                    placeholder={view?.llmHasApiKey ? "留空则保留已保存的密钥" : "sk-..."}
                                    className="w-full px-3 py-1.5 text-xs sm:text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 pr-14 text-stone-800 font-mono"
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowLlmKey(!showLlmKey)}
                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700 text-xs"
                                >
                                    {showLlmKey ? "隐藏" : "显示"}
                                </button>
                            </div>
                        </div>

                        {/* 模型选择与获取 */}
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label className="text-xs font-medium text-stone-700">
                                    模型标识 (Model)
                                </label>
                                <button
                                    type="button"
                                    onClick={handleFetchLlmModels}
                                    disabled={fetchingLlmModels || !llmApiKey.trim()}
                                    className="text-xs text-stone-700 hover:text-stone-950 font-medium flex items-center gap-1 bg-stone-100 hover:bg-stone-200 px-2 py-0.5 rounded-[2px] border border-stone-200 transition-colors disabled:opacity-50"
                                >
                                    {fetchingLlmModels ? (
                                        <>
                                            <span className="inline-block w-2.5 h-2.5 border-2 border-stone-400 border-t-stone-800 rounded-full animate-spin" />
                                            <span>拉取中...</span>
                                        </>
                                    ) : (
                                        <span>获取模型列表</span>
                                    )}
                                </button>
                            </div>

                            <div className="space-y-1.5">
                                <input
                                    type="text"
                                    value={llmModel}
                                    onChange={(e) => setLlmModel(e.target.value)}
                                    placeholder="例如: deepseek-chat, gpt-4o-mini, qwen-plus"
                                    className="w-full px-3 py-1.5 text-xs sm:text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 text-stone-800"
                                />

                                {llmModelsList.length > 0 && (
                                    <div className="pt-1">
                                        <select
                                            value={llmModel}
                                            onChange={(e) => setLlmModel(e.target.value)}
                                            className="w-full px-3 py-1 text-xs bg-white border border-stone-300 rounded-[2px] text-stone-800 focus:outline-none focus:border-stone-800"
                                        >
                                            <option value="">-- 点选可用模型 --</option>
                                            {llmModelsList.map((m, i) => (
                                                <option key={i} value={m}>
                                                    {m}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>

                            {llmFetchMsg && (
                                <p
                                    className={`text-[11px] mt-1.5 ${
                                        llmFetchMsg.success ? "text-emerald-700 font-medium" : "text-rose-600"
                                    }`}
                                >
                                    {llmFetchMsg.success ? "✓ " : "✕ "}
                                    {llmFetchMsg.text}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* 二、语音转写服务设置 (选填) */}
                    <div className="p-4 rounded-[2px] border border-stone-200 bg-white space-y-3.5">
                        <div className="flex items-center justify-between border-b border-stone-100 pb-2">
                            <div className="flex items-center gap-2">
                                <span className="w-1.5 h-1.5 bg-stone-500 rounded-none" />
                                <h3 className="font-semibold text-stone-900 text-xs sm:text-sm">
                                    二、语音转写配置（仅在上传录音或现场收音时使用）
                                </h3>
                            </div>
                            <span className="text-[11px] text-stone-400">选填</span>
                        </div>

                        {/* 复用选择 */}
                        <label className="flex items-center gap-2 text-xs text-stone-700 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={sameAsLlm}
                                onChange={(e) => setSameAsLlm(e.target.checked)}
                                className="rounded-[2px] accent-stone-800 w-3.5 h-3.5 cursor-pointer"
                            />
                            <span>直接复用上方的大模型接口地址与密钥</span>
                        </label>

                        {!sameAsLlm && (
                            <>
                                <div>
                                    <label className="block text-xs font-medium text-stone-700 mb-1">
                                        转写接口地址 (ASR Base URL)
                                    </label>
                                    <input
                                        type="text"
                                        value={asrBaseUrl}
                                        onChange={(e) => setAsrBaseUrl(e.target.value)}
                                        placeholder="例如: https://api.siliconflow.cn/v1 或 https://api.openai.com/v1"
                                        className="w-full px-3 py-1.5 text-xs sm:text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 text-stone-800"
                                    />
                                </div>

                                <div>
                                    <div className="flex items-center justify-between mb-1">
                                        <label className="block text-xs font-medium text-stone-700">
                                            转写接口密钥
                                        </label>
                                        {view?.asrHasApiKey && (
                                            <span className="text-[10px] text-stone-500 flex items-center gap-1.5">
                                                已保存: {view.asrApiKeyMasked || "****"}
                                                <button
                                                    type="button"
                                                    onClick={handleClearAsrKey}
                                                    className="text-rose-500 hover:text-rose-700 underline"
                                                >
                                                    清除
                                                </button>
                                            </span>
                                        )}
                                    </div>
                                    <div className="relative">
                                        <input
                                            type={showAsrKey ? "text" : "password"}
                                            value={asrApiKey}
                                            onChange={(e) => setAsrApiKey(e.target.value)}
                                            placeholder={view?.asrHasApiKey ? "留空则保留已保存的密钥" : "sk-..."}
                                            className="w-full px-3 py-1.5 text-xs sm:text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 pr-14 text-stone-800 font-mono"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowAsrKey(!showAsrKey)}
                                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700 text-xs"
                                        >
                                            {showAsrKey ? "隐藏" : "显示"}
                                        </button>
                                    </div>
                                </div>
                            </>
                        )}

                        {/* 转写模型 */}
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label className="text-xs font-medium text-stone-700">
                                    转写模型标识 (ASR Model)
                                </label>
                                <button
                                    type="button"
                                    onClick={handleFetchAsrModels}
                                    disabled={fetchingAsrModels}
                                    className="text-xs text-stone-700 hover:text-stone-950 font-medium flex items-center gap-1 bg-stone-100 hover:bg-stone-200 px-2 py-0.5 rounded-[2px] border border-stone-200 transition-colors"
                                >
                                    {fetchingAsrModels ? "拉取中..." : "获取模型列表"}
                                </button>
                            </div>

                            <input
                                type="text"
                                value={asrModel}
                                onChange={(e) => setAsrModel(e.target.value)}
                                placeholder="如: whisper-1, FunAudioLLM/SenseVoiceSmall"
                                className="w-full px-3 py-1.5 text-xs sm:text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 text-stone-800"
                            />

                            {asrModelsList.length > 0 && (
                                <div className="pt-1">
                                    <select
                                        value={asrModel}
                                        onChange={(e) => setAsrModel(e.target.value)}
                                        className="w-full px-3 py-1 text-xs bg-white border border-stone-300 rounded-[2px] text-stone-800 focus:outline-none focus:border-stone-800"
                                    >
                                        <option value="">-- 选择转写模型 --</option>
                                        {asrModelsList.map((m, i) => (
                                            <option key={i} value={m}>
                                                {m}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {asrFetchMsg && (
                                <p
                                    className={`text-[11px] mt-1.5 ${
                                        asrFetchMsg.success ? "text-emerald-700 font-medium" : "text-rose-600"
                                    }`}
                                >
                                    {asrFetchMsg.success ? "✓ " : "✕ "}
                                    {asrFetchMsg.text}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* 三、账号设置（修改密码 R13） */}
                    <div className="p-4 rounded-[2px] border border-stone-200 bg-white space-y-3.5">
                        <div className="flex items-center justify-between border-b border-stone-100 pb-2">
                            <div className="flex items-center gap-2">
                                <span className="w-1.5 h-1.5 bg-stone-400 rounded-none" />
                                <h3 className="font-semibold text-stone-900 text-xs sm:text-sm">
                                    三、账号设置（修改密码）
                                </h3>
                            </div>
                            <span className="text-[11px] text-stone-400">改密后其他设备需重新登录</span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <input
                                type="password"
                                value={oldPassword}
                                onChange={(e) => setOldPassword(e.target.value)}
                                placeholder="原密码"
                                autoComplete="current-password"
                                className="w-full px-3 py-1.5 text-xs sm:text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 text-stone-800"
                            />
                            <input
                                type="password"
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                placeholder="新密码（≥8 位，含字母数字）"
                                autoComplete="new-password"
                                className="w-full px-3 py-1.5 text-xs sm:text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 text-stone-800"
                            />
                            <input
                                type="password"
                                value={confirmNewPassword}
                                onChange={(e) => setConfirmNewPassword(e.target.value)}
                                placeholder="确认新密码"
                                autoComplete="new-password"
                                className="w-full px-3 py-1.5 text-xs sm:text-sm bg-stone-50 border border-stone-300 rounded-[2px] focus:outline-none focus:border-stone-800 text-stone-800"
                            />
                        </div>

                        <div className="flex items-center justify-between">
                            {pwdMsg && (
                                <p className={`text-[11px] ${pwdMsg.success ? "text-emerald-700 font-medium" : "text-rose-600"}`}>
                                    {pwdMsg.success ? "✓ " : "✕ "}
                                    {pwdMsg.text}
                                </p>
                            )}
                            {!pwdMsg && <span />}
                            <button
                                type="button"
                                onClick={handleChangePassword}
                                disabled={changingPwd}
                                className="text-xs text-stone-700 hover:text-stone-950 font-medium flex items-center gap-1 bg-stone-100 hover:bg-stone-200 px-3 py-1 rounded-[2px] border border-stone-200 transition-colors disabled:opacity-50"
                            >
                                {changingPwd ? "提交中..." : "修改密码"}
                            </button>
                        </div>
                    </div>
                </div>

                {/* 底部操作 */}
                <div className="flex items-center justify-between px-6 py-3.5 border-t border-stone-200 bg-stone-50/50">
                    <button
                        type="button"
                        onClick={handleClear}
                        className="text-xs text-stone-500 hover:text-rose-600 transition-colors"
                    >
                        清空配置
                    </button>

                    <div className="flex items-center gap-2">
                        {!isRequiredPrompt && (
                            <button
                                type="button"
                                onClick={onClose}
                                className="px-3.5 py-1.5 text-xs font-medium text-stone-600 hover:text-stone-800 rounded-[2px] hover:bg-stone-200/50 transition-colors border border-transparent hover:border-stone-200"
                            >
                                稍后再设
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={saving}
                            className="px-5 py-1.5 text-xs font-semibold text-white bg-stone-900 hover:bg-stone-800 rounded-[2px] shadow-2xs transition-all disabled:opacity-50"
                        >
                            {savedNotice ? "✓ 已保存" : saving ? "保存中..." : "保存配置"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
