import Link from "next/link";

/** /result 段专属 404 视图（notFound() 触发；真实 404 状态码 + 原有友好样式） */
export default function ResultNotFound() {
  return (
    <div className="min-h-screen bg-stone-100/60 flex items-center justify-center p-4 font-sans">
      <div className="bg-white p-8 rounded-[2px] shadow-2xs border border-stone-200 max-w-md w-full text-center">
        <div className="w-12 h-12 rounded-[2px] bg-stone-100 text-stone-600 flex items-center justify-center mx-auto mb-4"><svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg></div>
        <h2 className="text-lg font-semibold text-stone-900 mb-2">未找到该会议记录</h2>
        <p className="text-sm text-stone-500 mb-6 leading-relaxed">
          记录可能已被删除、不属于当前账号或链接有误。您可以返回首页新建会议或从历史中选择。
        </p>
        <Link
          href="/"
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-[2px] bg-stone-900 text-white text-sm font-medium hover:bg-stone-800 transition shadow-2xs"
        >
          ← 返回工作台
        </Link>
      </div>
    </div>
  );
}
