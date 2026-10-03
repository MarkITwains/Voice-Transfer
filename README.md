# 言简 · 会议纪要

> 去芜存菁，静心备忘。
>
> 把一段会议速记、一份录音，梳理成「核心决议 · 待办分工 · 讨论议题 · 潜在风险」四段式纪要，
> 支持导出 Word、一键复制发群、按会议内容向纪要助手追问，多用户各自独立存放。

---

## 一、它能做什么

| 能力 | 说明 |
|---|---|
| **三种录入方式** | ① 文字实录：直接粘贴发言速记；② 音频转写：上传录音文件自动转文字；③ 现场收音：浏览器直接录音 |
| **四种场景侧重** | 工作例会 / 日常同步 / 专题研讨 / 商务商谈，不同侧重决定纪要提炼的着眼点 |
| **结构化纪要** | 自动产出「会议核心结论与定案」「待办事项与责任人（含截止日期）」「具体讨论议题与发言记录」「注意事项与潜在风险」 |
| **待办勾选** | 结果页可直接勾选/取消待办，状态实时同步到服务端持久层 |
| **导出与分发** | 导出 `.docx` Word 文档、生成纪要便签卡片、一键复制成微信/企微友好格式、复制分享链接 |
| **纪要问答助手** | 基于本次会议的完整内容追问，例如"谁负责周三的试印？""下一版什么时候定稿？" |
| **历史纪要** | 每次整理完成自动归档，可随时调阅、修改标题、删除 |
| **多用户隔离** | 账号密码登录，每人只能看到自己的会议与配置；密钥按用户独立存储（BYOK） |

---

## 二、技术栈

| 层 | 选型 |
|---|---|
| 前端 / 服务端 | Next.js 16（App Router）+ React 19 + TypeScript |
| 样式 | Tailwind CSS 4 |
| 数据库 | MySQL 8.0+（`mysql2` 驱动，启动时自动建表） |
| 认证 | bcryptjs 密码散列 + HMAC 签名 Cookie（`ma_session`）+ `sessions` 表会话吊销 |
| 密钥加密 | AES-256-GCM（主密钥落盘 `.data/enc_key`） |
| 大模型 / 转写 | 任意 OpenAI 兼容接口（LLM 与 ASR 各自配置） |
| 文档导出 | `docx` + `file-saver` |

---

## 三、环境要求

- **Node.js**：20 及以上（开发验证使用 22.x）
- **MySQL**：8.0 及以上，本机常驻实例即可（当前验证环境为 9.7.2，`127.0.0.1:3306`）
- **浏览器**：Chrome / Edge 等现代浏览器（现场收音需要麦克风权限）

---

## 四、快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（复制模板后改成你的 MySQL 连接串）
cp .env.example .env.local

# 3. 创建数据库并验证连通（幂等，可重复执行）
node scripts/db/create-mysql-database.mjs

# 4. 启动开发服务（默认端口 7200）
npm run dev
```

打开 <http://localhost:7200> —— 首次访问会被引导到登录页，注册一个账号即可开始。

> **表结构无需手工执行 DDL**：应用启动时 `app/lib/bootstrap.ts` 会自动创建
> `meetings` / `users` / `app_settings` / `user_settings` / `sessions` / `migration_markers` 等表，
> 并对存量库做幂等补列。

### 首次使用建议顺序

1. 注册账号（**第一个注册的账号自动成为管理员**，并认领历史遗留的存量会议数据）
2. 点右上角「接口设置」，填入大模型地址与密钥（必填）
3. 如需使用录音/音频转写，在同一弹窗下方再填「语音转写」地址与密钥
4. 在首页点「填入纪要范本」→「梳理会议备忘」，先跑通一遍完整流程

详细操作见 **[docs/使用手册.md](docs/使用手册.md)**。

---

## 五、环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | MySQL 连接串，形如 `mysql://用户:密码@127.0.0.1:3306/meeting_ai`。**应用内唯一的数据源配置来源** |
| `AUTH_SECRET` | — | 会话 Cookie 签名密钥。缺省时首次启动自动生成 64 字节随机数落盘 `data/auth_secret` |
| `COOKIE_SECURE` | — | 置 `1` 时 Cookie 带 `Secure` 标记，**仅在 HTTPS 部署时开启**，本地 http 开启会导致登录态失效 |
| `TRUSTED_ORIGINS` | — | 跨站请求（CSRF）校验的额外可信源，逗号分隔，例如 `https://demo.example.com`。缺省为空则不额外放行 |
| `QA_TEST_MODE` | — | 置 `1` 时验证码接口在响应中附带明文 `debugCode`，**仅供开发/QA 环境跑自动化测试**。生产环境（`next start`，`NODE_ENV=production`）双条件硬门，即使误配也不会生效 |

