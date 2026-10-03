"use client";

import { useState, useRef, useEffect } from "react";
import type { MeetingData } from "@/app/lib/types";

interface ExportCardProps {
    data: MeetingData;
    isOpen: boolean;
    onClose: () => void;
}

export default function ExportCard({ data, isOpen, onClose }: ExportCardProps) {
    const cardRef = useRef<HTMLDivElement>(null);
    const [copied, setCopied] = useState(false);

    // ESC / 遮罩关闭（hooks 须在下方 early return 之前声明）
    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const formattedDate = data.createdAt
        ? new Date(data.createdAt).toLocaleDateString("zh-CN", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
          })
        : "近期";

    const summaries = data.summary
        ? data.summary.split("；").map((s) => s.trim()).filter(Boolean)
        : [];

    const handleCopySummary = () => {
        const text = [
            `【${data.title}】`,
            `日期：${formattedDate} | 类型：${data.type || "工作例会"}`,
            "",
            "一、核心结论与决议：",
            ...(summaries.length ? summaries.map((s, i) => `  ${i + 1}. ${s}`) : ["  暂无主要结论"]),
            "",
            "二、待办事项与分工：",
            ...(data.todos && data.todos.length
                ? data.todos.map((t) => `  - [${t.completed ? "x" : " "}] ${t.content}${t.assignee ? ` (@${t.assignee})` : ""}`)
                : ["  暂无明确待办"]),
        ].join("\n");

        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-950/50 backdrop-blur-xs"
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="bg-white rounded-[2px] shadow-2xl max-w-lg w-full overflow-hidden border border-stone-200 animate-in fade-in zoom-in-95 duration-200">
                {/* 顶栏控制 */}
                <div className="flex items-center justify-between px-6 py-3.5 border-b border-stone-200 bg-stone-50/60">
                    <span className="text-xs font-semibold text-stone-700 tracking-wider">
                        纪要便签预览
                    </span>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-stone-400 hover:text-stone-700 text-xs p-1 rounded-[2px] hover:bg-stone-200/50 transition"
                    >
                        ✕
                    </button>
                </div>

                {/* 卡片实体 */}
                <div className="p-6 overflow-y-auto max-h-[75vh]">
                    <div
                        ref={cardRef}
                        className="bg-stone-50/50 border border-stone-200 rounded-[2px] p-6 shadow-2xs space-y-5"
                    >
                        {/* 头部 */}
                        <div className="space-y-1.5 pb-4 border-b border-stone-200">
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] font-medium px-2 py-0.5 rounded-[2px] bg-stone-900 text-white">
                                    {data.type || "工作例会"}
                                </span>
                                <span className="text-xs text-stone-400 font-mono">{formattedDate}</span>
                            </div>
                            <h3 className="text-base sm:text-lg font-serif font-bold text-stone-900 pt-1 leading-snug">
                                {data.title}
                            </h3>
                        </div>

                        {/* 核心决议 */}
                        <div className="space-y-2">
                            <div className="text-xs font-bold text-stone-700 uppercase tracking-wider flex items-center gap-1.5">
                                <span className="w-1 h-3 bg-stone-800" />
                                核心结论
                            </div>
                            <div className="space-y-1.5 bg-white p-3.5 rounded-[2px] border border-stone-200 text-xs text-stone-700 leading-relaxed">
                                {summaries.length > 0 ? (
                                    summaries.map((s, idx) => (
                                        <div key={idx} className="flex items-start gap-1.5">
                                            <span className="text-stone-400 shrink-0 font-medium">
                                                {idx + 1}.
                                            </span>
                                            <span>{s}</span>
                                        </div>
                                    ))
                                ) : (
                                    <p className="text-stone-400 italic">暂无核心结论</p>
                                )}
                            </div>
                        </div>

                        {/* 重点待办 */}
                        {data.todos && data.todos.length > 0 && (
                            <div className="space-y-2">
                                <div className="text-xs font-bold text-stone-700 uppercase tracking-wider flex items-center gap-1.5">
                                    <span className="w-1 h-3 bg-stone-800" />
                                    待办执行清单
                                </div>
                                <div className="space-y-1.5 bg-white p-3.5 rounded-[2px] border border-stone-200 text-xs text-stone-800">
                                    {data.todos.slice(0, 5).map((t, idx) => (
                                        <div key={idx} className="flex items-start gap-2">
                                            <span className="text-stone-500 font-mono shrink-0">
                                                {t.completed ? "✓" : "•"}
                                            </span>
                                            <span className={t.completed ? "line-through text-stone-400" : ""}>
                                                {t.content}
                                                {t.assignee && (
                                                    <span className="ml-1 text-stone-500 font-medium">
                                                        @{t.assignee}
                                                    </span>
                                                )}
                                            </span>
                                        </div>
                                    ))}
                                    {data.todos.length > 5 && (
                                        <div className="text-[11px] text-stone-400 pt-1 pl-3">
                                            另有 {data.todos.length - 5} 项后续待办...
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* 底部水印信息 */}
                        <div className="pt-2 flex items-center justify-between text-[11px] text-stone-400 border-t border-stone-200">
                            <span>言简 · 会议纪要备忘</span>
                            <span>{data.wordCount ? `${data.wordCount} 字速记` : "会议备忘"}</span>
                        </div>
                    </div>
                </div>

                {/* 底部按钮栏 */}
                <div className="flex items-center justify-end gap-2.5 px-6 py-3 bg-stone-50 border-t border-stone-200">
                    <button
                        type="button"
                        onClick={handleCopySummary}
                        className="px-3.5 py-1.5 bg-stone-900 hover:bg-stone-800 text-white rounded-[2px] text-xs font-medium transition shadow-2xs"
                    >
                        {copied ? "已复制便签文本" : "复制便签文本"}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-3.5 py-1.5 bg-white hover:bg-stone-100 text-stone-700 border border-stone-200 rounded-[2px] text-xs font-medium transition"
                    >
                        关闭
                    </button>
                </div>
            </div>
        </div>
    );
}
