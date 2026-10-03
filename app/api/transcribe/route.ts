export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { resolveAsrConfig } from "@/app/lib/serverSettings";
import { requireUser } from "@/app/lib/auth";

// 请求总超时：600 秒
const FETCH_TIMEOUT_MS = 600_000;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

export async function POST(req: NextRequest) {
    try {
        const user = await requireUser(req);
        if (!user) {
            return NextResponse.json({ error: "未登录或会话已过期，请先登录" }, { status: 401 });
        }

        // 配置优先级：请求头 x-asr-*（兼容期兜底）→ 当前用户 user_settings（BYOK）→ 空
        const { apiKey: headerKey, baseUrl: headerBaseUrl, model: headerModel } = await resolveAsrConfig(req, user.id);

        const apiKey = headerKey && headerKey.trim();
        const model = headerModel && headerModel.trim();

        if (!apiKey) {
            return NextResponse.json(
                {
                    error: "未配置语音转写 API 密钥。请点击页面右上角「API 设置」填入语音转写接口地址、密钥及模型",
                },
                { status: 401 }
            );
        }

        if (!model) {
            return NextResponse.json(
                {
                    error: "未配置转写模型名称。请在「API 设置」中输入或获取转写模型（如 whisper-1、FunAudioLLM/SenseVoiceSmall 等）",
                },
                { status: 400 }
            );
        }

        const form = await req.formData();
        const file = form.get("file");

        if (!(file instanceof File)) {
            return NextResponse.json(
                { error: "未接收到录音文件" },
                { status: 400 }
            );
        }

        if (file.size > MAX_FILE_SIZE) {
            return NextResponse.json(
                {
                    error: `录音文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），单个文件上限 50MB`,
                },
                { status: 400 }
            );
        }

        if (file.size === 0) {
            return NextResponse.json(
                { error: "录音文件内容为空，请重新录制或选择" },
                { status: 400 }
            );
        }

        const safeName =
            file.name && file.name.includes(".") ? file.name : "audio.webm";

        // 构建转写接口 URL
        let transcriptionUrl = "https://api.siliconflow.cn/v1/audio/transcriptions";
        if (headerBaseUrl && headerBaseUrl.trim()) {
            const clean = headerBaseUrl.trim().replace(/\/+$/, "");
            if (clean.endsWith("/audio/transcriptions")) {
                transcriptionUrl = clean;
            } else {
                transcriptionUrl = `${clean}/audio/transcriptions`;
            }
        }

        const fd = new FormData();
        fd.append("file", file, safeName);
        fd.append("model", model);

        const response = await fetch(transcriptionUrl, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            body: fd,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }).catch((e: unknown) => {
            const err = e as { message?: string };
            throw new Error(`连接转写服务器失败: ${err?.message || "网络异常"}`);
        });

        if (!response.ok) {
            let detail = `${response.status} ${response.statusText}`;
            try {
                const errBody = await response.json();
                detail =
                    (errBody?.message && String(errBody.message)) ||
                    (errBody?.error?.message && String(errBody.error.message)) ||
                    (errBody?.data && String(errBody.data)) ||
                    detail;
            } catch {
                try {
                    const text = await response.text();
                    if (text) detail = text.slice(0, 200);
                } catch {
                    // ignore
                }
            }

            const friendly =
                response.status === 401
                    ? "（API 密钥无效或未授权，请检查设置中的 Key）"
                    : response.status === 404
                    ? "（转写接口路径 404，请检查 ASR 接口地址是否正确）"
                    : response.status === 429
                    ? "（触发模型限流，请稍后重试）"
                    : "";

            return NextResponse.json(
                {
                    error: `语音转写失败: ${detail}${friendly}`,
                },
                { status: response.status >= 400 && response.status < 600 ? response.status : 502 }
            );
        }

        const result = await response.json();
        const text: string =
            typeof result?.text === "string" ? result.text : "";

        if (!text) {
            return NextResponse.json(
                { error: "转写结果为空，音频中可能没有有效人声" },
                { status: 422 }
            );
        }

        return NextResponse.json({ text });
    } catch (e: unknown) {
        if (e instanceof Error && e.name === "TimeoutError") {
            return NextResponse.json(
                { error: "转写超时（超过 10 分钟），请尝试使用更短音频或检查网络" },
                { status: 504 }
            );
        }

        const msg = e instanceof Error ? e.message : "未知错误";
        console.error("转写接口异常:", msg);
        return NextResponse.json(
            { error: `转写服务异常: ${msg}` },
            { status: 500 }
        );
    }
}
