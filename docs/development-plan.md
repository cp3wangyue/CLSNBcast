# 开发顺序与阶段计划

> 按依赖关系与风险排序。**每项独立 commit**，每阶段结束必须跑 `typecheck + build + test`。
>
> 相关文档：现状分析 → [architecture-analysis.md](./architecture-analysis.md) ｜ 数据模型 → [data-model-design.md](./data-model-design.md) ｜ 问题要点 → [open-questions.md](./open-questions.md)

---

## 0. 排序理由

| 顺序 | 阶段 | 为什么排在这里 |
|---|---|---|
| 1 | **Phase 0 基础工程** | 你要求「每完成一个阶段必须执行 build、typecheck 和相关测试」，而当前基线**没有 typecheck 脚本、没有任何测试框架**，验证无法执行。且后续所有新表/新列都需要版本化 migration。这是硬前置。 |
| 2 | **Phase 1 AgoraProvider** | 会话必须先绑定 Provider 并落 App ID 快照，否则自由画质放开后无法把用量归属到账号，也无法保证「同一 Session 同一 App ID」的不变量。同时它修复一个已确认的严重缺陷（[architecture-analysis.md](./architecture-analysis.md) 第 4 节）。 |
| 3 | **Phase 2 UsageLedger** | 账本必须先在位，才能记录任意档位。现有 `viewer_duration_ms` 是单一聚合值，无法表达「会话中途切换档位」，而自由画质必然引入档位变化。 |
| 4 | **Phase 3 自由画质** | 依赖 Phase 1（Provider 绑定）与 Phase 2（账本记录档位）。 |
| 5 | **Phase 4 自托管部署** | 与前面**无代码依赖**，但建议至少放在 Phase 1 之后，避免 compose 反复改环境变量（`SECRET_ENCRYPTION_KEY` 等）。如果你想要一个可测试的 VPS 环境，可以提前到 Phase 1 之后并行做。 |
| 6 | **Phase 5 安全加固** | 独立，可随时插入。 |

**每阶段的验收命令**（Phase 0 建好后统一为一条）：

```bash
npm run verify        # = typecheck + build + test
```

---

## Phase 0 — 基础工程

**目标**：让「阶段验收」这件事真正可执行；引入版本化迁移与加密基础设施。**不改任何业务行为。**

### 任务

- [x] **0-1 测试与类型检查基础设施**
  - [x] 选定测试框架并接入 server 与 web（统一用 **vitest**，减少工具种类）
  - [x] 三个 `package.json` 加 `typecheck` / `test` 脚本
  - [x] 根 `package.json` 加 `verify` = `typecheck` + `build` + `test`
  - [x] 写第一批测试：先覆盖既有纯函数（`session.types` 计费系数与档位、`utils` 类名合并），
        `SecretCryptoService` 与 `QualityValidationService` 的测试随 0-3 与 Phase 3 补
  - [x] 服务端 `tsconfig.json` 保持 `strictNullChecks: false` / `noImplicitAny: false`，**未一次性收紧**，留到后续单独评估
  - [x] 说明：vitest 锁在 `^3`（vitest 5 要求 vite ≥6，而 web 在 vite 5.4.10）
- [x] **0-2 版本化 migration**
  - [x] 建 `schema_migrations` 表（见 [data-model-design.md](./data-model-design.md) 第 5 节）
  - [x] 建 `server/src/modules/database/migrations/` 目录与注册表
  - [x] 把现有 `migrate()` 的全部内容包装为 `version 1: baseline`，**完全保留其幂等语义**
  - [x] 加一个迁移框架的单测（模拟「新库」与「已有库」两条路径）
  - [x] ⚠️ 顺带修一个被 E2E 验证抓到的回归：在 `server/` 根目录新增 `vitest.config.ts`
        会把 tsc 推断的 `rootDir` 上移，产物从 `dist/main.js` 变成 `dist/src/main.js`，
        直接打断 `Dockerfile` 的 `CMD` 与 `deploy.sh` 的存在性检查。已在
        `server/tsconfig.build.json` 显式固定 `rootDir: "./src"` 并排除构建配置
  - [x] ⚠️ 顺带修一个**上游遗留的严重缺陷**：`tsconfig.json` 的 `incremental: true` 把
        增量信息写到 `dist` 之外的 `server/tsconfig.build.tsbuildinfo`，而 `nest-cli.json`
        开了 `deleteOutDir`（每次构建先清空 `dist`）。两者组合导致**第二次及以后的构建
        什么都不输出**，`dist` 变成空目录或只剩改动过的文件 —— `deploy.sh` 与 Docker 镜像
        都会因此拿到残缺产物。已在该文件设 `incremental: false`（dist 每次被清空，增量缓存
        本来也无收益）