`.env.example` 里有可直接复制的模板。

> ⚠️ `DATABASE_URL` 中的密码若包含 `@ : /` 等符号，请使用 URL 编码（如 `@` → `%40`）。

---

## 六、常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动开发服务，端口 **7200**（热更新） |
| `npm run build` | 生产构建 |
| `npm run start` | 启动生产服务，端口 7200（需先 `build`） |
| `npm run lint` | ESLint 检查 |
| `node scripts/db/create-mysql-database.mjs` | 幂等建库 + 连通性验证 |
| `node scripts/test/run-all.mjs` | 全量回归测试（需 dev 服务与 MySQL 均在运行） |

> 本机 Windows 环境下构建前若遇文件删除被拦截，可在命令前加 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。

---

## 七、目录结构

```
app/
  page.tsx                    首页（纪要录入工作台）
  login/  register/           登录 / 注册页
  result/[roomId]/            纪要结果页（动态路由）
  api/                        接口层（见下方「接口一览」）
  components/                 前端组件（录入、结果、设置、问答、导出等）
  lib/                        数据与服务层
    db.ts / bootstrap.ts       连接池、启动建表与幂等迁移
    auth.ts / authToken.ts     认证鉴权、会话令牌
    userRepo / meetingRepo / settingsRepo    数据访问
    captcha.ts / rateLimit.ts  验证码、内存限速
    crypto.ts / serverSettings 密钥 AES-256-GCM 加解密
proxy.ts                      全站访问闸门（未登录重定向 + CSRF 校验）
data/  .data/                 会话签名密钥、加密主密钥、历史 JSON 备份
docs/                         设计与使用文档
scripts/db/  scripts/test/    建库脚本、回归测试用例
```

---

## 八、数据与安全

- **密码**：bcryptjs 散列存储，永不明文；规则为 8–64 位且同时包含字母与数字
- **会话**：HttpOnly + SameSite=Lax Cookie（`ma_session`，7 天）；服务端 `sessions` 表记录每一条会话，**登出、改密即服务端吊销**，旧 Cookie 立即失效
- **登录防护**：同一 IP + 用户名 15 分钟内失败 5 次即限速；同一账号连续失败 5 次锁定 15 分钟（自动解锁）；失败 2 次后登录需填写图形验证码（SVG，300 秒有效、一次性、大小写不敏感）
- **注册**：必须填写图形验证码
- **CSRF**：写入类请求校验 `Origin`/`Referer` 同源，异源一律 403
- **响应头**：全局配置 `X-Frame-Options`、`X-Content-Type-Options`、`Referrer-Policy`
- **API 密钥**：用户自行填写的大模型/转写密钥以 AES-256-GCM 密文存库，**接口响应永不回传明文**（仅返回脱敏尾 4 位）
- **数据隔离**：会议与配置均按用户维度隔离，越权访问统一返回 404
- **数据备份**：核心数据在 MySQL；`.data/` 下保留会话签名密钥、加密主密钥与历史 JSON 备份，**迁移或换机时需一并带走**，否则已加密的密钥无法解密

> 换机 / 备份时请同时保留 `.data/enc_key`（否则用户已保存的 API 密钥无法解密）与 `data/auth_secret`（否则所有人需重新登录）。

---

