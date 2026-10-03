# 会议 AI 增量架构设计 —— 登录服务与多用户支持

> 版本：v1.0｜撰写：架构师 高见远（Bob）｜依据：`docs/prd-登录服务与多用户-2026-09-30.md` + 现有落地代码（MySQL 数据层）
> 已拍板：bcrypt 账密登录、开放注册、BYOK 每用户独立密钥、首个注册用户成管理员并继承 4 条无主会议；本期管理员仅 role 字段 + 只读用户列表（Q3）。

---

## 0. Next.js 16 关键事实（写码前必读，来自 node_modules/next/dist/docs 核实）

1. **`middleware.ts` 已弃用，更名为 `proxy.ts`**（v16.0.0）：放在**项目根目录**，必须导出名为 `proxy` 的函数（或 default export），config/matcher 用法与原 middleware 相同。**禁止创建 middleware.ts**。
2. **Proxy 默认运行在 Node.js runtime**（v16 起，runtime 配置项在 proxy 文件中不可设置、设置了会报错）。
3. 但官方文档明确警告：Proxy 与渲染代码是**分离调用**的，"不应依赖共享模块或全局状态"，且"**务必在每个 Route Handler / Server Function 内部独立校验认证**，不能只依赖 Proxy"。
4. 结论影响：Q1 会话校验在 proxy 中只能做**无状态纯密码学验证**（签名 + 过期），不做 DB 查询；所有业务路由内再走 `requireUser()` 做完整校验（含 DB token_version 核对），形成纵深防御。

---

## 1. 数据库设计

### 1.1 users 表（bootstrap.ts 自动建，幂等）

```sql
CREATE TABLE IF NOT EXISTS users (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username      VARCHAR(64)  NOT NULL,
    password_hash VARCHAR(72)  NOT NULL,          -- bcryptjs，$2b$ 前缀固定 60 字符，留余量
    role          VARCHAR(16)  NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
    token_version INT          NOT NULL DEFAULT 0, -- 密码修改时 +1，使所有已签发会话失效
    created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_username (username)
    -- MySQL 默认 utf8mb4_0900_ai_ci 排序规则 → 唯一性与查询天然大小写不敏感，
    -- "Abc" 与 "abc" 视为同一用户名，无需额外小写列
);
```

### 1.2 meetings 表加 user_id（ALTER 策略）

MySQL 不支持 `ADD COLUMN IF NOT EXISTS`，bootstrap 中先查 `information_schema.COLUMNS` 再决定是否 ALTER（幂等）：

```sql
ALTER TABLE meetings
    ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id,
    ADD INDEX idx_meetings_user_created (user_id, created_at DESC);
ALTER TABLE meetings
    ADD CONSTRAINT fk_meetings_user FOREIGN KEY (user_id) REFERENCES users(id);
```

- `user_id` 允许 NULL：仅存在于「建列后、首个用户注册 claim 前」的过渡窗口，claim 完成后即无 NULL 行；不设 NOT NULL 以便迁移逻辑用 `WHERE user_id IS NULL` 精确圈定无主数据
- **执行顺序**：bootstrap 内先建 users 表，再执行 meetings 的条件 ALTER

### 1.3 user_settings 表（Q2 落定：新建，不改 app_settings）

```sql
CREATE TABLE IF NOT EXISTS user_settings (
    user_id         BIGINT UNSIGNED PRIMARY KEY,
    llm_base_url    TEXT,
    llm_api_key_enc TEXT,        -- AES-256-GCM 密文，沿用 .data/enc_key
    llm_model       TEXT,
    asr_base_url    TEXT,
    asr_api_key_enc TEXT,
    asr_model       TEXT,
    updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users(id)
);
```

**app_settings 处理**：已确认当前为**空配置**（无任何有效数据），bootstrap 建表流程末尾执行 `DROP TABLE IF EXISTS app_settings`（建 users 之前执行亦可），并在 console 输出一行说明。不改原表的理由：单行 id=1 的结构与 user_id 主键结构完全不同，改造 = 重建，直接新建更干净。

