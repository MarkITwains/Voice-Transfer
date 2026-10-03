// 浏览器端音频工具
// （硅基流动转写接口原生支持 webm/ogg/mp3/wav/m4a/flac 等格式，
//   录音产物无需再做 WAV 转换，直接上传即可）


/**
 * 判断浏览器录音产出的 MIME 类型（不同浏览器支持不一样）
 * 优先 opus 编码的 webm（Chrome/Edge/Firefox 都支持），其次 ogg
 */
export function pickRecorderMime(): string {
    const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "",
    ];
    for (const mime of candidates) {
        if (!mime || (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime))) {
            return mime;
        }
    }
    return "";
}


/** 秒数格式化 mm:ss */
export function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