- [x] **0-3 `SecretCryptoService`**
  - [x] AES-256-GCM + 随机 IV + `v1:<iv>:<tag>:<ct>` 版本前缀
  - [x] `SECRET_ENCRYPTION_KEY` 环境变量：格式非法时**构造即抛错**（启动阶段失败）
  - [x] 启动门禁 `assertUsableForExistingSecrets()`：库里已有密文但密钥缺失 → 抛错退出。
        调用方（Phase 1 的 Provider 仓储）负责传入待检查的密文列值，服务本身不感知表结构
  - [x] 单元测试（37 个）：往返、随机 IV 非确定性、信封格式、错误密钥、密文/标签/IV 篡改、
        段数与版本异常、错误信息与日志均不含密钥或明文
  - [x] `CryptoModule` 以 `@Global` 注册进 `AppModule`；`.env.example` 补 `SECRET_ENCRYPTION_KEY`
  - [x] 无消费者，纯新增，零回归风险

### 验收

- [x] `npm run verify` 通过（83 个单测：server 75 + web 8）
- [x] 用真实 SQLite 文件跑通三条路径：新库建库、存量库（无 `schema_migrations`）接管且数据无损、
      重复启动幂等
- [x] 确认 `server/dist/main.js` 存在，且**连续三次构建**都产出完整 `dist`（47 个 js、11 个模块）
- [x] 用真实 Nest 模块图启动验证四种密钥场景：未设密钥可启动、hex/base64 密钥可用且往返正确、
      非法密钥 fail-fast 退出码非 0
- [x] 删除 `data/` 后启动：新库结构完整（10 张表含 `schema_migrations`），全部 HTTP 端点正常
      （`/`、favicon、`/api/notices`、`/api/meta/admin-migration`、SPA 回退均 200，
      未鉴权的 `/api/super/config` 正确 401）

**Phase 0 已完成**（commit `2532f84` / `c23177a` / `b5a8e4f`）。

### commit 划分

`chore: add typecheck and test infrastructure` / `refactor: introduce versioned schema migrations` / `feat: add SecretCryptoService`

---

## Phase 1 — AgoraProvider（多租户）

**目标**：把 per-server 明文 Agora 配置抽象成可多租户、可加密、可配额、可容灾的 Provider 池；修复 App ID 漂移缺陷。

### 任务

- [x] **1-1 Provider 表与加密**
  - [x] migration `002-agora-providers`：建 `agora_providers` 表（[data-model-design.md](./data-model-design.md) 3.1）
  - [x] 同迁移给 `sessions` 加 `provider_id` + `agora_app_id`（**故意不加入 `ALLOWED_SESSION_COLS`**，
        唯一写入路径是新增的 `bindSessionProvider()`，它用 `WHERE provider_id = ''` 保证只能写一次，
        重绑会被拒绝并告警）
  - [x] `DatabaseService` 提供 `agora_providers` 的行级 CRUD（密文原样存取，**数据层不感知加密**）
  - [x] `AgoraProviderService`：**加解密只在这里发生**；管理端视图只暴露 `hasAppCertificate` /
        `hasCustomerSecret` 布尔值，明文秘密只能经 `getWithSecrets()` 取得（仅供签发与健康检查）
  - [x] `onModuleInit` 接入 `SecretCryptoService.assertUsableForExistingSecrets()` 启动门禁
  - [x] 拒绝删除已被会话引用的 Provider（避免账本与排查出现悬空引用），要停用请改为 `enabled=false`
  - [x] 顺带：`DatabaseService` 支持 `DATA_DIR` 覆盖数据目录（测试隔离用，部署时也可指定）
  - [x] 单测 46 个：owner 三态、优先级排序、quota 可空、14 项校验、证书确实加密落库、
        管理端视图序列化后不含明文、更新时 `undefined` 语义保持原证书、主密钥不匹配时解密抛错、
        启动门禁三态
