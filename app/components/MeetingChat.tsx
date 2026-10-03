"use client";

import { useState, useRef, useEffect } from "react";
import { gotoLoginOn401 } from "@/app/lib/settings";

interface Message {
    role: "user" | "assistant";
    content: string;
}

interface MeetingChatProps {
    roomId: string;
    meetingTitle?: string;
}

export default function MeetingChat({ roomId }: MeetingChatProps) {
    const [messages, setMessages] = useState<Message[]>([
        {
            role: "assistant",
            content: "您好。关于本次会议的讨论细节、决议分歧或具体待办安排，您可以随时向我提问。",
        },
    ]);
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState("");
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, loading]);

    const handleSend = async (questionText?: string) => {
        const query = (questionText || input).trim();
        if (!query || loading) return;

        setInput("");
        setErrorMsg("");

        const newMessages: Message[] = [...messages, { role: "user", content: query }];
        setMessages(newMessages);
        setLoading(true);

        try {
            // 服务端从 DB 读取配置，前端无需发送 x-* 配置头
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    roomId,
                    question: query,
                    messages: newMessages.slice(-6),
                }),
            });

            const data = await res.json();
            if (gotoLoginOn401(res.status)) return; // 会话过期 → 跳登录页
            if (!res.ok || data.error) {
                throw new Error(data.error || "问答请求未成功");
            }

            setMessages((prev) => [
                ...prev,
                { role: "assistant", content: data.reply || "收到，但未返回内容。" },
            ]);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "请求出错";
            setErrorMsg(msg);
            setMessages((prev) => [
                ...prev,
                {
                    role: "assistant",
                    content: `未能完成回答：${msg}。如尚未配置大模型接口密钥，请点击右上角「设置」完成填写。`,
                },
            ]);
        } finally {
            setLoading(false);
        }
    };

    const QUICK_QUESTIONS = [
        "会议敲定了哪些关键结论？",
        "参会人员分别承担哪些后续安排？",
        "有哪些需要关注的事项或风险？",
    ];

    return (
        <div className="bg-stone-50 border border-stone-200 rounded-[2px] p-4 sm:p-5 space-y-4">
            {/* 推荐问题 */}
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-stone-500 font-medium">推荐提问：</span>
                {QUICK_QUESTIONS.map((q, idx) => (
                    <button
                        key={idx}
                        type="button"
                        onClick={() => handleSend(q)}
                        disabled={loading}
                        className="text-xs px-2.5 py-1 rounded-[2px] bg-white border border-stone-200 text-stone-700 hover:bg-stone-100 hover:border-stone-300 transition-colors disabled:opacity-50"
                    >
                        {q}
                    </button>
                ))}
            </div>

            {/* 对话列表 */}
            <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                {messages.map((m, idx) => (
                    <div
                        key={idx}
                        className={`flex gap-2.5 ${m.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                        {m.role === "assistant" && (
                            <div className="w-6 h-6 rounded-[2px] bg-stone-900 text-white flex items-center justify-center shrink-0 mt-0.5 text-xs font-serif">
                                答
                            </div>
                        )}
                        <div
                            className={`px-3.5 py-2.5 rounded-[2px] text-xs sm:text-sm leading-relaxed max-w-[85%] whitespace-pre-wrap ${
                                m.role === "user"
                                    ? "bg-stone-900 text-stone-50"
                                    : "bg-white border border-stone-200 text-stone-800 shadow-2xs"
                            }`}
                        >
                            {m.content}
                        </div>
                    </div>
                ))}
                {loading && (
                    <div className="flex gap-2.5 justify-start">
                        <div className="w-6 h-6 rounded-[2px] bg-stone-900 text-white flex items-center justify-center shrink-0 text-xs font-serif">
                            答
                        </div>
                        <div className="px-3 py-2 rounded-[2px] bg-white border border-stone-200 text-xs text-stone-500 flex items-center gap-2">
                            <span className="w-1.5 h-1.5 bg-stone-600 rounded-none animate-pulse" />
                            <span>正在查阅发言实录并梳理回答...</span>
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>

            {errorMsg && (
                <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 px-3 py-1.5 rounded-[2px]">
                    {errorMsg}
                </div>
            )}

            {/* 输入栏 */}
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    handleSend();
                }}
                className="flex items-center gap-2 pt-2 border-t border-stone-200"
            >
                <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="向助手询问关于本次会议的具体细节..."
                    disabled={loading}
                    className="flex-1 px-3 py-1.5 text-xs sm:text-sm bg-white border border-stone-200 rounded-[2px] outline-none focus:border-stone-800 transition disabled:opacity-50"
                />
                <button
                    type="submit"
                    disabled={!input.trim() || loading}
                    className="px-4 py-1.5 bg-stone-900 hover:bg-stone-800 text-white rounded-[2px] text-xs sm:text-sm font-medium transition shadow-2xs disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    发送
                </button>
            </form>
        </div>
    );
}
