import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
    title: "使用说明 · 言简 · 会议纪要",
    description: "从注册账号、配置接口，到录入会议、导出纪要的完整操作说明。",
};

/** 左侧目录锚点（与正文各 section 的 id 一一对应） */
const SECTIONS: Array<{ id: string; title: string }> = [
    { id: "start", title: "五分钟上手" },
    { id: "account", title: "账号与安全" },
    { id: "settings", title: "配置接口" },
    { id: "input", title: "录入会议" },
    { id: "result", title: "读懂结果页" },
    { id: "export", title: "导出与分发" },
    { id: "history", title: "历史纪要" },
    { id: "chat", title: "问答助手" },
    { id: "tips", title: "写纪要技巧" },
    { id: "faq", title: "问题排查" },
];

const QUICK_START: Array<[string, string, string]> = [
    ["1", "注册并登录账号", "登录页"],
    ["2", "点「接口设置」，填入大模型地址与密钥", "首页右上角"],
    ["3", "点「填入纪要范本」自动填一段示例速记", "文本框右上方"],
    ["4", "点「梳理会议备忘」，等进度条走完", "首页底部按钮"],
    ["5", "自动跳转到结果页，查看决议与待办", "结果页"],
];

const PROVIDERS: Array<[string, string, string]> = [
    ["DeepSeek", "https://api.deepseek.com", "deepseek-chat"],
    ["OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"],
    ["通义千问", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"],
    ["硅基流动", "https://api.siliconflow.cn/v1", "deepseek-ai/DeepSeek-V3"],
    ["月之暗面 (Kimi)", "https://api.moonshot.cn/v1", "moonshot-v1-8k"],
    ["本地 Ollama", "http://localhost:11434/v1", "qwen2.5:7b"],
];

const STYLES: Array<[string, string, string]> = [
    ["工作例会", "常规周会、项目例会", "各项进展、问题与下一步计划"],
    ["日常同步", "站会、晨会", "昨日完成、今日目标、卡点与求助"],
    ["专题研讨", "头脑风暴、方案评审", "观点碰撞、争议焦点、认可的尝试方向"],
    ["商务商谈", "客户沟通、合作洽谈", "客户诉求、双方承诺、价格与合作边界"],
];

const RESULT_SECTIONS: Array<[string, string]> = [
    ["会议标题区", "会议类型、日期时间、字数统计；鼠标移到标题上点「✎ 修改」可改名"],
    ["一、会议核心结论与定案", "分条列出的决议要点"],
    ["二、待办事项与责任人", "每条含负责人与截止日期，点击整条即勾选完成，状态自动存服务端"],
    ["三、具体讨论议题与发言记录", "按议题分组，每个议题下是发言要点"],
    ["四、注意事项与潜在风险", "仅在识别到风险时出现"],
    ["五、查阅发言速记全文", "可折叠，便于核对 AI 是否漏掉内容"],
    ["六、问答助手", "展开后可对本次会议内容追问"],
];

const EXPORTS: Array<[string, string, string]> = [
    ["复制全文（直接发微信/企微）", "群内汇报", "生成带编号、@负责人、截止日期的纯文本，粘贴即排版整齐"],
    ["导出 Word", "正式存档", "下载 .docx 文件，含决议、待办与发言速记"],
    ["生成卡片", "快速预览", "弹出纪要便签卡片，可一键复制精简摘要"],
    ["分享", "给同事看", "复制本篇链接（对方需登录并有权访问该篇纪要）"],
];

const FAQ: Array<[string, string]> = [
    ["点提交后直接弹出设置窗", "还没配置大模型密钥，到「接口设置」填入地址、密钥、模型即可"],
    ["提示「读取接口设置失败，请确认本机数据库服务已启动」", "数据库未启动或连接串错误，请联系运维确认 MySQL 状态"],
    ["上传音频后提示「未配置语音转写 API 密钥」", "转写与语言模型是两套配置，需在设置弹窗下半部分单独填写"],
    ["提示「录音文件过大」", "单个音频上限 50MB，请压缩或切分后重传"],
    ["转写提示超时", "单次转写上限 10 分钟，请换更短的音频或检查网络"],
    ["提示「会议内容太短」", "文字不足 5 字，补充内容后重试"],
    ["提示「模型返回的内容格式不符合预期」", "所选模型不支持结构化输出，换用列表中其他模型（推荐 DeepSeek / GPT 系列）"],
    ["登录时多出验证码输入框", "账号连续失败 2 次的自动防护，正常输入 5 位字符即可（不分大小写）"],
    ["提示「账号已临时锁定」", "连续失败 5 次触发，15 分钟后自动解锁"],
    ["换张验证码图片后仍报验证码错误", "验证码是一次性的，刷新后需立刻输入最新一张图上的字符"],
    ["登录后被反复弹回登录页", "本地 http 环境误开了 COOKIE_SECURE，请联系运维移除该变量"],
    ["想给同事看纪要，对方打不开", "数据按用户隔离，可改用「导出 Word」或「复制全文」分发"],
];

/** 章节外壳：统一标题样式与锚点 */
function Section({
    id,
    title,
    children,
}: {
    id: string;
    title: string;
    children: React.ReactNode;
}) {
    const index = SECTIONS.findIndex((s) => s.id === id) + 1;
    return (
        <section
            id={id}
            className="scroll-mt-5 bg-white border border-stone-200 rounded-[2px] p-5 sm:p-6 shadow-2xs space-y-4"
        >
            <h2 className="font-serif text-base font-bold text-stone-900 tracking-tight flex items-baseline gap-2 pb-2.5 border-b border-stone-100">
                <span className="text-[11px] font-sans font-normal text-stone-400 tabular-nums">
                    {String(index).padStart(2, "0")}
                </span>
                {title}
            </h2>
            {children}
        </section>
    );
}

/** 通用表格外壳 */
function DataTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
    return (
        <div className="overflow-x-auto -mx-1 px-1">
            <table className="w-full text-xs border-collapse">
                <thead>
                    <tr className="border-b border-stone-200">
                        {head.map((h) => (
                            <th
                                key={h}
                                className="text-left font-medium text-stone-500 py-2 px-2.5 whitespace-nowrap"
                            >
                                {h}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((cells, i) => (
                        <tr key={i} className="border-b border-stone-100 last:border-0">
                            {cells.map((cell, j) => (
                                <td
                                    key={j}
                                    className={`py-2 px-2.5 align-top leading-relaxed ${
                                        j === 0 ? "text-stone-800 font-medium min-w-[4.5rem]" : "text-stone-600"
                                    }`}
                                >
                                    {cell}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export default function HelpPage() {
    return (
        <main className="min-h-screen bg-stone-100/60 text-stone-800 flex flex-col items-center py-5 sm:py-7 px-3 sm:px-4 font-sans selection:bg-stone-800 selection:text-white">
            <div className="w-full max-w-5xl mx-auto space-y-4">
                {/* 顶栏 */}
                <header className="flex items-center justify-between gap-3 pb-2.5 border-b border-stone-200">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-7 h-7 shrink-0 rounded-[2px] bg-stone-900 text-stone-100 flex items-center justify-center font-serif text-sm font-semibold shadow-2xs">
                            言
                        </div>
                        <div className="flex items-baseline gap-2 min-w-0">
                            <h1 className="text-sm sm:text-base font-serif font-bold text-stone-900 tracking-tight truncate">
                                使用说明
                            </h1>
                            <span className="text-[11px] text-stone-400 hidden sm:inline whitespace-nowrap">
                                从注册到导出纪要
                            </span>
                        </div>
                    </div>

                    <Link
                        href="/"
                        className="shrink-0 px-2.5 py-1 text-xs font-medium text-stone-700 bg-white hover:bg-stone-100 border border-stone-200 rounded-[2px] shadow-2xs transition-colors flex items-center gap-1"
                    >
                        <span>←</span>
                        <span>返回工作台</span>
                    </Link>
                </header>

                {/* 主体：左侧目录 + 右侧内容 */}
                <div className="grid grid-cols-1 lg:grid-cols-[168px_minmax(0,1fr)] gap-4 lg:gap-6 items-start">
                    {/* 目录（大屏粘性吸附） */}
                    <nav className="hidden lg:block sticky top-5 space-y-0.5">
                        <p className="text-[11px] font-medium text-stone-400 px-2 pb-1.5">目录</p>
                        {SECTIONS.map((s, i) => (
                            <a
                                key={s.id}
                                href={`#${s.id}`}
                                className="flex items-center gap-2 px-2 py-1.5 text-xs text-stone-600 hover:text-stone-900 hover:bg-white border border-transparent hover:border-stone-200 rounded-[2px] transition-colors"
                            >
                                <span className="text-[10px] text-stone-400 tabular-nums">
                                    {String(i + 1).padStart(2, "0")}
                                </span>
                                <span className="truncate">{s.title}</span>
                            </a>
                        ))}
                    </nav>

                    {/* 内容 */}
                    <div className="space-y-3.5 min-w-0">
                        {/* 五分钟上手 */}
                        <Section id="start" title="五分钟上手">
                            <p className="text-xs text-stone-600 leading-relaxed">
                                第一次使用，建议直接走「填入纪要范本」这条路——
                                不需要准备音频、也不用配转写密钥，几秒就能看到成品效果。
                            </p>
                            <DataTable
                                head={["步骤", "操作", "位置"]}
                                rows={QUICK_START.map(([n, action, where]) => [
                                    <span key="n" className="font-mono text-stone-400">
                                        {n}
                                    </span>,
                                    action,
                                    <span key="w" className="text-stone-400">
                                        {where}
                                    </span>,
                                ])}
                            />
                        </Section>

                        {/* 账号与安全 */}
                        <Section id="account" title="账号与安全">
                            <h3 className="text-xs font-semibold text-stone-800">注册规则</h3>
                            <DataTable
                                head={["项目", "要求"]}
                                rows={[
                                    ["用户名", "3–24 位字母、数字或下划线，或合法邮箱地址"],
                                    [
                                        "密码",
                                        "8–64 位，且必须同时包含字母和数字",
                                    ],
                                    [
                                        "图形验证码",
                                        "必填，5 位字符（数字 + 大写字母，已去除 0/O/1/I/L 等易混字符）",
                                    ],
                                ]}
                            />
                            <p className="text-xs text-stone-600 leading-relaxed">
                                <span className="text-stone-800 font-medium">验证码是一次性的</span>
                                ：300 秒有效、用一次即失效。若本次提交失败（例如用户名已被占用），
                                需要重新获取一张再提交。看不清可点「换一张」。
                            </p>
                            <p className="text-xs text-stone-600 leading-relaxed">
                                <span className="text-stone-800 font-medium">第一个注册的账号自动成为管理员</span>
                                ，并认领系统中历史遗留的存量会议；之后注册的账号各自独立，只看得到自己的内容。
                            </p>

                            <h3 className="text-xs font-semibold text-stone-800 pt-1">登录保护</h3>
                            <ul className="space-y-1.5 text-xs text-stone-600 leading-relaxed list-disc pl-4">
                                <li>连续输错密码 <span className="text-stone-800 font-medium">2 次</span>后，登录框会多出图形验证码——这是账号保护机制，不是故障</li>
                                <li>同一账号连续失败 <span className="text-stone-800 font-medium">5 次</span>会被锁定 <span className="text-stone-800 font-medium">15 分钟</span>，到期自动解锁</li>
                                <li>同一 IP + 用户名 15 分钟内失败超过 5 次，同样会被临时限速</li>
                                <li>点「登出」会立即吊销本次会话；改密成功后，你在其他设备上的登录会全部下线，当前设备保持在线</li>
                            </ul>
                            <p className="text-xs text-stone-500 leading-relaxed">
                                若你接手了别人交付的账号，请首次登录后立即修改密码。
                            </p>
                        </Section>

                        {/* 配置接口 */}
                        <Section id="settings" title="配置接口">
                            <p className="text-xs text-stone-600 leading-relaxed">
                                点首页右上角「接口设置」。配置保存在服务端，
                                换浏览器登录同一账号无需重填。
                            </p>

                            <h3 className="text-xs font-semibold text-stone-800">
                                语言模型（必填）
                                <span className="ml-2 font-normal text-stone-400">
                                    用于纪要提炼、待办萃取、纪要问答
                                </span>
                            </h3>
                            <DataTable
                                head={["字段", "说明"]}
                                rows={[
                                    ["接口地址 (Base URL)", "服务商的 OpenAI 兼容地址"],
                                    ["接口密钥 (Key)", "以 sk- 开头的密钥串"],
                                    ["模型标识 (Model)", "模型名，如 deepseek-chat"],
                                ]}
                            />
                            <p className="text-xs text-stone-600 leading-relaxed">
                                <span className="text-stone-800 font-medium">推荐做法</span>
                                ：先点服务商预设按钮（自动填好地址与默认模型）→ 补上密钥 →
                                点「获取模型列表」从下拉里挑一个实际可用的模型。这一步同时验证了地址与密钥是否正确。
                            </p>
                            <DataTable
                                head={["服务商", "接口地址", "默认模型"]}
                                rows={PROVIDERS.map(([name, url, model]) => [
                                    name,
                                    <code key="u" className="font-mono text-[11px] break-all">
                                        {url}
                                    </code>,
                                    <code key="m" className="font-mono text-[11px]">
                                        {model}
                                    </code>,
                                ])}
                            />

                            <h3 className="text-xs font-semibold text-stone-800 pt-1">
                                语音转写
                                <span className="ml-2 font-normal text-stone-400">
                                    用录音或音频时才需要，纯文字录入可跳过
                                </span>
                            </h3>
                            <p className="text-xs text-stone-600 leading-relaxed">
                                需填接口地址、密钥与转写模型（如 <code className="font-mono text-[11px]">whisper-1</code>、
                                <code className="font-mono text-[11px]">FunAudioLLM/SenseVoiceSmall</code>）。
                                若与语言模型是同一家服务商，勾选「直接复用上方的大模型接口地址与密钥」即可省去重复填写。
                            </p>

                            <div className="p-3 bg-stone-50 border border-stone-200 rounded-[2px] space-y-1.5">
                                <p className="text-xs font-semibold text-stone-800">关于密钥安全</p>
                                <ul className="space-y-1 text-xs text-stone-600 leading-relaxed list-disc pl-4">
                                    <li>密钥以 AES-256-GCM 密文存入数据库，页面与接口永远只显示尾 4 位</li>
                                    <li>保存后再次打开设置，密钥框会留空——留空表示「保留原密钥」，要换才需重填</li>
                                    <li>每位用户各自配置自己的密钥，互不可见</li>
                                </ul>
                            </div>
                        </Section>

                        {/* 录入会议 */}
                        <Section id="input" title="录入会议">
                            <p className="text-xs text-stone-600 leading-relaxed">
                                首页顶部三个标签页，任选一种录入方式。
                            </p>
                            <DataTable
                                head={["方式", "说明", "限制"]}
                                rows={[
                                    [
                                        "文字实录",
                                        "直接粘贴会议发言、讨论提纲或聊天记录，最推荐日常使用；可点「填入纪要范本」快速体验",
                                        "至少 5 个字",
                                    ],
                                    [
                                        "音频转写",
                                        "上传已有录音，系统先转文字再提炼纪要",
                                        "支持 mp3/wav/m4a/aac/flac/ogg/opus/webm/amr；单文件 ≤ 50MB；转写超时 10 分钟",
                                    ],
                                    [
                                        "现场收音",
                                        "浏览器直接录音，录完自动带入转写流程",
                                        "需授予麦克风权限",
                                    ],
                                ]}
                            />

                            <h3 className="text-xs font-semibold text-stone-800 pt-1">
                                场景侧重
                                <span className="ml-2 font-normal text-stone-400">决定 AI 的整理着眼点</span>
                            </h3>
                            <DataTable
                                head={["场景", "适用情形", "整理侧重"]}
                                rows={STYLES}
                            />
                            <p className="text-xs text-stone-500 leading-relaxed">
                                同样一段内容，选「商务商谈」会突出诉求与承诺，选「日常同步」则突出卡点——
                                提交前选对场景，纪要会明显更贴合。
                            </p>
                        </Section>

                        {/* 结果页 */}
                        <Section id="result" title="读懂结果页">
                            <p className="text-xs text-stone-600 leading-relaxed">
                                提交后自动跳转到结果页，内容按以下顺序组织：
                            </p>
                            <DataTable
                                head={["板块", "内容"]}
                                rows={RESULT_SECTIONS}
                            />
                            <p className="text-xs text-stone-500 leading-relaxed">
                                待办勾选是持久化的：关掉页面、换设备打开，勾选状态都还在。
                            </p>
                        </Section>

                        {/* 导出与分发 */}
                        <Section id="export" title="导出与分发">
                            <DataTable
                                head={["按钮", "适用场景", "说明"]}
                                rows={EXPORTS}
                            />
                        </Section>

                        {/* 历史纪要 */}
                        <Section id="history" title="历史纪要">
                            <p className="text-xs text-stone-600 leading-relaxed">
                                点首页右上角「历史纪要」打开抽屉，默认展示最近 25 篇，
                                含标题、摘要、时间、会议类型与待办数量。点击任意一条进入结果页；
                                鼠标移到某条上出现 ✕，点击并确认即可删除（删除不可恢复）。
                                每次成功整理都会自动归档，无需手动保存。
                            </p>
                        </Section>

                        {/* 问答助手 */}
                        <Section id="chat" title="问答助手">
                            <p className="text-xs text-stone-600 leading-relaxed">
                                在结果页底部展开「向纪要助手提问」，可针对本次会议的全部内容提问，例如：
                            </p>
                            <ul className="space-y-1 text-xs text-stone-600 leading-relaxed list-disc pl-4">
                                <li>「会议最终决定了哪几件事？」</li>
                                <li>「周三去印厂的是谁？」</li>
                                <li>「客户对价格的态度是什么？」</li>
                            </ul>
                            <p className="text-xs text-stone-500 leading-relaxed">
                                助手只基于这一篇纪要回答，看不到你其他的会议。提问需要已配置大模型密钥。
                            </p>
                        </Section>

                        {/* 技巧 */}
                        <Section id="tips" title="写纪要技巧">
                            <ol className="space-y-1.5 text-xs text-stone-600 leading-relaxed list-decimal pl-4">
                                <li>
                                    <span className="text-stone-800 font-medium">带上人名与时间</span>
                                    ——写「陆文周三上午 10 点去印厂看色」，比「有人去印厂」更容易提炼成含负责人与截止日期的完整待办
                                </li>
                                <li>
                                    <span className="text-stone-800 font-medium">把决议和讨论分开说</span>
                                    ——「明确三项安排：1…2…3…」这类表述会被准确归入「核心结论与定案」
                                </li>
                                <li>
                                    <span className="text-stone-800 font-medium">速记不用润色</span>
                                    ——口语化、有错别字都没关系，重点是信息完整，提炼是 AI 的活
                                </li>
                                <li>
                                    <span className="text-stone-800 font-medium">场景选对</span>
                                    ——选对场景比反复修改速记更有效
                                </li>
                                <li>
                                    <span className="text-stone-800 font-medium">注意时长与篇幅</span>
                                    ——极长的录音建议切段整理，既避开转写超时，也让提炼更聚焦
                                </li>
                            </ol>
                        </Section>

                        {/* FAQ */}
                        <Section id="faq" title="问题排查">
                            <DataTable head={["现象", "原因与处理"]} rows={FAQ} />
                        </Section>

                        {/* 隐私说明 */}
                        <section className="bg-stone-50 border border-stone-200 rounded-[2px] p-4 sm:p-5 space-y-1.5">
                            <h2 className="text-xs font-semibold text-stone-800">数据与隐私</h2>
                            <ul className="space-y-1 text-[11px] text-stone-500 leading-relaxed list-disc pl-4">
                                <li>会议内容存放在本机数据库，仅通过你自己的账号可见</li>
                                <li>纪要提炼与转写会把内容发送到你自己配置的服务商，请按合规要求选择</li>
                                <li>API 密钥加密存储，管理员也无法从接口读到明文</li>
                            </ul>
                        </section>
                    </div>
                </div>

                <footer className="pt-1 text-center text-[11px] text-stone-400">
                    言简 · 会议纪要整理工作台 · 去芜存菁，省心备忘
                </footer>
            </div>
        </main>
    );
}