## 九、接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 服务与数据库探活（`SELECT 1`） |
| `GET` | `/api/auth/captcha` | 获取图形验证码（返回 `captchaId` + SVG） |
| `POST` | `/api/auth/register` | 注册（需验证码），首个用户自动成为管理员 |
| `POST` | `/api/auth/login` | 登录（失败 2 次后需验证码） |
| `POST` | `/api/auth/logout` | 登出（服务端吊销会话） |
| `GET` | `/api/auth/me` | 获取当前登录用户（含滑动续期） |
| `POST` | `/api/auth/password` | 修改密码（成功后其余设备全部下线） |
| `GET`/`PUT` | `/api/settings` | 读取脱敏配置 / 保存配置（密钥留空 = 保留旧值） |
| `POST` | `/api/models` | 用刚填的密钥拉取可用模型列表 |
| `POST` | `/api/test-key` | 测试密钥连通性 |
| `POST` | `/api/transcribe` | 音频转写（`multipart/form-data`，单文件 ≤ 50MB） |
| `POST` | `/api/summarize` | 提炼生成会议纪要（`rawText` 至少 5 字，`style` 四选一） |
| `GET` | `/api/meetings` | 会议列表 / 单篇详情（`limit` 默认 30） |
| `PATCH` | `/api/meetings` | 修改标题、同步待办勾选状态 |
| `DELETE` | `/api/meetings?id=` | 删除某篇纪要 |
| `POST` | `/api/chat` | 纪要问答助手 |
| `GET` | `/api/admin/users` | 用户列表（仅管理员） |

---

## 十、回归测试

```bash
# 前置：MySQL 在跑，且另开一个终端已执行 npm run dev（7200 端口）
node scripts/test/run-all.mjs
```

覆盖 7 组共 **82** 个用例（C26 + D5 + A10 + B8 + E13 + F11 + G9），按 **C（认证）→ D（认证深水区）→ A（会议 CRUD）→ B（设置同步）→ E（验证码）→ F（安全）→ G（QA 判定）** 顺序执行。测试用例自注入并自清理测试密钥，不依赖库内预置状态；如需指向其他地址，可设 `QA_BASE_URL` 环境变量。

---

## 十一、常见问题

| 现象 | 原因与处理 |
|---|---|
| 页面提示「读取接口设置失败，请确认本机数据库服务已启动」 | MySQL 未启动或 `DATABASE_URL` 配错；执行 `node scripts/db/create-mysql-database.mjs` 验证连通 |
| 点击「梳理会议备忘」直接弹出设置窗 | 还没填大模型密钥，属正常引导；到「接口设置」填入 Key 即可 |
| 上传音频后提示「未配置语音转写 API 密钥」 | 语音转写与文本大模型是两套配置，需在设置弹窗下半部分单独填 ASR 地址/密钥/模型 |
| 登录提示需要验证码 | 该账号密码连续错误 2 次后的自适应防护，输入图中 5 位字符（不分大小写）即可 |
| 提示「账号已临时锁定」 | 连续失败 5 次触发，15 分钟后自动解锁 |
| 登录后被反复踢回登录页 | 检查 `COOKIE_SECURE`：本地 http 环境下应删除此项或置为 `0` |
| 提示「录音文件过大」 | 单个音频上限 50MB，可先压缩或切分 |
| 转写报超时 | 单次转写上限 10 分钟，请使用更短的音频或检查网络 |

---

## 十二、文档索引

| 文档 | 面向 | 内容 |
|---|---|---|
| [docs/使用手册.md](docs/使用手册.md) | **使用者** | 从注册到导出纪要的完整操作说明与排错清单 |
| [docs/system_design.md](docs/system_design.md) | 开发者 | 系统架构设计、数据结构、调用时序 |
| [docs/system_design-登录与多用户.md](docs/system_design-登录与多用户.md) | 开发者 | 认证与多用户隔离设计 |
| [docs/system_design-验证码与安全强化.md](docs/system_design-验证码与安全强化.md) | 开发者 | 验证码、会话吊销、CSRF 设计 |
| [docs/system_design-数据库化-2026-09-30.md](docs/system_design-数据库化-2026-09-30.md) | 开发者 | 数据持久化与配置同步 |
| [docs/mysql-切换说明-2026-09-30.md](docs/mysql-切换说明-2026-09-30.md) | 运维 | 数据库切换记录与初始化步骤 |
| [docs/prd-*.md](docs/) | 产品 | 各迭代的需求说明 |