### 1.4 会话存储方案（Q1 落定：无服务端 session 表）

会话为**无状态签名 Cookie**（详见第 2 节），不建 sessions 表。理由：
- Next 16 Proxy 默认 Node runtime 虽能查 DB，但官方警告 Proxy 不应依赖共享模块/全局状态（连接池单例在 proxy 上下文不可靠）；签名验证是纯计算，任何上下文可用
- 免去每请求一次 session 表查询与过期清理任务；单实例自托管场景无"服务端主动吊销全部设备"的强需求
- 需要"改密后全端登出"的能力，由 **users.token_version** 机制补齐（见 2.2），无需 session 表

---

## 2. 认证方案

### 2.1 bcrypt 库选型

**`bcryptjs@^3.0.0`**（纯 JS 实现，零原生编译，Windows 无 node-gyp/python 依赖问题；API `hash/compare` 均支持 Promise）。成本敏感度：本机单人级并发，纯 JS 的性能损耗无感。

### 2.2 会话凭证设计（签名 Cookie，非 JWT 库）

Token 格式（自实现约 40 行，不引入 jsonwebtoken 等依赖）：

```
v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256 签名)>
payload = { uid, un, role, ver, iat, exp }   // ver = token_version
```

- 签名密钥：`AUTH_SECRET`（.env.local 可配置）；缺省时沿用 enc_key 的模式——首次使用自动生成 64 字节随机数并落盘 `.data/auth_secret`。密钥丢失仅导致全体重新登录，无数据风险
- 签名/校验模块 `app/lib/authToken.ts` 用 **Web Crypto API（globalThis.crypto.subtle，Node 22/24 全局可用）**，保证 proxy 与 Route Handler 两套上下文代码一致
- 校验步骤：拆段 → 重算 HMAC（恒定时间比较）→ 检查 exp → 通过。**不查 DB**
- Route Handler 内的完整校验 `requireUser(req)`（`app/lib/auth.ts`）：解析 token 后再 `SELECT token_version FROM users WHERE id=?` 核对 ver，不符即 401——这就是"改密踢掉所有旧会话"的实现路径，也是文档要求的纵深防御
- **R11 防会话固定**：登录/注册成功总是签发全新 token（新 iat/新随机段）；匿名期本就无会话，风险面极小；改密场景由 token_version 覆盖

### 2.3 Cookie 属性

| 属性 | 值 | 说明 |
|---|---|---|
| name | `ma_session` | |
| HttpOnly | ✅ | JS 不可读 |
| SameSite | `Lax` | 本站跳转携带，防 CSRF 基线 |
| Secure | ❌（本机 http） | 若未来挂 HTTPS，用环境变量 `COOKIE_SECURE=1` 开启 |
| Path | `/` | |
| Max-Age | `604800`（7 天，绝对过期） | PRD 建议 7 天 |

**滑动续期**：`GET /api/auth/me` 发现 token 剩余有效期 < 3 天时，响应重签 7 天新 Cookie（前端 HomeClient 挂载时本就会调 me，零额外请求成本）。

### 2.4 API 设计

| 接口 | 方法 | 请求体 | 响应 / 行为 |
|---|---|---|---|
| `/api/auth/register` | POST | `{username, password}` | 校验（见 2.6/2.7）→ 事务内：查用户数，为 0 则 role=admin + claim 无主会议（见第 4 节）→ 插入 users → 签发 Cookie。失败 400（含具体校验原因；用户名已占提示"用户名已存在"——注册场景允许提示） |
| `/api/auth/login` | POST | `{username, password}` | 查用户（ci 匹配）→ bcrypt.compare → 失败统一 401 `"用户名或密码错误"`（不暴露账号是否存在，R2）→ 成功清失败计数并签发 Cookie |
| `/api/auth/logout` | POST | — | 清 Cookie（Set-Cookie 过期），200 |
| `/api/auth/me` | GET | — | 返回 `{username, role}`；剩余 <3 天时重签 Cookie（滑动续期） |
| `/api/auth/password` | POST | `{oldPassword, newPassword}` | 验旧密码 → 新密码强度校验 → 更新 hash 且 `token_version = token_version + 1` → 重签新 Cookie |
| `/api/admin/users` | GET | — | **requireAdmin**；返回 `[{id, username, role, createdAt}]`（只读，R10/Q3） |