- [x] **1-2 存量凭证迁移**
  - [x] 把每个配了 `agora_app_id` + `agora_app_certificate` 的服务器，转成 `owner_type='space'`
        的 provider 行（证书加密）。**放在 `AgoraProviderService.onModuleInit` 而非 migration**：
        它需要加密服务，且必须能在「未配置密钥」时安全跳过 —— migration 是纯 DB 函数，
        不应依赖运行时服务
  - [x] 回填该服务器存量 `sessions.provider_id` / `agora_app_id`（条件 `provider_id = ''`，不覆盖已绑定）
  - [x] 幂等：同 ownerId 已有 space Provider 就跳过，重复启动安全
  - [x] 健壮性：单个服务器数据坏掉（App ID 含空白等）只记 error，不阻断其余迁移与启动；
        `guildName` 为空回退 serverId；越界 `tokenExpireSec` 夹取到 `[60, 86400]` 而不是抛错
  - [x] 迁移完成后**清空** `servers.agora_app_certificate`（秘密不得明文落盘）。
        清空动作与 Token 签发切换在同一 commit，因此不存在「旧路径读不到证书」的窗口
  - [x] 🔒 同时**关闭明文写入路径**：把 `agora_app_id` / `agora_app_certificate` /
        `agora_token_expire_sec` 从 `ALLOWED_SERVER_COLS` 与两个更新 DTO 中移除。
        否则 API 上仍存在一条把明文证书写回服务器记录的路径，而签发 Token 根本不会读它 ——
        属于「合规上必须堵掉」的缺口。这三列降级为只读历史字段，
        唯一写入者是存量迁移与 `clearServerCertificate()`（均走直接 SQL）
  - [x] 单测 11 个：迁移与加密落库、会话回填、三次启动仍只有一个 Provider、无密钥时告警跳过、
        多服务器各自迁移、坏数据隔离、空名兜底、过期时间夹取、日志不含明文
- [x] **1-3 Token 签发改造（修复 App ID 漂移）**
  - [x] `generateToken(session, uid, role)` 取代 `generateToken(channel, uid, role, serverId)`
  - [x] 从**会话快照**读取 Provider 与 App ID，不再实时查服务器配置
  - [x] App ID 一致性断言 + `PROVIDER_APPID_CHANGED` 错误码（附 `SESSION_PROVIDER_MISSING` /
        `PROVIDER_UNAVAILABLE` / `PROVIDER_NO_CERTIFICATE`）
  - [x] 更新调用点 `share.controller.ts`；删除原「返回空 appId 让前端自己猜」的分支
  - [x] **保持 `AgoraTokenResponse` 结构不变**（`{token, channel, uid, appId, expireSec}`），前端零改动
  - [x] 会话参数类型用结构化 `TokenSessionRef`，`ServerSession` 与 `ShareSession` 都满足，
        调用方无需类型转换
  - [x] 清空 `servers.agora_app_certificate`（与签发切换同一 commit，旧路径已无消费者）
  - [x] 单测 20 个：结构与旧实现一致、发布/观众 token 不同、漂移时**发布端与观众端都被拒绝**、
        漂移日志含两个 App ID 便于排查、改回后恢复可用、`updateSession` 改不动绑定列、
        `bindSessionProvider` 只能绑一次、响应与日志与错误信息均不含证书
- [x] **1-4 Provider 解析策略**
  - [x] `resolveForSession`：显式指定 → space 默认 → user BYOK → 平台池（按 priority 升序）
  - [x] 失败码 `NO_PROVIDER` / `NOT_AUTHORIZED` / `QUOTA_EXCEEDED`，message 为面向用户的文案
  - [x] 显式指定的权限校验：平台池仅管理员可指定；space / user 必须归属匹配
  - [x] 跳过已停用、`unhealthy`、无证书、超配额的 Provider；`degraded` 仍可用
  - [x] 会话创建流程接线；`SessionService.createSession` 抛 `ProviderUnavailableError`，
        KOOK 侧捕获后给用户明确提示（不再创建「注定不可用」的会话）
  - [x] 配额判断读账本汇总缓存，且**跨月后把过期估算值视为 0**
        （否则跑满过的 Provider 会永久被拦截）；周期键用 `Intl` 按时区计算，不用本地 `getMonth()`
  - [x] 单测：解析 4 条路径 + 3 种失败路径 + 跳过规则 + 配额边界（共 30 个）
  - [x] ⚠️ 判别字段用**字符串字面量**而非布尔 `ok`：本仓库 `strictNullChecks: false` 会把
        布尔字面量放宽为 `boolean`，导致联合类型无法判别收窄
- [x] **端到端验证（真实 DI 容器 + 真实数据库）**：16 项断言全部通过 —— 存量明文凭证被迁移并清空、
  证书可解密、管理端视图无明文、会话绑定 Provider 并快照 App ID、发布/观众端均可签发、
  **改 App ID 后活跃会话被拒绝且提示面向用户**、新会话使用新 App ID 正常工作
