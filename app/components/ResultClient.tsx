"use client";

import { useState } from "react";
import { gotoLoginOn401 } from "@/app/lib/settings";
import Link from "next/link";
import ModernExportWord from "./ModernExportWord";
import ExportCard from "./ExportCard";
import MeetingChat from "./MeetingChat";
import SettingsModal from "./SettingsModal";
import type { MeetingData, Todo } from "@/app/lib/types";

interface ResultClientProps {
    roomId: string;
    initialData: MeetingData;
}

export default function ResultClient({ roomId, initialData }: ResultClientProps) {
    const [data, setData] = useState<MeetingData>(initialData);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleInput, setTitleInput] = useState(initialData.title);

    const [isExportCardOpen, setIsExportCardOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [showTranscript, setShowTranscript] = useState(false);
    const [showChat, setShowChat] = useState(false);

    const [copySuccess, setCopySuccess] = useState(false);
    const [linkCopied, setLinkCopied] = useState(false);

    // 勾选待办状态同步到服务端持久层
    const handleToggleTodo = async (index: number) => {
        const nextTodos: Todo[] = [...(data.todos || [])];
        if (!nextTodos[index]) return;

        nextTodos[index] = {
            ...nextTodos[index],
            completed: !nextTodos[index].completed,
        };

        const updatedData = { ...data, todos: nextTodos };
        setData(updatedData);

        try {
            const res = await fetch("/api/meetings", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    id: roomId,
                    todos: nextTodos,
                }),
            });
            gotoLoginOn401(res.status); // 会话过期 → 跳登录页
        } catch (e) {
            console.error("更新待办状态失败:", e);
        }
    };

    // 保存标题修改
    const handleSaveTitle = async () => {
        if (!titleInput.trim() || titleInput.trim() === data.title) {
            setIsEditingTitle(false);
            return;
        }
        const updated = { ...data, title: titleInput.trim() };
        setData(updated);
        setIsEditingTitle(false);
        try {
            const res = await fetch("/api/meetings", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    id: roomId,
                    title: titleInput.trim(),
                }),
            });
            gotoLoginOn401(res.status); // 会话过期 → 跳登录页
        } catch (e) {
            console.error("更新标题失败:", e);
        }
    };

    // 一键复制微信/企微发送格式
    const handleCopyWeChatFormat = async () => {
        const dateStr = data.createdAt
            ? new Date(data.createdAt).toLocaleDateString("zh-CN", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
              })
            : "近期";

        const lines: string[] = [];
        lines.push(`【会议纪要】${data.title}`);
        lines.push(`时间：${dateStr} | 类型：${data.type || "例会"}`);
        lines.push("");

        lines.push("核心结论与决议：");
        const summaries = data.summary
            ? data.summary.split("；").map((s) => s.trim()).filter(Boolean)
            : [];
        summaries.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));

        if (data.todos && data.todos.length > 0) {
            lines.push("");
            lines.push("待办分工与推进：");
            data.todos.forEach((t) => {
                const assignee = t.assignee ? ` [@${t.assignee}]` : "";
                const deadline = t.deadline ? ` (截止: ${t.deadline})` : "";
                const check = t.completed ? "✓ [已办]" : "• [待办]";
                lines.push(`  ${check} ${t.content}${assignee}${deadline}`);
            });
        }

        if (data.mindmap && data.mindmap.length > 0) {
            lines.push("");
            lines.push("重点讨论议题：");
            data.mindmap.forEach((m) => {
                lines.push(`  • ${m.title}`);
                m.children?.forEach((c) => lines.push(`    - ${c}`));
            });
        }

        lines.push("");
        lines.push(`纪要链接：${window.location.href}`);

        try {
            await navigator.clipboard.writeText(lines.join("\n"));
            setCopySuccess(true);
            setTimeout(() => setCopySuccess(false), 2000);
        } catch {
            alert("复制失败，请手动选取文字复制");
        }
    };

    // 复制链接
    const handleCopyLink = () => {
        navigator.clipboard.writeText(window.location.href);
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2000);
    };

    const completedTodos = data.todos?.filter((t) => t.completed)?.length || 0;
    const totalTodos = data.todos?.length || 0;

    const formattedDate = data.createdAt
        ? new Date(data.createdAt).toLocaleDateString("zh-CN", {
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
          })
        : "";

    return (
        <main className="min-h-screen bg-stone-100/60 text-stone-800 py-5 sm:py-7 px-3 sm:px-4 font-sans selection:bg-stone-800 selection:text-white">
            <div className="max-w-4xl mx-auto space-y-4">
                {/* 顶栏导航 */}
                <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3.5 border-b border-stone-200">
                    <Link
                        href="/"
                        className="inline-flex items-center gap-1.5 text-xs text-stone-600 hover:text-stone-900 font-medium px-2.5 py-1.5 rounded-[2px] hover:bg-stone-200/60 transition-colors w-fit shrink-0"
                    >
                        <span>←</span>
                        <span>返回工作台</span>
                    </Link>

                    {/* 操作组：主行动（分发）｜分隔线｜工具 */}
                    <div className="flex items-center flex-wrap gap-1.5">
                        {/* 一键复制发群 */}
                        <button
                            type="button"
                            onClick={handleCopyWeChatFormat}
                            className="px-3.5 py-1.5 text-xs font-medium text-stone-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-[2px] shadow-2xs transition-colors flex items-center gap-1.5"
                        >
                            <svg className="w-3.5 h-3.5 text-stone-800" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>
                            <span>{copySuccess ? "✓ 已复制到剪贴板！" : "复制全文(直接发微信/企微)"}</span>
                        </button>

                        <span className="hidden sm:block w-px h-5 bg-stone-200 mx-0.5" aria-hidden />

                        {/* 导出 Word */}
                        <ModernExportWord
                            title={data.title}
                            summary={data.summary}
                            keyDecisions={data.keyDecisions}
                            todos={data.todos}
                            transcript={data.transcript}
                            type={data.type}
                            createdAt={data.createdAt}
                        />

                        {/* 纪要卡片 */}
                        <button
                            type="button"
                            onClick={() => setIsExportCardOpen(true)}
                            className="px-3 py-1.5 text-xs font-medium text-stone-700 bg-white hover:bg-stone-100 border border-stone-200 rounded-[2px] shadow-2xs transition-colors flex items-center gap-1.5"
                        >
                            <svg className="w-3.5 h-3.5 text-stone-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                            <span>生成卡片</span>
                        </button>

                        {/* 复制链接 */}
                        <button
                            type="button"
                            onClick={handleCopyLink}
                            className="px-3 py-1.5 text-xs font-medium text-stone-700 bg-white hover:bg-stone-100 border border-stone-200 rounded-[2px] shadow-2xs transition-colors flex items-center gap-1"
                        >
                            <svg className="w-3.5 h-3.5 text-stone-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                            <span>{linkCopied ? "已复制链接" : "分享"}</span>
                        </button>

                        <span className="hidden sm:block w-px h-5 bg-stone-200 mx-0.5" aria-hidden />

                        {/* API 设置 */}
                        <button
                            type="button"
                            onClick={() => setIsSettingsOpen(true)}
                            className="p-1.5 text-stone-600 hover:text-stone-900 bg-white hover:bg-stone-100 border border-stone-200 rounded-[2px] shadow-2xs transition-colors"
                            title="接口设置"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        </button>
                    </div>
                </header>

                {/* 纪要文档主体卡片 */}
                <div className="bg-white border border-stone-200 rounded-[2px] p-5 sm:p-8 shadow-2xs space-y-7">
                    {/* 会议标题区 */}
                    <div className="border-b border-stone-100 pb-5 space-y-2">
                        <div className="flex items-center gap-2">
                            <span className="text-xs px-2.5 py-0.5 rounded-full bg-stone-100 text-stone-700 font-medium">
                                {data.type || "日常例会"}
                            </span>
                            <span className="text-xs text-stone-400 font-mono">
                                {formattedDate}
                            </span>
                            {data.wordCount ? (
                                <span className="text-xs text-stone-400">
                                    · 约 {data.wordCount} 字记录
                                </span>
                            ) : null}
                        </div>

                        {/* 标题 */}
                        {isEditingTitle ? (
                            <div className="flex items-center gap-2 pt-1">
                                <input
                                    type="text"
                                    value={titleInput}
                                    onChange={(e) => setTitleInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") handleSaveTitle();
                                        if (e.key === "Escape") setIsEditingTitle(false);
                                    }}
                                    autoFocus
                                    className="text-xl sm:text-2xl font-bold text-stone-900 border-b-2 border-stone-800 outline-none pb-0.5 flex-1"
                                />
                                <button
                                    type="button"
                                    onClick={handleSaveTitle}
                                    className="px-3 py-1 text-xs bg-stone-900 text-white rounded-[2px] font-medium"
                                >
                                    保存
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setIsEditingTitle(false)}
                                    className="px-2 py-1 text-xs text-stone-500 hover:text-stone-800"
                                >
                                    取消
                                </button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2 group pt-1">
                                <h1 className="text-xl sm:text-2xl font-bold text-stone-900 tracking-tight">
                                    {data.title}
                                </h1>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setTitleInput(data.title);
                                        setIsEditingTitle(true);
                                    }}
                                    className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 text-stone-400 hover:text-stone-700 text-xs px-1.5 py-0.5 rounded-[2px] hover:bg-stone-100 transition-opacity"
                                    title="修改会议标题"
                                >
                                    ✎ 修改
                                </button>
                            </div>
                        )}
                    </div>

                    {/* 一、核心决议 */}
                    <section className="space-y-3">
                        <div className="flex items-center gap-2">
                            <span className="w-1.5 h-4 bg-amber-500 rounded-full" />
                            <h2 className="text-sm font-bold text-stone-900 tracking-wide uppercase">
                                一、会议核心结论与定案
                            </h2>
                        </div>
                        <div className="p-4 bg-amber-50/50 border border-amber-200/80 rounded-[2px] space-y-2">
                            {data.summary ? (
                                data.summary
                                    .split("；")
                                    .map((s) => s.trim())
                                    .filter(Boolean)
                                    .map((item, idx) => (
                                        <div key={idx} className="flex items-start gap-2.5 text-xs sm:text-sm text-stone-800 leading-relaxed">
                                            <span className="font-semibold text-amber-700 shrink-0 mt-0.5">
                                                {idx + 1}.
                                            </span>
                                            <span>{item}</span>
                                        </div>
                                    ))
                            ) : (
                                <p className="text-xs text-stone-400">暂无核心结论</p>
                            )}
                        </div>
                    </section>

                    {/* 二、待办分工 */}
                    <section className="space-y-3">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <span className="w-1.5 h-4 bg-emerald-600 rounded-full" />
                                <h2 className="text-sm font-bold text-stone-900 tracking-wide uppercase">
                                    二、待办事项与责任人
                                </h2>
                            </div>
                            {totalTodos > 0 && (
                                <span className="text-xs text-stone-500 font-medium">
                                    已完成 {completedTodos} / {totalTodos}
                                </span>
                            )}
                        </div>

                        {data.todos && data.todos.length > 0 ? (
                            <div className="space-y-2">
                                {data.todos.map((todo, idx) => (
                                    <div
                                        key={idx}
                                        onClick={() => handleToggleTodo(idx)}
                                        className={`p-3.5 rounded-[2px] border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                                            todo.completed
                                                ? "bg-stone-50 border-stone-200 text-stone-400 line-through"
                                                : "bg-white border-stone-200 hover:border-stone-400 text-stone-800 shadow-2xs"
                                        }`}
                                    >
                                        <div className="flex items-center gap-3 overflow-hidden">
                                            <input
                                                type="checkbox"
                                                checked={Boolean(todo.completed)}
                                                onChange={() => {}}
                                                className="w-4 h-4 rounded-[2px] accent-stone-900 cursor-pointer shrink-0"
                                            />
                                            <span className="text-xs sm:text-sm leading-relaxed">
                                                {todo.content}
                                            </span>
                                        </div>

                                        <div className="flex items-center gap-2 shrink-0 text-xs">
                                            {todo.assignee && (
                                                <span className="px-2 py-0.5 rounded-full bg-stone-100 text-stone-700 font-medium">
                                                    负责人: {todo.assignee}
                                                </span>
                                            )}
                                            {todo.deadline && (
                                                <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 text-[11px] font-mono">
                                                    截止: {todo.deadline}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="text-xs text-stone-400 p-3 bg-stone-50 rounded-[2px]">
                                会议中未提及明确的分工待办
                            </p>
                        )}
                    </section>

                    {/* 三、重点议题 */}
                    {data.mindmap && data.mindmap.length > 0 && (
                        <section className="space-y-3">
                            <div className="flex items-center gap-2">
                                <span className="w-1.5 h-4 bg-stone-700 rounded-full" />
                                <h2 className="text-sm font-bold text-stone-900 tracking-wide uppercase">
                                    三、具体讨论议题与发言记录
                                </h2>
                            </div>

                            <div className="space-y-3">
                                {data.mindmap.map((item, idx) => (
                                    <div
                                        key={idx}
                                        className="p-4 rounded-[2px] border border-stone-200 bg-stone-50/40 space-y-2"
                                    >
                                        <h3 className="text-xs sm:text-sm font-semibold text-stone-800 flex items-center gap-2">
                                            <span className="w-5 h-5 rounded-[2px] bg-stone-200 text-stone-700 text-xs flex items-center justify-center font-bold">
                                                {idx + 1}
                                            </span>
                                            <span>{item.title}</span>
                                        </h3>
                                        {item.children && item.children.length > 0 && (
                                            <ul className="pl-7 space-y-1.5 text-xs text-stone-600 list-disc">
                                                {item.children.map((point, pIdx) => (
                                                    <li key={pIdx} className="leading-relaxed">
                                                        {point}
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* 四、注意事项 */}
                    {data.risks && data.risks.length > 0 && (
                        <section className="space-y-3">
                            <div className="flex items-center gap-2">
                                <span className="w-1.5 h-4 bg-rose-500 rounded-full" />
                                <h2 className="text-sm font-bold text-stone-900 tracking-wide uppercase">
                                    四、注意事项与潜在风险
                                </h2>
                            </div>
                            <div className="p-3.5 bg-rose-50/60 border border-rose-200 rounded-[2px] space-y-1.5">
                                {data.risks.map((r, idx) => (
                                    <div key={idx} className="flex items-start gap-2 text-xs text-rose-800 leading-relaxed">
                                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0 mt-1.5" />
                                        <span>{r}</span>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* 五、完整发言速记 */}
                    <section className="pt-2 border-t border-stone-100">
                        <button
                            type="button"
                            onClick={() => setShowTranscript(!showTranscript)}
                            className="w-full py-2.5 px-4 bg-stone-100 hover:bg-stone-200/70 text-stone-700 rounded-[2px] text-xs font-medium flex items-center justify-between transition-colors"
                        >
                            <span>查阅发言速记全文 ({data.transcript?.length || 0} 字符)</span>
                            <span>{showTranscript ? "收起 ▲" : "展开 ▼"}</span>
                        </button>

                        {showTranscript && (
                            <div className="mt-3 p-4 bg-stone-50 border border-stone-200 rounded-[2px] text-xs text-stone-700 leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto font-mono">
                                {data.transcript || "无完整速记记录"}
                            </div>
                        )}
                    </section>

                    {/* 六、问答助手 */}
                    <section className="pt-2 border-t border-stone-100">
                        <button
                            type="button"
                            onClick={() => setShowChat(!showChat)}
                            className="w-full py-2.5 px-4 bg-stone-900 hover:bg-stone-800 text-white rounded-[2px] text-xs font-medium flex items-center justify-between transition-colors shadow-2xs"
                        >
                            <span>对本次会议有疑问？向纪要助手提问</span>
                            <span>{showChat ? "收起提问栏 ▲" : "展开提问栏 ▼"}</span>
                        </button>

                        {showChat && (
                            <div className="mt-3">
                                <MeetingChat
                                    roomId={roomId}
                                    meetingTitle={data.title}
                                />
                            </div>
                        )}
                    </section>
                </div>
            </div>

            {/* 导出卡片弹窗 */}
            <ExportCard
                data={data}
                isOpen={isExportCardOpen}
                onClose={() => setIsExportCardOpen(false)}
            />

            {/* API 设置弹窗 */}
            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
            />
        </main>
    );
}