限速对 register/login/password 生效（见第 5 节），超限返回 429。

### 2.5 proxy.ts 鉴权设计（项目根，Next 16 proxy 约定）

```ts
// proxy.ts（示意）
export const config = {
  matcher: [
    // 排除：静态资源、认证 API、健康检查；其余全部过闸
    '/((?!_next/static|_next/image|_next/data|favicon.ico|api/auth|api/health|.*\\.png$|.*\\.ico$).*)',
  ],
};
export async function proxy(request: NextRequest) {
  const token = request.cookies.get("ma_session")?.value;
  const ok = token ? await verifyToken(token) : false;   // 仅签名+exp，无 DB
  if (request.nextUrl.pathname.startsWith("/api/")) {
    if (!ok) return NextResponse.json({ error: "未登录" }, { status: 401 });
    return NextResponse.next();
  }
  if (!ok) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}
```

**豁免清单**：`/login`、`/register`、`/api/auth/*`、`/api/health`、`_next/*` 静态、`favicon.ico` 等静态文件。`/api/models`、`/api/test-key` **不豁免**（PRD R4 明确要求未登录 401；SettingsModal 测试密钥前用户已登录）。

**双重防线**：proxy 只解决"访客体验"（页面跳登录、API 直接 401）；**每个受保护 Route Handler / Server Component 内部仍调 requireUser()**（文档要求，防 matcher 遗漏/Server Function 绕过）。

---

## 3. 数据隔离改造点清单

| 模块/文件 | 改造内容 |
|---|---|
| `app/lib/meetingRepo.ts` | 全部函数签名**增加 userId 首参**：`saveMeeting(userId, roomId, data)`、`getMeeting(userId, roomId)`、`listMeetings(userId, limit)`、`updateMeeting(userId, ...)`、`deleteMeeting(userId, ...)`；SQL 一律 `WHERE user_id = ?`；update/delete 影响行数为 0 → 返回 false（路由映射 **404**，不暴露他人会议存在性，落验收标准 3） |
| `app/lib/settingsRepo.ts` | 改挂 user_settings 表：`getSettings(userId)` / `saveSettings(userId, patch)`；`initialized` 语义变为"**当前用户**是否已存任一配置" |
| `app/lib/serverSettings.ts` | `resolveLlmConfig(req, userId)` / `resolveAsrConfig(req, userId)`：链路变为 **请求头 x-\* → user_settings(WHERE user_id) → 空**（BYOK 落点） |
| `/api/meetings` | handler 开头 `const user = await requireUser(req)`（null → 401），userId 透传 repo |
| `/api/settings` | 同上；GET 脱敏逻辑不变，只是数据源按用户 |
| `/api/chat` `/api/summarize` | requireUser → `resolveLlmConfig(req, user.id)`；AI 逻辑不动 |
| `/api/transcribe` | requireUser → `resolveAsrConfig(req, user.id)` |
| `/api/models` `/api/test-key` | 仅加 requireUser（401 门禁），请求体取密钥逻辑不变 |
| `/api/health` | 保持豁免，不鉴权 |
| `app/result/[roomId]/page.tsx` | Server Component：用 `cookies()`（next/headers）读 token → requireUser 等价校验 → `getMeeting(user.id, roomId)`；无权/不存在统一 404 视图 |
| 前端 fetch 层 | 各组件对 401 统一处理：跳转 `/login`（HomeClient 内封装一个 `authFetch` 或在各调用点判断） |