- [x] **1-5 管理端 API**（前端 UI 见下一项）
  - [x] 超管 `/api/super/providers`：list / get / create / update / delete，可配 ownerType 三态、
        priority、tokenExpireSec、quota（含 `quotaEnforced`）、`allowedPresetIds`、note
  - [x] 频道主 `/api/spaces/:platform/:externalId/providers`（含 `/api/server/:serverId` 旧路径别名）：
        list / create / update / delete，仅限本服务器
  - [x] **任何响应都不返回明文凭证**：统一走 `AgoraProviderAdminView`，只有
        `hasAppCertificate` / `hasCustomerSecret` 布尔值；明文没有任何读回接口
  - [x] 🔒 频道主创建时**服务端强制** `ownerType='space'` + `ownerId=该服务器`，
        请求里伪造这两个字段不生效（否则可越权创建平台池 Provider，占用我们的声网账号）；
        DTO 里也刻意不声明这两个字段，配合 `ValidationPipe` 的 `whitelist` 双重拦截
  - [x] 🔒 频道主改/删前校验目标 Provider 确属本服务器，阻断按 ID 越权操作他人凭证（IDOR）
  - [x] `AgoraProviderValidationError` 改为继承 `BadRequestException`，
        校验失败自动变成带 `{message, code}` 的 400，接口层无需 try/catch
  - [x] 单测 21 个 + **真实 HTTP 验证 20 项**：三组新路由均受鉴权保护（无 token 401）、
        超管 CRUD 正常且响应无明文、频道主伪造 ownerType 被强制改写、跨角色访问 403、
        IDOR 被阻断、删除被会话引用的 Provider 被拒绝
  - [x] 前端 UI：超管新增「Agora 凭证池」标签页（全量 CRUD、归属三态、优先级、配额、
        Customer 凭证、备注）；服务器管理页的 Agora 配置改为「Provider 列表 + 新建 BYOK」，
        删掉了原来的 App ID / Certificate / Token 有效期输入框
  - [x] 共用组件 `web/src/components/providers/ProviderManager.tsx`，差异由 props 控制
        （`showOwner` / `allowOwnerSelection` / `advanced`）
  - [x] 编辑时证书与 Customer Secret **永远显示为空**，留空即「保持不变」——
        不存在把掩码写回去覆盖真值的风险；归属选择框在编辑态禁用
  - [x] 保存配置时前端不再提交 `agoraAppId` / `agoraAppCertificate` / `agoraTokenExpireSec`
        （凭证已归 Provider 管理，避免把面板空值写回库）
  - [x] 顺手修一处 a11y 问题：提示文案原先写在 `<label>` 内，会被并入输入框的无障碍名称
        （自动化与读屏软件都会读到一整段提示），已移到 label 之外
  - [x] **浏览器实测**（真实 HTTP + 真实 SQLite）：超管标签页渲染、空状态、新建表单全字段、
        通过 UI 创建 Provider 成功、编辑表单证书字段为空且归属锁定、频道主页面渲染、
        频道主表单无归属选择器、通过 UI 创建 BYOK 成功；数据库确认两个 Provider 分别是
        `platform:-` 与 `space:guild-ui`（**归属由服务端强制写入**），证书均为 `v1:` 密文信封、
        无明文；同时验证改名后的 localStorage key（`clsnbcast_super_token` /
        `clsnbcast_space_kook_*`）端到端可用
  - [x] 前端：超管 Provider 管理页；服务器管理页的 Agora 配置改为「选 Provider / 新建 BYOK」
- [x] **1-6 健康检查**（用量汇总属 Phase 2，需要账本表）
  - [x] **离线检查**（免费）：能解密证书 + 能签出 Token ⇒ `healthy`；
        否则 `unhealthy` 并写入可操作的原因。启动时跑一次，之后每 30 分钟一次
  - [x] 🔎 关键细节：`RtcTokenBuilder` 在 App Certificate 长度不合法（声网要求 32 字符）时
        **不抛错而是返回空串**，所以必须显式检查 token 非空，只靠 try/catch 会把坏证书误判为健康
  - [x] 已停用的 Provider 跳过检查，不给面板制造无意义告警
  - [x] `health_message` 与日志都不回显底层错误（可能含密文片段）
  - [x] 检查结果与解析联动：被判不健康的 Provider 不再被分配新会话（故障容灾生效）
  - [x] 单测 11 个
  - [ ] 官方 RESTful API 用量/健康核对（需 Customer ID/Secret）—— 随 Phase 2 的对账一起做
  - [ ] 真实 RTC join 探针：会产生真实计费，仅管理员手动触发（**不实现自动探针**）

### 验收

