# 会议 AI 数据库化增量架构设计 + 任务分解

> 恢复说明：本文档为迭代 v1（数据库化）设计原文。原存放于 `docs/system_design.md`（滚动最新约定），2026-09-30 被迭代 v3（验证码与安全强化）设计覆写后，由齐活林从会话记录原样恢复至此归档。最新设计请看 `docs/system_design-验证码与安全强化.md`。

已拍板决策：真数据库、设置入库同步、localStorage 首访一次性上报迁移（Q3）；Q1/Q2/Q4 由本文落定。

## 1. 数据库选型结论

### 对比

| 维度 | PostgreSQL 16 | MySQL 8 |
|---|---|---|
| Windows 便携部署 | ✅ 官方 zip binaries（EDB），解压即用；`initdb` 一条命令初始化，零配置文件 | ✅ 官方 zip，但需手写 `my.ini`（basedir/datadir/字符集），初始化步骤更多、出错面更大 |
| 嵌套 JSON 数据（todos/mindmap/key_decisions/risks） | ✅ 原生 `JSONB`：二进制存储、GIN 索引、操作符丰富；本项目是"整存整取"场景，零序列化心智负担 | ⚠️ 有 JSON 类型，但函数与索引能力弱于 JSONB |
| 数组字段（key_decisions/risks） | ✅ 可用 `text[]`/`JSONB` | ⚠️ 无原生数组，只能 JSON |
| Node 驱动成熟度 | ✅ `pg` 事实标准 | ✅ `mysql2` |

### 结论：PostgreSQL 16

理由：① Windows 便携化成本最低（initdb → pg_ctl start → createdb 三步，不注册服务不写注册表）；② JSONB 与嵌套纪要结构完美适配，无需拆表；③ 单人小数据量场景选运维最简单的。

（后记：本设计执行当日，老总提供本机 MySQL 凭据，数据层整体切换至 MySQL 9.7.2，详见 `docs/mysql-切换说明-2026-09-30.md`。下述表结构中的 JSONB/TIMESTAMPTZ 在 MySQL 侧对应 JSON/DATETIME(3)，方言映射见切换说明。）

## 2. 表结构设计（DDL，由 bootstrap.ts 启动时幂等自动建）

