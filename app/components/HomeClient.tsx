"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ModernAudioUpload from "./ModernAudioUpload";
import ModernRecorder from "./ModernRecorder";
import SettingsModal from "./SettingsModal";
import { initSettingsSync, loadSettings, gotoLoginOn401 } from "@/app/lib/settings";

interface HistoryItem {
    id: string;
    title: string;
    type?: string;
    summary: string;
    createdAt: string;
    duration?: string;
    todoCount?: number;
    wordCount?: number;
}

const SAMPLE_TRANSCRIPT = `
【时间】：2026年9月28日 下午14:30
【主持】：林若愚（出版总监）
【参会】：苏青（装帧设计师）、陈默（编辑部主任）、陆文（印务主管）

林若愚：今天我们敲定《江南造物志》十周年精装典藏版的付印细节。青青，封面装帧和用纸打样出来了么？
苏青：打样已经出来了。封面选用的是天然本色亚麻布烫暗金，书名用古活字拓片原样压凹，质感温润素朴。内文用纸反复对比后，选用了80克纯质樱花微涂纸，显色沉着，翻页时手感柔软挺括，长时间翻阅不刺眼。
陈默：编辑部这边，三校和名家序言的排版昨天已经全部核对无误。附录里增加了二十幅手绘工艺分解图，图注和生僻字注音也都一一校正过了，随时可以下厂。
陆文：印务这边配合做过了网点承印测试。全书四色加专金印刷，为了保证暗色调插图的层次，我们会在周三上午安排去印刷厂现场看色跟单。
林若愚：非常好，明确三项安排：
1. 苏青在周二下午下班前，向印务提供最终的装帧工艺参数表与烫金版菲林；
2. 陆文负责在周三上午10点协调工厂进行首次上机试印，苏青与陈默一同到厂看样确认；
3. 陈默周五前整理好新书宣发文案与图册，供展会与读书会使用。
`.trim();