- [x] `npm run verify` 通过（238 个测试：server 230 + web 8）
- [x] **回归验证（真实 DI 容器 + 真实数据库，16 项断言）**：存量明文凭证被迁移并清空、
      证书可解密、管理端视图无明文、会话绑定 Provider 并快照 App ID、发布/观众端均可签发、
      改 App ID 后活跃会话被拒绝且提示面向用户、新会话使用新 App ID 正常工作
- [x] **HTTP 层验证（20 项断言）**：三组新路由均受鉴权保护（无 token 401）、超管 CRUD 正常、
      频道主伪造 ownerType 被强制改写、跨角色访问 403、IDOR 被阻断、删除被会话引用的 Provider 被拒绝
- [x] **浏览器实测**：超管与频道主两套 Provider UI 均渲染并可用（详见 1-5）
- [x] **KOOK 侧回归（9 个单测）**：没有可用 Provider 时不创建会话、记 warn、不抛错；
      有 Provider 时会话被创建并绑定；创建出的会话可直接签发发布端/观众端 Token；
      帮助指令与冷却行为未受影响
- [x] 确认数据库中已无明文 `agora_app_certificate`（迁移时清空，实测确认）

> ⚠️ **KOOK 全链路（webhook → worker → 卡片）无法在本环境端到端验证**：
> `KookWebhookWorker` 在 `KookService.isReady`（即已配置真实 KOOK Bot Token）之前不处理任何事件，
> 因此没有真实 Bot Token 时事件会一直停留在 `pending`。这是上游既有设计，不是本次改动引入的。
> 为此改用直接调用 `handleIncomingMessage` 的单测覆盖 KOOK 侧逻辑（见上）。
> **上线前建议在真实 KOOK 环境跑一次完整链路。**

**Phase 1 已完成**（commit `dcef0e1` / `0c9fcc8` / `a139510` / `6cd51ee` / `9361fba` / `89cff92`）。

### commit 划分

每个 1-x 一个 commit，例如 `feat: add agora_providers table and repository`、`fix: bind agora app id to session snapshot to prevent provider drift`

---

## Phase 2 — UsageLedger

**目标**：建立本地用量账本，按 provider / session / publisher / viewer 记录加入时间、离开时间、观看时长与视频档位。

### 任务

- [x] **2-1 账本表与 repository**
  - [x] migration `003-usage-ledger`：`usage_events` + `usage_intervals` + `provider_usage_monthly`
        （`usage_reconciliation` 留到 2-5 需要时再加，避免先建无人使用的表）
  - [x] `DatabaseService` 提供行级 CRUD（列映射、插入、按条件更新），与其它表一致；
        **计费语义不在这一层**
  - [x] `UsageLedgerService`（开区间 / 关区间 / 会话级收口 / 崩溃恢复 / 观众时长派生 / 月度汇总）
  - [x] `resolveBillingProfile()`：把「主播按音频、观众按视频档位」的既有口径抽成纯函数，
        与 `toInfo()` 完全一致；Phase 2-3 换成读配置时只改这一个函数
  - [x] 周期键 `currentPeriodKey` 从 `agora/provider-quota` 移到 `usage/usage-period`
        （配额依赖用量口径，依赖方向应当是 quota → usage）
  - [x] 🔑 **周期键在开启区间时就算好并落库**（`usage_intervals.period_key`），
        而不是查询时现算 —— 汇总与配额判断因此不必做时区区间换算，
        也消除了「月首/月末按 UTC 与按 Asia/Shanghai 归属不同」这类边界 bug
  - [x] 🔒 **重复开区间被拒绝**：同一 (session, role, actor) 已有进行中区间时返回 `undefined` 并告警。
        重复计费比调用方的自觉更值得防
  - [x] 🔒 **重复关区间是无害 no-op**：结算 SQL 带 `WHERE ended_at IS NULL`，
        时长与标准时长在 SQL 内算，避免读-改-写竞态
  - [x] 崩溃恢复用**最后一次可信活动**（会话最后心跳）兜底，不把宕机时间算成用量
  - [x] 单测 69 个：区间开关与去重、结算与幂等关闭、档位切换切分区间、
        观众时长（已关闭 + 进行中实时部分）、崩溃恢复四种边界、月度汇总（含 sessionCount
        取最大值而非相加、upsert 幂等、跨月不串、时区归属）、系数快照不可变
  - [x] **端到端验证（真实 DI 容器 + 真实数据库）17 项**：新库建到 v3、**v2 存量库增量升级到 v3
        且业务数据无损**、账本服务可从 DI 解析、区间开关与去重、周期键落库、
        汇总产出 4.57 标准分钟并同步到 Provider 配额缓存
