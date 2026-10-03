"use client";

import { useRef, useState, DragEvent } from "react";

interface ModernAudioUploadProps {
    audioFile: File | null;
    onFileChange: (file: File | null) => void;
}

const ACCEPTED_TYPES = ".mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.webm,.amr,audio/*";
const MAX_SIZE_MB = 50;

export default function ModernAudioUpload({
    audioFile,
    onFileChange,
}: ModernAudioUploadProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [error, setError] = useState("");
    const [isDragging, setIsDragging] = useState(false);

    function validate(file: File): string {
        if (file.size > MAX_SIZE_MB * 1024 * 1024) {
            return `录音文件体积过大（${(file.size / 1024 / 1024).toFixed(1)}MB），单个文件最大支持 ${MAX_SIZE_MB}MB`;
        }
        if (file.size === 0) {
            return "所选音频文件内容为空，请重新选择";
        }
        return "";
    }

    function handleFile(file: File) {
        const err = validate(file);
        if (err) {
            setError(err);
            onFileChange(null);
            if (inputRef.current) inputRef.current.value = "";
            return;
        }
        setError("");
        onFileChange(file);
    }

    function handleSelect(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) {
            onFileChange(null);
            return;
        }
        handleFile(file);
    }

    function handleDragOver(e: DragEvent<HTMLDivElement>) {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
    }

    function handleDragLeave(e: DragEvent<HTMLDivElement>) {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
    }

    function handleDrop(e: DragEvent<HTMLDivElement>) {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) {
            handleFile(file);
        }
    }

    function handleClear() {
        onFileChange(null);
        setError("");
        if (inputRef.current) {
            inputRef.current.value = "";
        }
    }

    return (
        <div className="w-full">
            {error && (
                <div className="mb-4 p-3 rounded-[2px] bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                    <svg className="w-4 h-4 shrink-0 text-rose-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span>{error}</span>
                </div>
            )}

            <input
                ref={inputRef}
                type="file"
                accept={ACCEPTED_TYPES}
                onChange={handleSelect}
                className="hidden"
            />

            {!audioFile ? (
                <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onClick={() => inputRef.current?.click()}
                    className={`w-full border border-dashed rounded-[2px] p-8 text-center cursor-pointer transition-all ${
                        isDragging
                            ? "border-stone-800 bg-stone-100"
                            : "border-stone-300 hover:border-stone-500 hover:bg-stone-50/60 bg-stone-50/30"
                    }`}
                >
                    <div className="w-10 h-10 rounded-[2px] bg-white border border-stone-200 flex items-center justify-center mx-auto mb-2.5 shadow-2xs">
                        <svg className="w-5 h-5 text-stone-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                    </div>
                    <p className="text-xs sm:text-sm font-medium text-stone-800 mb-0.5">
                        点击或将音频文件拖放到此处
                    </p>
                    <p className="text-[11px] text-stone-400">
                        支持 MP3, WAV, M4A, FLAC, AAC, WebM, OGG · 最大 50MB
                    </p>
                </div>
            ) : (
                <div className="p-3.5 rounded-[2px] bg-stone-50 border border-stone-200 shadow-2xs flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 overflow-hidden">
                        <div className="w-9 h-9 rounded-[2px] bg-white border border-stone-200 flex items-center justify-center shrink-0">
                            <svg className="w-4 h-4 text-stone-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                            </svg>
                        </div>
                        <div className="overflow-hidden">
                            <p className="text-xs font-semibold text-stone-800 truncate">
                                {audioFile.name}
                            </p>
                            <p className="text-[11px] text-stone-400 font-mono">
                                {(audioFile.size / 1024 / 1024).toFixed(2)} MB · 待转写
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                        <button
                            type="button"
                            onClick={() => inputRef.current?.click()}
                            className="px-2.5 py-1 text-xs text-stone-600 hover:text-stone-900 bg-white border border-stone-200 rounded-[2px] shadow-2xs transition-colors"
                        >
                            更换文件
                        </button>
                        <button
                            type="button"
                            onClick={handleClear}
                            className="p-1 text-stone-400 hover:text-rose-600 rounded-[2px] hover:bg-rose-50 transition-colors"
                            title="移除"
                        >
                            ✕
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