export default function HomeClient() {
    const router = useRouter();

    const [mode, setMode] = useState<"text" | "audio" | "record">("text");
    const [text, setText] = useState("");
    const [audioFile, setAudioFile] = useState<File | null>(null);
    const [style, setStyle] = useState<"standard" | "standup" | "brainstorm" | "business">("standard");

    const [loading, setLoading] = useState(false);
    const [loadingStep, setLoadingStep] = useState("");
    const [progress, setProgress] = useState(0);

    // API 配置状态
    const [settingsState, setSettingsState] = useState({ hasKey: false, model: "" });

    // 当前登录用户（顶栏身份展示 + 登出）
    const [currentUser, setCurrentUser] = useState<{ username: string; role: string } | null>(null);

    // 设置弹窗
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    useEffect(() => {
        let cancelled = false;
        // 1) 确认登录身份（proxy 已把未登录访客重定向，这里兜底处理 401）
        fetch("/api/auth/me")
            .then(async (res) => {
                if (gotoLoginOn401(res.status)) return null;
                const data = await res.json().catch(() => ({}));
                if (cancelled) return null;
                setCurrentUser(data?.user ?? null);
                return data?.user ?? null;
            })
            .then((user) => {
                if (cancelled || !user) return null;
                // 2) 已登录：首访一次性上报本地旧配置（幂等、静默失败），随后拉取脱敏状态
                return initSettingsSync().finally(() => {
                    if (cancelled) return;
                    loadSettings()
                        .then((s) => {
                            if (cancelled) return;
                            setSettingsState({
                                hasKey: s.llmHasApiKey,
                                model: s.llmModel || "",
                            });
                        })
                        .catch((e: unknown) => {
                            // DB 不可用时给出明确提示（R8），不阻断首屏
                            console.error("读取服务端设置失败:", e);
                            setSettingsState({ hasKey: false, model: "" });
                        });
                });
            })
            .catch((e: unknown) => {
                console.error("确认登录状态失败:", e);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // 登出：调 API 清 Cookie 后回登录页
    const handleLogout = async () => {
        try {
            await fetch("/api/auth/logout", { method: "POST" });
        } catch {
            // 网络异常也照常跳转（Cookie 由服务端清除失败时会话仍在，但登录页可重新登录）
        }
        window.location.href = "/login";
    };

    // 历史纪要抽屉
    const [isHistoryOpen, setIsHistoryOpen] = useState(false);
    const [historyList, setHistoryList] = useState<HistoryItem[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);

    // 检查并更新配置状态（异步读服务端）
    const refreshSettingsStatus = () => {
        loadSettings(true)
            .then((s) => {
                setSettingsState({
                    hasKey: s.llmHasApiKey,
                    model: s.llmModel || "",
                });
            })
            .catch((e: unknown) => {
                console.error("刷新设置状态失败:", e);
                setSettingsState({ hasKey: false, model: "" });
            });
    };

    // 加载历史纪要
    const fetchHistory = async () => {
        setLoadingHistory(true);
        try {
            const res = await fetch("/api/meetings?limit=25");
            if (gotoLoginOn401(res.status)) return;
            const data = await res.json();
            if (data.meetings) {
                setHistoryList(data.meetings);
            }
        } catch (e) {
            console.error("加载历史记录失败:", e);
        } finally {
            setLoadingHistory(false);
        }
    };

    const handleOpenHistory = () => {
        setIsHistoryOpen(true);
        fetchHistory();
    };

    // 历史抽屉打开时支持 ESC 关闭
    useEffect(() => {
        if (!isHistoryOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setIsHistoryOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [isHistoryOpen]);

    const handleDeleteHistory = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!confirm("确定删除此篇纪要备忘吗？")) return;
        try {
            await fetch(`/api/meetings?id=${id}`, { method: "DELETE" }).then((res) => {
                if (gotoLoginOn401(res.status)) throw new Error("unauthorized");
            });
            setHistoryList((prev) => prev.filter((m) => m.id !== id));
        } catch (e) {
            if (e instanceof Error && e.message === "unauthorized") return;
            alert("删除未成功，请稍后再试");
        }
    };

    // 填入演示范本
    const fillSample = () => {
        setText(SAMPLE_TRANSCRIPT);
        setMode("text");
    };

    // 提交处理
    const handleSubmit = async () => {
        // 配置在服务端 DB，读取脱敏视图判断是否已配置密钥
        let hasKey = false;
        let asrReady = true;
        try {
            const s = await loadSettings();
            hasKey = s.llmHasApiKey;
            asrReady = s.asrHasApiKey;
        } catch {
            alert("读取接口设置失败，请确认本机数据库服务已启动");
            return;
        }

        // 未配置 Key，直接弹出设置
        if (!hasKey) {
            setIsSettingsOpen(true);
            return;
        }

        if (mode === "text" && !text.trim()) {
            alert("请先输入或粘贴发言速记，亦可点击「填入纪要范本」快速体验");
            return;
        }

        if (mode !== "text" && !audioFile) {
            alert("请先选择或录制一段会议音频");
            return;
        }

        // 音频模式检查转写 Key
        if (mode !== "text" && !asrReady) {
            alert("使用录音转写前，请在「接口设置」中填入语音转写密钥");
            setIsSettingsOpen(true);
            return;
        }

        setLoading(true);
        setProgress(20);
        setLoadingStep("正在整理速记素材...");

        try {
            let finalText = text;

            // 音频模式先转写
            if (mode !== "text" && audioFile) {
                setProgress(45);
                setLoadingStep("正在将录音音频转写为文本实录...");

                const fd = new FormData();
                fd.append("file", audioFile);

                const transcribeRes = await fetch("/api/transcribe", {
                    method: "POST",
                    body: fd,
                });
                if (gotoLoginOn401(transcribeRes.status)) {
                    setLoading(false);
                    return;
                }

                const transcribeData = await transcribeRes.json().catch(() => ({}));
                if (!transcribeRes.ok || !transcribeData.text) {
                    throw new Error(transcribeData.error || "语音转写未成功，请检查接口设置中的转写地址与模型");
                }

                finalText = transcribeData.text;
            }

            // 提炼整理
            setProgress(75);
            setLoadingStep("正在梳理核心决议与待办分工...");

            const summarizeRes = await fetch("/api/summarize", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    rawText: finalText,
                    style,
                }),
            });
            if (gotoLoginOn401(summarizeRes.status)) {
                setLoading(false);
                return;
            }

            const summarizeData = await summarizeRes.json();
            if (!summarizeRes.ok || !summarizeData.roomId) {
                throw new Error(summarizeData.error || "纪要整理失败，请检查接口设置");
            }

            setProgress(100);
            setLoadingStep("纪要提炼完成，即将呈现...");

            setTimeout(() => {
                router.push(`/result/${summarizeData.roomId}`);
            }, 300);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "请求未成功";
            alert(`整理中断：${msg}`);
            setLoading(false);
        }
    };

    return (
        <main className="min-h-screen bg-stone-100/60 text-stone-800 flex flex-col items-center justify-start py-5 sm:py-7 px-3 sm:px-4 font-sans selection:bg-stone-800 selection:text-white">
            <div className="w-full max-w-3xl mx-auto space-y-3">
                {/* 顶栏 */}
                <header className="flex items-center justify-between pb-2.5 border-b border-stone-200">
                    <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-[2px] bg-stone-900 text-stone-100 flex items-center justify-center font-serif text-sm font-semibold shadow-2xs">
                            言
                        </div>
                        <div className="flex items-baseline gap-2">
                            <h1 className="text-sm sm:text-base font-serif font-bold text-stone-900 tracking-tight whitespace-nowrap">
                                言简 · 会议纪要
                            </h1>
                            <span className="text-[11px] text-stone-400 font-normal hidden md:inline whitespace-nowrap">
                                去芜存菁，静心备忘
                            </span>
                        </div>
                    </div>

                    <div className="flex items-center justify-end flex-wrap gap-1.5">
                        {/* 登录身份 + 登出（R12） */}
                        {currentUser && (
                            <div className="flex items-center gap-1.5 mr-0.5">
                                <span
                                    className="text-[11px] text-stone-600 font-medium px-1.5 py-1 bg-stone-100 border border-stone-200 rounded-[2px] flex items-center gap-1"
                                    title={currentUser.role === "admin" ? "管理员" : "已登录"}
                                >
                                    <svg className="w-3 h-3 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                    </svg>
                                    <span className="hidden sm:inline max-w-[10em] truncate">{currentUser.username}</span>
                                    {currentUser.role === "admin" && (
                                        <span className="text-[9px] text-amber-700 bg-amber-50 border border-amber-200 px-1 rounded-[2px]">admin</span>
                                    )}
                                </span>
                                <button
                                    type="button"
                                    onClick={handleLogout}
                                    className="px-2 py-1 text-xs font-medium text-stone-500 hover:text-stone-800 bg-white hover:bg-stone-100 border border-stone-200 rounded-[2px] shadow-2xs transition-colors"
                                >
                                    登出
                                </button>
                            </div>
                        )}

                        {/* 历史记录按钮 */}
                        <button
                            type="button"
                            onClick={handleOpenHistory}
                            className="px-2.5 py-1 text-xs font-medium text-stone-700 bg-white hover:bg-stone-100 border border-stone-200 rounded-[2px] shadow-2xs transition-colors flex items-center gap-1"
                            title="历史纪要"
                        >
                            <svg className="w-3.5 h-3.5 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <span className="hidden sm:inline">历史纪要</span>
                        </button>

                        {/* 使用说明入口 */}
                        <Link
                            href="/help"
                            className="px-2.5 py-1 text-xs font-medium text-stone-700 bg-white hover:bg-stone-100 border border-stone-200 rounded-[2px] shadow-2xs transition-colors flex items-center gap-1"
                            title="使用说明"
                        >
                            <svg className="w-3.5 h-3.5 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <span className="hidden sm:inline">使用说明</span>
                        </Link>

                        {/* 接口设置按钮 */}
                        <button
                            type="button"
                            onClick={() => setIsSettingsOpen(true)}
                            className="relative px-2.5 py-1 text-xs font-medium text-stone-700 bg-white hover:bg-stone-100 border border-stone-200 rounded-[2px] shadow-2xs transition-colors flex items-center gap-1"
                        >
                            <svg className="w-3.5 h-3.5 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                            <span className="hidden sm:inline">接口设置</span>
                            {settingsState.hasKey ? (
                                <span
                                    className="w-1.5 h-1.5 rounded-none bg-emerald-600 inline-block"
                                    title={`已配置: ${settingsState.model || "自定义模型"}`}
                                />
                            ) : (
                                <span
                                    className="text-[10px] text-stone-500 font-normal px-1 rounded-[2px] bg-stone-100 border border-stone-200"
                                    title="点击配置模型密钥"
                                >
                                    待配置
                                </span>
                            )}
                        </button>
                    </div>
                </header>

                {/* 待配置提示横幅 */}
                {!settingsState.hasKey && (
                    <div
                        onClick={() => setIsSettingsOpen(true)}
                        className="p-2 px-3 bg-stone-200/60 border border-stone-300 rounded-[2px] flex items-center justify-between text-[11px] text-stone-700 cursor-pointer hover:bg-stone-200 transition-colors"
                    >
                        <div className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-none bg-amber-600 shrink-0" />
                            <span>尚未配置模型密钥，点击可快捷填入您的 API 地址与模型标识</span>
                        </div>
                        <span className="font-medium underline shrink-0 ml-2">前往配置 →</span>
                    </div>
                )}

                {/* 主操作卡片 */}
                <div className="bg-white border border-stone-200 rounded-[2px] p-4 sm:p-5 shadow-2xs space-y-3.5">
                    {/* 录入模式切换 */}
                    <div className="flex items-center justify-between">
                        <div className="inline-flex p-0.5 bg-stone-100 border border-stone-200 rounded-[2px]">
                            <button
                                type="button"
                                onClick={() => setMode("text")}
                                disabled={loading}
                                className={`px-3 py-1 text-xs font-medium rounded-[2px] transition-all ${
                                    mode === "text"
                                        ? "bg-white text-stone-900 shadow-2xs"
                                        : "text-stone-500 hover:text-stone-800"
                                }`}
                            >
                                文字实录
                            </button>
                            <button
                                type="button"
                                onClick={() => setMode("audio")}
                                disabled={loading}
                                className={`px-3 py-1 text-xs font-medium rounded-[2px] transition-all ${
                                    mode === "audio"
                                        ? "bg-white text-stone-900 shadow-2xs"
                                        : "text-stone-500 hover:text-stone-800"
                                }`}
                            >
                                音频转写
                            </button>
                            <button
                                type="button"
                                onClick={() => setMode("record")}
                                disabled={loading}
                                className={`px-3 py-1 text-xs font-medium rounded-[2px] transition-all ${
                                    mode === "record"
                                        ? "bg-white text-stone-900 shadow-2xs"
                                        : "text-stone-500 hover:text-stone-800"
                                }`}
                            >
                                现场收音
                            </button>
                        </div>

                        {mode === "text" && (
                            <button
                                type="button"
                                onClick={fillSample}
                                className="text-[11px] text-stone-400 hover:text-stone-700 underline transition-colors"
                            >
                                填入纪要范本
                            </button>
                        )}
                    </div>

                    {/* 研讨场景侧重 */}
                    <div className="space-y-1.5">
                        <label className="text-[11px] font-medium text-stone-500 block">
                            研讨场景侧重：
                        </label>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                            {[
                                { key: "standard", label: "工作例会", desc: "同步进展与定案" },
                                { key: "standup", label: "日常同步", desc: "速览近况与卡点" },
                                { key: "brainstorm", label: "专题研讨", desc: "梳理观点与分歧" },
                                { key: "business", label: "商务商谈", desc: "记录诉求与承诺" },
                            ].map((item) => (
                                <button
                                    key={item.key}
                                    type="button"
                                    onClick={() => setStyle(item.key as typeof style)}
                                    disabled={loading}
                                    className={`p-2 rounded-[2px] border text-left transition-all ${
                                        style === item.key
                                            ? "border-stone-900 bg-stone-900 text-stone-50 shadow-2xs"
                                            : "border-stone-200 bg-stone-50/50 hover:border-stone-300 text-stone-700"
                                    }`}
                                >
                                    <div className="text-xs font-medium leading-none">{item.label}</div>
                                    <div
                                        className={`text-[10px] mt-1 leading-tight ${
                                            style === item.key ? "text-stone-300" : "text-stone-400"
                                        }`}
                                    >
                                        {item.desc}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* 录入主体 */}
                    <div>
                        {mode === "text" && (
                            <div className="relative">
                                <textarea
                                    value={text}
                                    onChange={(e) => setText(e.target.value)}
                                    disabled={loading}
                                    placeholder="在此输入或粘贴会议发言速记、讨论提纲（至少5字）...&#10;支持多轮发言、问答、议题记录，系统将提炼核心结论与待办分工。"
                                    className="w-full h-44 sm:h-48 p-3 text-xs sm:text-sm bg-stone-50/40 border border-stone-200 rounded-[2px] focus:outline-none focus:border-stone-700 focus:bg-white text-stone-800 placeholder-stone-400 leading-relaxed font-sans transition-colors resize-y"
                                />
                                <div className="absolute right-2.5 bottom-2 text-[10px] text-stone-400 font-mono">
                                    {text.length} 字
                                </div>
                            </div>
                        )}

                        {mode === "audio" && (
                            <ModernAudioUpload
                                audioFile={audioFile}
                                onFileChange={setAudioFile}
                            />
                        )}

                        {mode === "record" && (
                            <ModernRecorder
                                onRecorded={(file) => {
                                    setAudioFile(file);
                                    setMode("audio");
                                }}
                            />
                        )}
                    </div>

                    {/* 进度条 */}
                    {loading && (
                        <div className="p-2.5 bg-stone-100 rounded-[2px] space-y-1.5 animate-in fade-in">
                            <div className="flex justify-between text-[11px] text-stone-700 font-medium">
                                <span>{loadingStep}</span>
                                <span className="font-mono">{progress}%</span>
                            </div>
                            <div className="w-full h-1 bg-stone-200 rounded-none overflow-hidden">
                                <div
                                    className="h-full bg-stone-800 transition-all duration-300 ease-out"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                        </div>
                    )}

                    {/* 提交按钮 */}
                    <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={loading}
                        className="w-full py-2.5 bg-stone-900 hover:bg-stone-800 active:bg-stone-950 disabled:opacity-50 text-stone-50 rounded-[2px] shadow-2xs transition-all font-medium text-xs sm:text-sm flex items-center justify-center gap-1.5"
                    >
                        {loading ? (
                            <>
                                <span className="inline-block w-3.5 h-3.5 border-2 border-stone-400 border-t-white rounded-full animate-spin" />
                                <span>正在静心梳理...</span>
                            </>
                        ) : (
                            <>
                                <span>梳理会议备忘</span>
                                <span>→</span>
                            </>
                        )}
                    </button>
                </div>

                {/* 页脚 */}
                <footer className="pt-1 text-center text-[11px] text-stone-400">
                    言简 · 会议纪要整理工作台 · 去芜存菁，省心备忘
                </footer>
            </div>

            {/* 设置模态框 */}
            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
                onSaved={refreshSettingsStatus}
            />

            {/* 历史会议侧边抽屉 */}
            {isHistoryOpen && (
                <div
                    className="fixed inset-0 z-50 flex justify-end bg-stone-900/40 backdrop-blur-2xs animate-in fade-in duration-150"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) setIsHistoryOpen(false);
                    }}
                >
                    <div className="w-full max-w-md bg-white h-full shadow-2xl flex flex-col border-l border-stone-200 animate-in slide-in-from-right duration-200">
                        {/* 抽屉顶栏 */}
                        <div className="flex items-center justify-between px-5 py-3.5 border-b border-stone-200 bg-stone-50/70">
                            <div className="flex items-center gap-2">
                                <h3 className="font-serif font-bold text-stone-900 text-xs sm:text-sm">
                                    历史纪要备忘
                                </h3>
                                <span className="text-[11px] text-stone-400">
                                    共 {historyList.length} 篇
                                </span>
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsHistoryOpen(false)}
                                className="w-6 h-6 flex items-center justify-center rounded-[2px] text-stone-400 hover:text-stone-700 hover:bg-stone-100 text-xs"
                            >
                                ✕
                            </button>
                        </div>

                        {/* 抽屉列表 */}
                        <div className="flex-1 overflow-y-auto p-3.5 space-y-2">
                            {loadingHistory ? (
                                <div className="py-12 text-center text-xs text-stone-400">
                                    正在调取历史存档...
                                </div>
                            ) : historyList.length === 0 ? (
                                <div className="py-12 text-center text-xs text-stone-400 space-y-1">
                                    <p>暂无历史纪要</p>
                                    <p className="text-[11px] text-stone-300">整理完成后的会议将自动留存于此</p>
                                </div>
                            ) : (
                                historyList.map((item) => (
                                    <div
                                        key={item.id}
                                        onClick={() => {
                                            setIsHistoryOpen(false);
                                            router.push(`/result/${item.id}`);
                                        }}
                                        className="p-3 bg-white border border-stone-200 rounded-[2px] hover:border-stone-400 cursor-pointer shadow-2xs transition-all group"
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <h4 className="text-xs font-semibold text-stone-900 group-hover:text-stone-950 line-clamp-1">
                                                {item.title}
                                            </h4>
                                            <button
                                                type="button"
                                                onClick={(e) => handleDeleteHistory(item.id, e)}
                                                className="text-stone-300 hover:text-rose-600 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 text-xs"
                                                title="删除"
                                            >
                                                ✕
                                            </button>
                                        </div>

                                        {item.summary && (
                                            <p className="text-[11px] text-stone-500 line-clamp-2 mt-1 leading-relaxed">
                                                {item.summary}
                                            </p>
                                        )}

                                        <div className="flex items-center justify-between text-[10px] text-stone-400 mt-2 pt-1.5 border-t border-stone-100">
                                            <span>
                                                {new Date(item.createdAt).toLocaleDateString("zh-CN", {
                                                    month: "numeric",
                                                    day: "numeric",
                                                    hour: "2-digit",
                                                    minute: "2-digit",
                                                })}
                                            </span>
                                            <div className="flex items-center gap-1.5">
                                                {item.type && (
                                                    <span className="px-1.5 py-0.2 rounded-[2px] bg-stone-100 text-stone-600 text-[10px]">
                                                        {item.type}
                                                    </span>
                                                )}
                                                {typeof item.todoCount === "number" && (
                                                    <span>{item.todoCount} 项待办</span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}
        </main>
    );
}