```sql
CREATE TABLE IF NOT EXISTS meetings (
    id             VARCHAR(64)  PRIMARY KEY,
    title          TEXT         NOT NULL,
    style          VARCHAR(32),
    type           VARCHAR(32),
    summary        TEXT         NOT NULL DEFAULT '',
    key_decisions  JSONB        NOT NULL DEFAULT '[]',  -- string[]
    risks          JSONB        NOT NULL DEFAULT '[]',  -- string[]
    mindmap        JSONB        NOT NULL DEFAULT '[]',  -- MindMapNode[] 嵌套树
    todos          JSONB        NOT NULL DEFAULT '[]',  -- Todo[]
    transcript     TEXT,
    audio_url      TEXT,
    duration       VARCHAR(32),
    word_count     INTEGER,
    created_at     TIMESTAMPTZ  NOT NULL,
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meetings_created_at ON meetings (created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
    id              INTEGER     PRIMARY KEY CHECK (id = 1),
    llm_base_url    TEXT,
    llm_api_key_enc TEXT,       -- AES-256-GCM 密文 v1:<iv>:<tag>:<cipher>
    llm_model       TEXT,
    asr_base_url    TEXT,
    asr_api_key_enc TEXT,
    asr_model       TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS migration_markers (
    name    VARCHAR(64)  PRIMARY KEY,
    done_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

嵌套结构说明：todos/mindmap/key_decisions/risks 均为"随纪要整体读写、无跨行查询需求"，JSONB 整存整取，拆表只有 join 成本无查询收益。

## 3. 数据访问层方案

- 驱动：`pg` + Pool（max:5）；Pool 挂 globalThis 单例，规避 dev 热重载连接泄漏（与现有 global.meetingStore 同手法）
- 统一入口：新建 `app/lib/meetingRepo.ts`（函数名与 store.ts 一致但**全部 async**）+ `app/lib/settingsRepo.ts`；**删除** `app/store.ts` 与 `app/lib/meetingStore.ts`（后者已核实零引用）
- 并发安全：写操作全部下沉单条 SQL——upsert 用 `INSERT ... ON CONFLICT (id) DO UPDATE`，删/改用 `RETURNING id` 判行数，由 PG 行级锁保证原子性，消除"整体覆写 JSON"丢失窗口
- 引导：`app/lib/bootstrap.ts` 的 `ensureDatabase()` 进程级 Promise 单例（建表 → 查 migration_markers → JSON 迁移），所有 repo 函数入口 await 之（lazy 首次触发，不阻塞模块加载）
- 类型归属：MeetingData/Todo/MindMapNode 移入 `app/lib/types.ts`，前后端统一 import

## 4. 设置同步方案（落定 Q2 / Q4）

### 4.1 /api/settings
**GET** 脱敏返回：`{ llmBaseUrl, llmModel, llmHasApiKey, llmApiKeyMasked:"sk-****abcd", asrBaseUrl, asrModel, asrHasApiKey, asrApiKeyMasked, initialized }`——密钥永不明文回传。
**PUT** 保存：`{ llmBaseUrl?, llmModel?, llmApiKey?, clearLlmApiKey?, asr... }`。规则：apiKey 空串/缺省且未 clear → 保留库中旧值（配合脱敏回显，用户不动密钥框即不会误清）。

### 4.2 服务端读取优先级（DB 为主、请求头可覆盖）
新增 `app/lib/serverSettings.ts`：`resolveLlmConfig(req)` / `resolveAsrConfig(req)`，优先级 请求头 x-* → DB → 空。
路由改造点：
- /api/chat、/api/summarize：改调 resolveLlmConfig（AI 逻辑零改动）
- /api/transcribe：改调 resolveAsrConfig
- **/api/test-key、/api/models：不变**（二者从请求体读用户刚输入的密钥做测试，语义与 DB 无关）——Q4 落定
- 前端不再发送 x-* 配置头（getApiHeaders 退役），但保留服务端头覆盖能力作兼容期兜底

### 4.3 密钥存储安全评估（落定 Q2）
**决策：AES-256-GCM 加密存储，主密钥落本机文件 `.data/enc_key`（首次使用自动生成 32 字节随机数）**。理由：防拖库（备份外泄）是真实收益且密钥与 DB 分文件构成事实两因素；不做 KMS/env 注入等重方案（单人本机场景运维负担>收益，env 易泄日志）；GET 永不明文回传是无登录场景最关键边界；本机 root 级攻击任何方案无解，接受。

## 5. 存量数据迁移方案

### 5.1 meetings.json → DB（服务端自动、幂等）
bootstrap.ts 首次 DB 访问时执行：查标记 `'meetings_json_v1'` → 已有则跳过；先备份为 `.data/meetings.json.bak-<ts>`；逐条 `INSERT ... ON CONFLICT (id) DO NOTHING`；成功写标记、失败抛错不写标记（下次重试）；输出校验报告（源条数/导入条数/冲突跳过数 + 首条 title/todos 抽样比对，落定 R7）。读取源即切 DB（DO NOTHING + 备份兜底）；`.data/meetings.json` 此后只读不写，观察一版后可手动删。手动重跑 = 删标记行。

### 5.2 localStorage → DB（首访一次性上报，落定 Q3）
HomeClient 挂载时 `initSettingsSync()`（Promise 去重）：GET /api/settings → initialized=true 则结束（DB 为准）；false 且本地有旧配置 → PUT 全量上报 → 写本地标记 meeting_ai_settings_migrated_v3。幂等由服务端 initialized 门闩保证；失败静默降级不挡首屏。

### 5.3 app/lib/settings.ts 重写形态
UserApiSettings/SETTINGS_KEY 保留；getApiSettings→loadSettings()（GET+内存缓存）；saveApiSettings→persistSettings()（PUT）；clearApiSettings 仅清本地；getApiHeaders 删除，MeetingChat 调用点同步移除。

## 6. 文件清单

**新增（12）**：app/lib/types.ts、app/lib/db.ts、app/lib/bootstrap.ts、app/lib/meetingRepo.ts、app/lib/crypto.ts、app/lib/settingsRepo.ts、app/lib/serverSettings.ts、app/api/settings/route.ts、app/api/health/route.ts（GET 探活 SELECT 1，落定 R8）、scripts/db/setup-postgres.ps1、.env.example、.env.local

**修改（10+）**：package.json（+pg/@types/pg）、app/api/meetings/route.ts（改 meetingRepo + async 化）、app/api/chat/route.ts、app/api/summarize/route.ts、app/api/transcribe/route.ts（改 serverSettings）、app/result/[roomId]/page.tsx（repo+types）、app/lib/settings.ts（重写）、app/components/SettingsModal.tsx（读写走 API + 留空保留/显式清除密钥）、app/components/HomeClient.tsx（initSettingsSync + DB 故障明确提示）、app/components/MeetingChat.tsx（移除 getApiHeaders）、其余仅 import 类型的约 4 个组件（改 types import，工程师以 grep 全量确认）

**删除（2）**：app/store.ts（改完引用后删）、app/lib/meetingStore.ts（已核实零引用可直删）

## 7. 任务列表

**T01 数据库供给与项目基础设施**（P0，无依赖）
文件：package.json、.env.local、.env.example、scripts/db/setup-postgres.ps1
验收：psql 连 meeting_ai 库 select 1 成功；npm run dev 不缺依赖

**T02 数据访问层 + 建表迁移引导**（P0，依赖 T01）
文件：app/lib/types.ts、db.ts、bootstrap.ts、crypto.ts、meetingRepo.ts、settingsRepo.ts
验收：CRUD 全通过；JSON 数据完整入库且备份生成、重跑不重复；密文落库可解密还原

**T03 API 路由改造**（P0，依赖 T02）
文件：api/meetings、api/chat、api/summarize、api/transcribe、api/settings（新）、api/health（新）、lib/serverSettings.ts
验收：curl 全路由通过；GET /api/settings 无明文密钥；DB 停机时 health 报 down、业务路由报明确错误；⚠️ 写码前按 AGENTS.md 查阅 node_modules/next/dist/docs/ 的 Route Handler 约定，读取型路由加 export const dynamic="force-dynamic"

**T04 前端设置同步改造**（P0，依赖 T02、T03）
文件：app/lib/settings.ts、SettingsModal.tsx、HomeClient.tsx、MeetingChat.tsx + 类型 import 组件
验收：保存后换浏览器配置自动生效；旧 localStorage 首访自动上报且不重复；无请求头下转写/总结正常；DB 故障有明确提示

**T05 冗余清理 + 集成验证**（P0，依赖 T03、T04）
文件：删 app/store.ts、app/lib/meetingStore.ts；grep "@/app/store" 与 "meetingStore" 零命中；联调微调
验收：npm run build 通过；PRD 验收标准逐条走查（换浏览器可见全部历史、密钥免重填、并发删/增无丢失、.data/meetings.json 不再被写、全项目唯一数据访问模块）

依赖图：T01 → T02 → {T03, T04} → T05

## 8. 依赖包清单
- pg@^8.13.0（PostgreSQL 驱动 + 连接池，运行时）
- @types/pg@^8.11.0（devDependencies）
不引入 ORM 与迁移工具（模型简单，手写 SQL + 代码建表最可控）。

## 9. 共享知识
1. 类型唯一归属：MeetingData/Todo/MindMapNode → app/lib/types.ts；UserApiSettings → app/lib/settings.ts；禁止再 import @/app/store
2. 连接串唯一来源 process.env.DATABASE_URL；Pool 只经 app/lib/db.ts 获取
3. repo 函数全部 async，调用点必须 await（与旧 store 最大签名差异）
4. 所有读 DB 的 GET 路由加 `export const dynamic = "force-dynamic"`（防 Next 16 静态缓存），保留 runtime="nodejs"；写码前查 node_modules/next/dist/docs/
5. 密钥红线：任何响应不含明文 apiKey；密文格式 v1:<iv>:<tag>:<cipher> 只经 crypto.ts 读写
6. 数据格式兼容：DB created_at 为 TIMESTAMPTZ，repo 对外仍输出 ISO 字符串（MeetingData.createdAt 契约不变，前端零改动）；JSONB 直接映射数组/树类型
7. 一切一次性迁移登记 migration_markers；.data/meetings.json 只读，*.bak-* 备份保留不删
8. DB 故障返回 500 + 中文 error（沿用现有格式），/api/health 供诊断

## 10. 待明确事项
1. EDB zip 需手动下载；网络受限时备案 winget install PostgreSQL.PostgreSQL.16（会注册服务，与便携原则冲突，仅备案并注明）
2. 迁移竞态：升级后先新建会议后迁移完成——DO NOTHING + 新 id 不同，无冲突，已确认无需加锁
3. result/[roomId]/page.tsx 的 params 在 Next 15+ 为 Promise，改造取数时顺带核实现有写法是否符合 Next 16 文档，不符则一并修正（不改行为）
4. 4 个仅 import 类型的组件具体文件名未逐一列出（grep 已确认存在），工程师执行 T04 时以 grep -rn "@/app/store" 结果为准补全

—— 完 ——