- [x] **2-2 埋点接入（纯旁路写入）**
  - [x] 按 [data-model-design.md](./data-model-design.md) 4.5 的表格接线，全部落在**真实的计费状态转换**处：
        观众加入 / 离开、进入 GRACE / 恢复 ACTIVE、开始共享、会话结束
  - [x] 口径按已决策：**观众 ACTIVE-only；主播含 GRACE**（保持现状）。
        主播区间从首次开始共享一直开到会话结束，因此时长 = `endedAt - startedAt`
  - [x] ⚠️ **刻意不挂在 `pauseViewerBilling` / `resumeViewerBilling` 内部** ——
        `checkpointViewerDurations` 每 10 秒就会 pause+resume 一次做落盘，
        挂在那里会每 10 秒切出一个新区间，把账本变成噪声。已加专门的回归测试锁定
  - [x] 旁路保护：所有账本写入走 `safeLedger()`，失败只记 error，**不打断正在进行的共享**
  - [x] 启动时崩溃恢复：由 `UsageLedgerService.onModuleInit` 关闭悬挂区间（`reason='crash_recovery'`）
  - [x] ⚠️ **此步不改任何计费展示**，只旁路写入。已用 `viewer-duration-matches-legacy` 断言锁定：
        账本派生的观众时长与既有 `sessions.viewer_duration_ms` **完全一致**
  - [x] 单测 19 个 + **真实 DI 容器端到端 20 项**：PENDING 观众不计费、加入后开始计费、
        GRACE 关观众不关主播、恢复不重复开主播区间、checkpoint 不切区间、
        结束一次性收口、账本失败不打断会话
- [x] **2-3 计费展示切换到账本**
  - [x] 迁移 `004-quality-config`：建 `quality_config` **单行表**（只建表、不播种 ——
        默认值只在 `quality-config.types.ts` 定义一份，避免两处副本漂移）
  - [x] `QualityConfigService`：读取 + 内存缓存 + 启动时播种 + 更新时校验；
        行缺失或 JSON 损坏时**回退默认值并记 warn**（不能静默，否则账单与预期不符却查不出原因）
  - [x] `toInfo()` 的系数与单价改读 `quality_config`（不再是硬编码常量）
  - [x] ✅ **Full HD 极速直播系数由 4.57 修正为 4.5**（已确认的官方值）。
        配置化之后这是**改数据**而不是改代码，正是本阶段设计的收益
  - [x] 🔑 **标准时长直接取区间快照的系数求和**，而不是「当前档位 × 当前系数」重算 ——
        后者在会话中途切档位（Phase 3 自定义画质）或调整配置后都会算错。
        新增 `UsageLedgerService.getStandardMsByRole()`
  - [x] 🔒 **快照语义**：改动系数/单价**不会改写已结算区间**，只影响新开的区间
        （单元测试 + E2E 双重锁定）
  - [x] `viewer_duration_ms` 改为由账本派生并落盘；`checkpointViewerDurations` 改为
        **只读账本 + 写缓存列**，不再用 pause/resume 落盘（那会切区间）
  - [x] 历史会话（账本里没有区间）回退到已落盘值，标记沿用旧的峰值人数估算
  - [x] 超管面板展示的费率也改读 `quality_config`，否则面板会显示过期费率
  - [x] 单测 25（配置服务）+ 新增账单展示断言；**E2E 15 项**全部通过
  - [x] 端到端账目校验：1 小时 Full HD 极速直播 = 主播 60 + 观众 270 = **330 标准分钟**，
        与手算一致；明细显示「系数4.5」且不含 4.57
- [x] **2-4 quota 强制与用量看板**
  - [x] `UsageRollupScheduler`：每 10 分钟重算**当前 + 上一个**周期；
        同时重算上一周期是因为跨月会话可能在次月初才结算完，只算当前会漏
  - [x] 启动时先汇总一次（`AppModule.onModuleInit`），避免刚部署完配额判断读到空缓存
  - [x] 超管看板 `GET /api/super/usage`：按 Provider / 月份看标准分钟、会话数、
        观众分钟、主播分钟、配额进度与已达配额标记
  - [x] `POST /api/super/usage/rebuild`：手动触发重算（改完配置不用等定时任务）
  - [x] `GET /api/super/usage/sessions/:id`：会话账本明细（看板下钻）
  - [x] 达到阈值 → **停止分配新会话**，进行中的会话不中断（Phase 1-4 已实现并单测覆盖）
  - [x] 配额未启用或不限量时 `quotaUsageRatio` 为 **null**，避免前端画出假的 0% 进度
  - [x] 看板**只读** `provider_usage_monthly` 缓存，不扫账本明细；事实来源仍是 `usage_intervals`
  - [x] 🔒 汇总失败只记 error，不打断定时任务
  - [x] 前端：`web/src/components/usage/UsageDashboardPanel.tsx` + 超管新增「用量看板」标签页
  - [x] 单测 21 个（周期键退位含跨年、定时任务写汇总、上一周期也重算、失败只记 error、
        看板各字段、exceeded 与 ratio 边界、指定周期、下钻）
  - [x] **HTTP 验证 19 项**：看板接口、时区随配置、手动重算、270 标准分钟、
        已达配额标记、无限配额 ratio 为 null、Provider 配额缓存同步、下钻、未鉴权 401
  - [x] **浏览器实测**：标签页渲染、周期与时区显示、两个 Provider 分行、
        配额列「不限」与「0 / 10 0%」、产生用量后显示「270 / 50 → 540%」并打上**已达配额**标记、
        「立即重算」按钮可用