**initSettingsSync 多用户化**（单用户 initialized 门闩的改造，重点）：

```
触发：HomeClient 挂载 + 已登录（/api/auth/me 成功）
条件（全部满足才上报）：
  ① localStorage 无 meeting_ai_settings_migrated_v3 标记
  ② localStorage SETTINGS_KEY(v2/v1) 有有效旧配置
  ③ GET /api/settings 返回该用户 initialized === false
动作：PUT /api/settings 全量上报 → 设置 ① 标记
效果：每个浏览器只迁移一次；同浏览器换账号登录不再重复上报（标记已设）；
     新用户在新设备本地无旧数据 → 天然不触发；服务端 initialized 门闩由
     "全局单行" 变为 "按用户"（settingsRepo 已改）
```

---

## 4. 存量迁移（首个用户 claim，幂等）

注册接口**事务内**执行（`app/lib/userRepo.ts` → `registerUser()`）：

```
START TRANSACTION;
  SELECT id FROM users LIMIT 1 FOR UPDATE;      -- 锁住用户集，防并发双首注册
  SELECT COUNT(*) → 用户数 N;
  INSERT INTO users (...) ;                     -- N==0 时 role='admin'，否则 'user'
  IF N == 0:
    UPDATE meetings SET user_id = 新用户id WHERE user_id IS NULL;   -- 天然幂等
    INSERT INTO migration_markers (name) VALUES ('claim_meetings_v1')
      ON DUPLICATE KEY UPDATE done_at = done_at;                    -- 登记标记（幂等写法）
COMMIT;
```

- 幂等性：`WHERE user_id IS NULL` 决定重跑只影响未归属行；marker 仅作审计记录
- 并发：`FOR UPDATE` 锁住 users 首行/间隙，两个并发注册只有一个看到 COUNT=0（单实例 MySQL，够用；正文中注明此推理）
- app_settings 空表直接 DROP，无数据迁移（1.3 节）

## 5. 限速方案（Q4 落定，R8/R9）

`app/lib/rateLimit.ts`——**内存固定窗口计数器**（单实例自托管，够用；Map<key, {count, windowStart}>，条目数 > 500 时惰性清理过期项；进程重启计数清零，可接受并注明）：

| 场景 | 键 | 阈值 | 超限行为 |
|---|---|---|---|
| 登录失败 | `login:<ip>:<username>` | 15 分钟窗口内 5 次 | 429 `"尝试次数过多，请 15 分钟后再试"`；成功登录清零 |
| 注册 | `reg:<ip>` | 1 小时窗口 5 次 | 429 |
| 密码修改 | `pwd:<userId>` | 1 小时窗口 5 次 | 429 |

## 6. 校验规则定稿（Q4 密码 / Q5 用户名）

- **密码**：8–64 位，须同时含字母（`[A-Za-z]`）与数字（`\d`）；前后端双重校验，注册/改密页给出明确提示
- **用户名**（Q5：**允许邮箱格式**，为未来邮箱验证预留）：
  - 普通格式：`^[A-Za-z0-9_]{3,24}$`
  - 或合法邮箱：`^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$`
  - 唯一性大小写不敏感（MySQL ci 排序规则天然实现，见 1.1）；本期仅作字符串存储，不发验证

## 7. 文件清单

**新增（13）**

| 文件 | 说明 |
|---|---|
| `proxy.ts`（项目根） | 全局鉴权闸：API 401 / 页面重定向 /login（Next 16 proxy 约定） |
| `app/lib/authToken.ts` | 签发/校验签名 Cookie（Web Crypto HMAC），proxy 与路由共用 |
| `app/lib/auth.ts` | `requireUser(req)`（含 token_version DB 核对）、`requireAdmin(req)`、Cookie 属性常量 |
| `app/lib/rateLimit.ts` | 内存固定窗口限速器 |
| `app/lib/userRepo.ts` | 注册（含首个用户 claim 事务）、按用户名查、改密、用户列表 |
| `app/lib/validation.ts` | 用户名/密码校验规则，前后端共用 |
| `app/api/auth/register/route.ts` | 注册 |
| `app/api/auth/login/route.ts` | 登录 |
| `app/api/auth/logout/route.ts` | 登出 |
| `app/api/auth/me/route.ts` | 当前用户 + 滑动续期 |
| `app/api/auth/password/route.ts` | 修改密码（R13） |
| `app/api/admin/users/route.ts` | 管理员只读用户列表（R10） |
| `app/login/page.tsx`、`app/register/page.tsx` | 登录/注册页（Client Component，Tailwind） |

