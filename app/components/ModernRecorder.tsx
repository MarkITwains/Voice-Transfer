"use client";

import { useState, useRef, useEffect } from "react";
import { pickRecorderMime, formatDuration } from "@/app/lib/audio";

interface ModernRecorderProps {
    onRecorded: (file: File) => void;
}

export default function ModernRecorder({ onRecorded }: ModernRecorderProps) {
    const [recording, setRecording] = useState(false);
    const [time, setTime] = useState(0);
    const [audioUrl, setAudioUrl] = useState("");
    const [recordFile, setRecordFile] = useState<File | null>(null);
    const [error, setError] = useState("");

    const mediaRecorder = useRef<MediaRecorder | null>(null);
    const chunks = useRef<Blob[]>([]);
    const timer = useRef<NodeJS.Timeout | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    useEffect(() => {
        return () => {
            if (timer.current) clearInterval(timer.current);
            if (mediaRecorder.current && mediaRecorder.current.state !== "inactive") {
                mediaRecorder.current.stop();
            }
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
            }
        };
    }, []);

    async function startRecord() {
        setAudioUrl("");
        setRecordFile(null);
        setTime(0);
        setError("");

        const isLocal =
            typeof window !== "undefined" &&
            (location.hostname === "localhost" || location.hostname === "127.0.0.1");

        if (location.protocol !== "https:" && !isLocal) {
            setError("当前非 HTTPS 协议，浏览器安全策略限制了麦克风收音。请使用本地文件上传。");
            return;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            setError("当前环境不支持录音，建议使用主流浏览器最新版本。");
            return;
        }

        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });
            streamRef.current = stream;
        } catch (err: unknown) {
            const name = (err as { name?: string })?.name;
            if (name === "NotAllowedError" || name === "PermissionDeniedError") {
                setError("麦克风权限未开启，请在浏览器地址栏允许使用麦克风。");
            } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
                setError("未检测到可用的麦克风输入设备。");
            } else {
                setError("开启麦克风失败，请检查系统收音设备。");
            }
            return;
        }

        chunks.current = [];
        const mimeType = pickRecorderMime();
        const options: MediaRecorderOptions = mimeType ? { mimeType } : {};

        let mr: MediaRecorder;
        try {
            mr = new MediaRecorder(stream, options);
        } catch {
            mr = new MediaRecorder(stream);
        }

        mr.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                chunks.current.push(e.data);
            }
        };

        mr.onstop = () => {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
            }
            if (timer.current) {
                clearInterval(timer.current);
                timer.current = null;
            }

            const actualMime = mr.mimeType || "audio/webm";
            const blob = new Blob(chunks.current, { type: actualMime });

            if (blob.size === 0) {
                setError("未录制到音频数据，请检查麦克风音量后重试");
                return;
            }

            const ext = actualMime.includes("ogg") ? "ogg" : "webm";
            const name = `现场录音_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`;
            const file = new File([blob], name, { type: actualMime });

            const url = URL.createObjectURL(blob);
            setAudioUrl(url);
            setRecordFile(file);
        };

        mediaRecorder.current = mr;
        mr.start(1000);
        setRecording(true);

        timer.current = setInterval(() => {
            setTime((t) => t + 1);
        }, 1000);
    }

    function stopRecord() {
        if (mediaRecorder.current && mediaRecorder.current.state === "recording") {
            mediaRecorder.current.stop();
        }
        setRecording(false);
    }

    function handleApply() {
        if (recordFile) {
            onRecorded(recordFile);
        }
    }

    return (
        <div className="w-full text-center space-y-4">
            {error && (
                <div className="p-3 rounded-[2px] bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 shrink-0 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span>{error}</span>
                </div>
            )}

            {!recording && !audioUrl && (
                <div className="py-6 space-y-3">
                    <button
                        type="button"
                        onClick={startRecord}
                        className="group inline-flex items-center justify-center w-14 h-14 rounded-[2px] bg-stone-900 text-white hover:bg-stone-800 transition-all shadow-2xs border border-stone-800"
                    >
                        <span className="w-4 h-4 rounded-[2px] bg-rose-500 group-hover:bg-rose-400 transition-colors" />
                    </button>
                    <div>
                        <p className="text-xs sm:text-sm font-semibold text-stone-800">
                            点击开始现场录音
                        </p>
                        <p className="text-[11px] text-stone-400 mt-0.5">
                            环境降噪与回声抑制 · 录制完毕后可回放试听并转写
                        </p>
                    </div>
                </div>
            )}

            {recording && (
                <div className="py-5 space-y-4">
                    <div className="flex items-center justify-center gap-2.5">
                        <span className="w-2 h-2 bg-rose-600 rounded-none animate-pulse" />
                        <span className="text-xl font-mono font-bold text-stone-900 tracking-wider">
                            {formatDuration(time)}
                        </span>
                    </div>

                    {/* 声波跳动条 */}
                    <div className="flex items-center justify-center gap-1 h-7">
                        {[35, 65, 30, 85, 55, 75, 45, 90, 40, 60].map((h, i) => (
                            <span
                                key={i}
                                className="w-1 bg-stone-800 rounded-none animate-pulse"
                                style={{
                                    height: `${(h * 0.24).toFixed(0)}px`,
                                    animationDelay: `${i * 90}ms`,
                                }}
                            />
                        ))}
                    </div>

                    <button
                        type="button"
                        onClick={stopRecord}
                        className="px-5 py-2 rounded-[2px] bg-rose-700 hover:bg-rose-800 text-white text-xs font-medium shadow-2xs transition-all flex items-center gap-2 mx-auto"
                    >
                        <span className="w-2 h-2 bg-white rounded-none" />
                        <span>停止录音</span>
                    </button>
                </div>
            )}

            {audioUrl && recordFile && (
                <div className="p-3.5 bg-stone-50 border border-stone-200 rounded-[2px] space-y-3 text-left">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <span className="text-stone-700 font-bold text-xs">✓</span>
                            <span className="text-xs sm:text-sm font-medium text-stone-800">
                                录音完成（时长 {formatDuration(time)}）
                            </span>
                        </div>
                        <span className="text-[11px] text-stone-400 font-mono">
                            {(recordFile.size / 1024 / 1024).toFixed(2)} MB
                        </span>
                    </div>

                    <audio src={audioUrl} controls className="w-full h-8 rounded-[2px]" />

                    <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                            type="button"
                            onClick={startRecord}
                            className="px-2.5 py-1 text-xs text-stone-600 hover:text-stone-900 rounded-[2px] border border-stone-200 bg-white"
                        >
                            重新录制
                        </button>
                        <button
                            type="button"
                            onClick={handleApply}
                            className="px-3.5 py-1 text-xs font-medium text-white bg-stone-900 hover:bg-stone-800 rounded-[2px] shadow-2xs transition-all flex items-center gap-1"
                        >
                            <span>使用此段音频</span>
                            <span>→</span>
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