- [ ] **2-5（可选，后置）官方用量对账**
  - [ ] 调 Agora 官方用量 API 写入 `usage_reconciliation`
  - [ ] 只做展示，**业务逻辑不依赖**

### 验收

- [x] `npm run verify` 通过（346 个测试：server 338 + web 8）
- [x] **全应用启动验证 17 项**：新库一次建到 v4（baseline / agora-providers /
      usage-ledger / quality-config）、配置自动播种（单价 0.007、时区 Asia/Shanghai）、
      四张新表齐备、超管登录与配置接口正常、画质档案带档位且**Full HD 费率用 4.5 计算**、
      未鉴权请求 401
- [ ] 回归：完整链路正常，KOOK 结束卡片的时长/标准分钟/费用与改造前一致
      （**待真实 KOOK 环境验证**，原因见 Phase 1 验收说明）

### commit 划分

`feat: add usage ledger tables and service` / `feat: record usage intervals on viewer and publisher lifecycle` / `refactor: derive billing from usage ledger and configurable coefficients` / `feat: enforce provider monthly quota`

---

## Phase 3 — 自由画质

**目标**：删除「仅依赖固定 QUALITY_OPTIONS」的设计，保留常用预设并增加「自定义」模式；支持运行中动态切换；展示目标与实际统计。

### 任务

- [x] **3-1 预设与配置表化**（地基部分）
  - [x] migration `005-quality-presets`：建 `quality_presets` 表（只建表不播种，
        默认值唯一定义在 `DEFAULT_QUALITY_PRESETS`）+ 给 `sessions` 加
        `quality_preset_id` / `quality_config` / `optimization_mode` / `codec`
  - [x] ✅ 播种内容与原硬编码 `QUALITY_PRESETS` **逐项一致**（7 档、id 全部沿用），
        因此现有画质选择行为完全不变
  - [x] `QualityPresetService`：播种、CRUD、启用/停用、排序、删除保护
  - [x] `validateCustomQuality()`：校验分**两档** —— 结构性错误 `reject`（400），
        超出声网建议范围 `warn`（**只提示，不修改用户输入**）
  - [x] 🔑 快照的 `tier` **由分辨率推导**（`quality_config` 档位规则），
        不写死在预设上 —— 自定义分辨率因此也能算对钱
  - [x] 🔒 预设 `id` 不可改、内置不可删、被会话引用不可删（要停用请用 `enabled=false`）
  - [x] 单测 62 个：播种一致性、快照解析、档位推导、跟随配置变更、CRUD、
        16 项 reject 用例、3 项 warn 不拦截、删除保护
  - [x] **启动验证 12 项**：一次建到 v5、播种 7 档、会话快照列齐备、
        DI 解析预设与自定义快照、未知 id 返回 undefined（不静默回退）、
        奇数宽高被拒、4K@60 允许但告警
- [x] **3-2 自定义模式（服务端）**
  - [x] `/api/share/start` 接受 `customQuality`（width/height/frameRate/bitrateMin/
        bitrateMax/optimizationMode/codec），**不要求出现在预设白名单里**（那正是自由画质的意义）
  - [x] 结构性错误 → 400 `QUALITY_INVALID`（带 issues 列表）；
        超出建议范围 → **接受并回传 warnings**，不修改用户输入
  - [x] `SessionService.applyQuality()` 写入会话快照（`quality_config` 等列），
        🔒 **只能写一次**
  - [x] 未知预设 id 不写入并记 error（不静默按默认档计费）
  - [x] 响应回传生效的 `quality` 快照与 `warnings`，供前端展示目标参数与风险提示
  - [x] 🔑 会话档位改为**优先读快照**，自定义分辨率因此也能算对档位
  - [x] 单测 6 个 + 全量回归（421 server + 8 web）