**修改（12+）**

| 文件 | 改动 |
|---|---|
| `package.json` | + `bcryptjs` |
| `app/lib/bootstrap.ts` | 建 users/user_settings、meetings 条件 ALTER（查 information_schema 幂等）、DROP app_settings |
| `app/lib/meetingRepo.ts` | 全函数加 userId + WHERE 隔离（第 3 节） |
| `app/lib/settingsRepo.ts` | 改挂 user_settings，按用户读写 |
| `app/lib/serverSettings.ts` | resolve 函数加 userId 参数 |
| `app/api/meetings/route.ts`、`chat`、`summarize`、`transcribe`、`models`、`test-key`、`settings` | 加 requireUser + 透传 userId |
| `app/result/[roomId]/page.tsx` | cookies() 取身份 + 按用户取数 |
| `app/components/HomeClient.tsx` | 顶栏用户名+登出（/api/auth/me）、401 统一跳 /login、initSettingsSync 多用户化 |
| `app/components/SettingsModal.tsx` | 新增"账号"区块：修改密码 |
| `app/lib/settings.ts` | initSettingsSync 门闩逻辑改造（第 3 节） |
| `scripts/test/run-all.mjs` | 18 用例改造：先注册/登录取 Cookie，新增隔离与 401 用例 |

**删除（0 个文件）**：`app_settings` 表以 DDL DROP（无数据）。

## 8. 任务列表

**T01 认证基础设施**（P0，依赖：无）
文件：package.json、app/lib/authToken.ts、app/lib/auth.ts、app/lib/rateLimit.ts、app/lib/validation.ts、proxy.ts、.env.local（AUTH_SECRET 可选）
验收：token 签发/篡改/过期校验单测通过；proxy 对未登录页面 302→/login、未登录 API 401、豁免路径放行；⚠️ 文件名必须是 proxy.ts（Next 16），写码前查 node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md

**T02 数据库迁移 + 数据层用户化**（P0，依赖：T01）
文件：app/lib/bootstrap.ts、app/lib/userRepo.ts、app/lib/meetingRepo.ts、app/lib/settingsRepo.ts、app/lib/serverSettings.ts
验收：bootstrap 重复执行幂等（列不重复加、表不重建）；userRepo 注册事务正确产出 admin + claim 4 条会议，重跑不重复；meetingRepo 传入他人 userId 查不到数据

**T03 认证 API + 登录注册页**（P0，依赖：T01、T02）
文件：api/auth/register、login、logout、me、password、api/admin/users、app/login/page.tsx、app/register/page.tsx
验收：注册→自动登录→me 返回身份；弱密码/重名被 400 拒绝；错误登录统一模糊 401；连败 5 次 429；改密后旧 Cookie 全部失效（token_version）；Cookie 属性符合 2.3

**T04 业务路由与前端接入**（P0，依赖：T02、T03）
文件：api/meetings、settings、chat、summarize、transcribe、models、test-key、result/[roomId]/page.tsx、HomeClient.tsx、SettingsModal.tsx、app/lib/settings.ts
验收：伪造他人 meeting id 返回 404；各用户 BYOK 互不可见且密文落库；未登录 curl 任意业务 API 均 401；initSettingsSync 每浏览器只迁移一次、换账号不重复