- [ ] **3-3 前端**：分享页自定义表单 + 画质预设管理 UI
- [ ] **3-4 运行中动态切换**：`setEncoderConfiguration` 切换分辨率 / 帧率 / 码率
      （`optimizationMode` 与 `codec` 是 track/client 级参数，**不支持**运行中切换）
- [ ] **3-5 统计面板**：`getStats()` + `network-quality`，目标 vs 实际对比
  - [ ] ⚠️ 注意：本项目 preset key 与 Agora 内置 preset 名**部分同名但语义不同**（详见 [architecture-analysis.md](./architecture-analysis.md) 第 2 节 SDK 核实）。**绝不能把本项目的 quality key 直接当 `VideoEncoderConfigurationPreset` 字符串传给 SDK**，必须在类型层面隔离

### 验收

- [ ] `npm run verify` 通过
- [ ] 回归：7 个预设全部仍可用，且与改造前编码参数一致
- [ ] 手工验证：自定义 1600×900@45 + 码率 1500-4500 能正常共享
- [ ] 手工验证：运行中从 1080p30 切到 720p60，画面不中断，账本产生两个区间且档位各自正确
- [ ] 手工验证：统计面板数字与实际相符

### commit 划分

`feat: add quality_presets and quality_config tables` / `feat: support custom video encoder configuration` / `refactor: drive quality options from API` / `feat: allow live encoder reconfiguration during share` / `feat: show target vs actual video stats`

---

## Phase 4 — 自托管部署

**目标**：面向普通 Linux VPS 的完整 Docker Compose 方案，生产环境通过 HTTPS 提供服务。

### 任务

- [ ] **4-1 compose 硬化**
  - [ ] 加反向代理服务（Caddy 自动 HTTPS，或 nginx + certbot）
  - [ ] 反代必须支持 SSE（`proxy_buffering off` + 长超时）
  - [ ] 健康检查覆盖两个服务
  - [ ] 持久化卷、环境变量示例、启动顺序（`depends_on` + healthcheck）
- [ ] **4-2 应用侧配合**
  - [ ] `main.ts` 开启 `app.set('trust proxy', ...)`（否则反代后按 IP 限流失效）
  - [ ] 日志脱敏守卫：确保任何秘密都不进日志
  - [ ] 确认前端 bundle 中不含任何秘密（App Certificate / REST API Secret）
- [ ] **4-3 文档**
  - [ ] 重写 `DEPLOY.md`：HTTPS 配置、证书、备份、升级、回滚
  - [ ] 补全 `.env.example`（含 `SECRET_ENCRYPTION_KEY`、`KOOK_BOT_TOKEN`、`LEGACY_ADMIN_SUNSET_AT`）
  - [ ] `deploy.sh` 去掉硬编码默认值（`SSH_HOST=rainyun` 等改为必填或从环境变量读）

### 验收

- [ ] 在一台干净的 Linux VPS 上从零部署成功
- [ ] HTTPS 可访问，分享/观看链路正常
- [ ] 确认 `data/` 卷持久化、容器重启数据不丢
- [ ] 确认 `docker compose logs` 中无任何秘密

---

## Phase 5 — 安全加固（可选，建议但非必需）

- [ ] **5-1** HMAC 比较改为常量时间（`main.ts:161` 的 `sig !== parts[1]`）
- [ ] **5-2** 管理 token 吊销机制；服务器重新绑定时轮换 `server_secret`
- [ ] **5-3** KOOK 三密钥（`kookBotToken` / `kookVerifyToken` / `kookEncryptKey`）与 `servers.server_secret` 一并加密（复用 `SecretCryptoService`）
- [ ] **5-4** 清理 `main.ts:143` 的遗留 `server_admin` 分支（签发端只发 `space_admin`）

---

## 附：全局约束（每个阶段都适用）

1. **优先最小正确修改**，不为重构而重构。
2. **任何修改都要先分析相关代码、数据流和影响范围**。
3. **每一项独立功能使用独立 commit。**
4. **修改数据库结构时提供明确 migration**（走 `schema_migrations`）。
5. **新增功能不得破坏现有 KOOK Bot、Session、观看链接、屏幕音频和 Agora RTC 基础功能。** 每个阶段都要完整跑一遍回归链路。
6. **每完成一个阶段必须执行 build、typecheck 和相关测试。**
7. 会话/服务器表加列时，**对照五处联动清单**（[data-model-design.md](./data-model-design.md) 5.4）。