**T05 回归测试与验收走查**（P0，依赖：T04）
文件：scripts/test/run-all.mjs、必要时以上文件的修正
验收：`CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build` 通过；回归脚本全绿（含新增隔离/401/限速用例）；PRD 第 7 节 7 条验收标准逐条走查通过

依赖图：T01 → T02 → T03 → T04 → T05（T01 与 T02 可部分并行，但 T02 的 bootstrap 依赖 T01 的目录约定，按序执行最稳）

## 9. 依赖包清单

```
- bcryptjs@^3.0.0 : 纯 JS bcrypt 哈希（注册/登录/改密），Windows 无原生编译负担
```
不新增其他依赖（会话签名用内建 Web Crypto，限速自实现，校验正则自实现）。

## 10. 共享知识

1. **proxy.ts 命名铁律**：Next 16 无 middleware.ts，只有根目录 proxy.ts、导出函数名 proxy；runtime 不可配置（默认 Node）。写码前读 bundled docs 的 proxy.md。
2. **纵深防御铁律**：每个受保护 Route Handler/Server Component 必须自行 requireUser()，proxy 只是体验层闸门，不是安全边界（官方文档明示）。
3. **身份获取唯一入口**：Route Handler 用 `requireUser(req)`；Server Component 用 `cookies()`（next/headers）+ 同一校验模块。禁止自行解析 Cookie。
4. **隔离铁律**：meetingRepo/settingsRepo 所有 SQL 必带 `user_id = ?`；越权访问统一 404（不暴露存在性）；新增任何数据函数必须带 userId。
5. **Token 契约**：payload `{uid, un, role, ver, iat, exp}`，ver 对应 users.token_version；改密必须 +1；authToken.ts 不 import 任何 DB 模块（保证 proxy 可用）。
6. **Cookie 契约**：名 `ma_session`，HttpOnly + SameSite=Lax + Path=/ + Max-Age 7 天；Secure 由 env `COOKIE_SECURE` 控制。
7. **错误契约**：登录失败一律 401 `"用户名或密码错误"`；越权一律 404；限速 429；未登录 proxy/API 401 `{error}`；沿用现有 `{success, error}` 响应风格。
8. **密钥文件约定**：`.data/auth_secret`（会话签名）与 `.data/enc_key`（字段加密）并列，均自动生成、不入 git；AUTH_SECRET env 可覆盖前者。

> **主理人批注（齐活林 · 2026-09-30 收尾）**：实测 auth_secret 落盘于项目根 `data/auth_secret`（authToken.ts 的 DATA_DIR 为 `data`，与 `.data/` 不一致）——功能无影响，P3 偏差已记 backlog 择机统一。另：登出为无状态清 Cookie 设计，服务端强吊销（单点登出/踢全设备）列入后续迭代。
9. **校验规则唯一来源** `app/lib/validation.ts`，前后端 import 同一份，禁止前端另写正则。
10. **限速器约定**：仅 auth 类接口使用；内存实现重启清零属已知限制，不落库。

## 11. 待明确事项

1. **HTTPS 部署形态**：当前 Secure=false 适配 http 局域网；若未来上 HTTPS，需设置 `COOKIE_SECURE=1`（已在 Cookie 属性中预留）。
2. **多实例部署**：限速器与滑动续期按单实例设计；若未来多实例，限速需迁 Redis/session 需迁表（本期不做，留扩展点）。
3. **邮箱格式用户名与未来邮箱验证**：本期仅格式预留，未做所有权验证；同一邮箱可被他人先注册（视为普通用户名），产品侧已知悉。
4. **回归脚本改造方式**：建议 run-all.mjs 先走 /api/auth/register+login 拿 Cookie（Set-Cookie 解析）再复用现有用例；工程师如发现直查 DB 造用户更稳（bcrypt hash 预生成），可自行选择，但隔离用例必须真实走 API。
5. **`app_settings` DROP 时机**：设计为 bootstrap 幂等流程内执行；若工程师执行时发现表内意外出现数据（与"空配置"确认不符），停止 DROP 并回报主理人。
