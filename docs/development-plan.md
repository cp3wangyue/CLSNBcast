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
- [ ] **1-2 存量凭证迁移**
  - [ ] 把每个配了 `agora_app_id` + `agora_app_certificate` 的服务器，转成 `owner_type='space'`
        的 provider 行（证书加密）。**放在 `AgoraProviderService.onModuleInit` 而非 migration**：
        它需要加密服务，且必须能在「未配置密钥」时安全跳过 —— migration 是纯 DB 函数，
        不应依赖运行时服务
  - [ ] 清空 `servers.agora_app_certificate`（明文消失）
  - [ ] 回填存量 `sessions.provider_id` / `agora_app_id`
- [ ] **1-3 Token 签发改造（修复 App ID 漂移）**
  - [ ] `generateToken(session, uid, role)` 取代 `generateToken(channel, uid, role, serverId)`
  - [ ] App ID 一致性断言 + `PROVIDER_APPID_CHANGED` 错误码
  - [ ] 更新调用点 `share.controller.ts:47-48`
  - [ ] **保持 `AgoraTokenResponse` 结构不变**（`{token, channel, uid, appId, expireSec}`）
  - [ ] 单测：provider App ID 与会话快照不一致时必须抛错
- [ ] **1-4 Provider 解析策略**
  - [ ] `resolveForSession`（显式 / space 默认 / user BYOK / 平台池优先级）
  - [ ] 失败码 `NO_PROVIDER` / `NOT_AUTHORIZED` / `QUOTA_EXCEEDED`
  - [ ] 会话创建流程接线
  - [ ] 单测：四种解析路径 + 三种失败路径
- [ ] **1-5 管理端 API 与 UI**
  - [ ] 超管：Provider 全量 CRUD、优先级、quota 配置
  - [ ] 服务器管理员：为自身 space 配置 BYOK
  - [ ] **任何响应都不得返回明文证书**（沿用现有 `'******'` 掩码约定）
  - [ ] 前端：超管 Provider 管理页；服务器管理页的 Agora 配置改为选 Provider 或新建 BYOK
- [ ] **1-6 健康检查与用量汇总**
  - [ ] 健康检查任务：离线校验（可解密 + 可试签 token）永远执行；有 Customer 凭证时叠加官方 API
  - [ ] `provider_usage_monthly` 汇总任务（Phase 2 完成后接管数据源；此时可先留空表）
  - [ ] 健康状态写入 `health_status` / `health_checked_at` / `health_message`

### 验收

- [ ] `npm run verify` 通过
- [ ] **回归验证**：完整跑一次 KOOK → 分享 → 观看链路，确认会话、观看链接、屏幕音频、KOOK 卡片全部正常
- [ ] 手工验证 App ID 漂移修复：会话进行中改 provider 的 App ID → 新观众拿到明确报错而非静默黑屏
- [ ] 确认数据库中已无明文 `agora_app_certificate`

### commit 划分

每个 1-x 一个 commit，例如 `feat: add agora_providers table and repository`、`fix: bind agora app id to session snapshot to prevent provider drift`

---

## Phase 2 — UsageLedger

**目标**：建立本地用量账本，按 provider / session / publisher / viewer 记录加入时间、离开时间、观看时长与视频档位。

### 任务

- [ ] **2-1 账本表与 repository**
  - [ ] migration：`usage_events` + `usage_intervals` + `provider_usage_monthly`（+ 可选 `usage_reconciliation`）
  - [ ] `UsageLedgerService`（开区间 / 关区间 / 查询 / 汇总）
  - [ ] 单测：区间开关、重叠区间、未关区间查询
- [ ] **2-2 埋点接入（纯旁路写入）**
  - [ ] 按 [data-model-design.md](./data-model-design.md) 4.5 的表格接线
  - [ ] 口径按已决策：**观众 ACTIVE-only；主播含 GRACE**（保持现状）
  - [ ] 启动时崩溃恢复：关闭悬挂区间（`reason='crash_recovery'`）
  - [ ] ⚠️ **此步不改任何计费展示**，只旁路写入，便于验证「不影响现有功能」
- [ ] **2-3 计费展示切换到账本**
  - [ ] `viewer_duration_ms` 改为由 `usage_intervals` 的 viewer 区间求和写入
  - [ ] `toInfo()` 的系数与单价改读 `quality_config`（不再是硬编码常量）
  - [ ] 档位改为「优先读会话快照的 `tier`，回退 preset 反查」
  - [ ] 回归对比：除 **Full HD 极速直播系数由 `4.57` 修正为 `4.5`**（已确认的官方值，见 [open-questions.md](./open-questions.md) §4）导致的约 1.5% 差异外，其余会话的 `estimatedCost` 应与改造前**一致**
- [ ] **2-4 quota 强制与用量看板**
  - [ ] quota 判断读 `provider_usage_monthly`（O(1)）
  - [ ] 达到阈值 → **停止分配新会话**，不中断进行中的会话
  - [ ] 超管看板：按 provider / 月份看标准分钟、会话数、观众分钟、主播分钟
  - [ ] 单测：阈值边界、周期键跨月、quota_enforced=0 时不拦截
- [ ] **2-5（可选，后置）官方用量对账**
  - [ ] 调 Agora 官方用量 API 写入 `usage_reconciliation`
  - [ ] 只做展示，**业务逻辑不依赖**

### 验收

- [ ] `npm run verify` 通过
- [ ] 回归：完整链路正常，KOOK 结束卡片的时长/标准分钟/费用与改造前一致
- [ ] 手工验证：多观众 + 中途停止恢复（GRACE）后，账本区间与 `viewer_duration_ms` 相符
- [ ] 手工验证：杀掉进程再启动，悬挂区间被正确关闭

### commit 划分

`feat: add usage ledger tables and service` / `feat: record usage intervals on viewer and publisher lifecycle` / `refactor: derive billing from usage ledger and configurable coefficients` / `feat: enforce provider monthly quota`

---

## Phase 3 — 自由画质

**目标**：删除「仅依赖固定 QUALITY_OPTIONS」的设计，保留常用预设并增加「自定义」模式；支持运行中动态切换；展示目标与实际统计。

### 任务

- [ ] **3-1 预设与配置表化**
  - [ ] migration：`quality_presets`（播种现有 7 档，`id` 沿用现有 key）+ `quality_config`
  - [ ] `QUALITY_PRESETS` 常量退化为种子数据
  - [ ] 管理端 CRUD（预设 + 档位规则 + 系数 + 单价 + 参数边界）
  - [ ] `getQualityInfo` 改为读表 + 内存缓存
- [ ] **3-2 自定义模式**
  - [ ] `sessions` 加 `quality_preset_id` / `quality_config` / `optimization_mode` / `codec`（**五处联动**）
  - [ ] `QualityValidationService`：拒绝规则 + 警告规则（[data-model-design.md](./data-model-design.md) 2.5）
  - [ ] 抽出共享校验器，让全局码率 / 服务器白名单 / 会话自定义三处复用
  - [ ] `/api/share/start` 接受自定义参数
  - [ ] 单测：全部拒绝规则 + 全部警告规则
- [ ] **3-3 前端自定义表单**
  - [ ] `QUALITY_OPTIONS` 改为从 API 拉取（消除两处硬编码副本）
  - [ ] 「自定义」模式表单：width / height / frameRate / bitrateMin / bitrateMax / optimizationMode / codec
  - [ ] 前端镜像同一套校验；**超出 Agora 建议范围只显示风险提示，不强制修改输入**
  - [ ] 后端返回的 warning 列表展示在表单上
- [ ] **3-4 运行中动态切换**
  - [ ] 新增会话内改档位接口（服务端校验 + 更新快照）
  - [ ] `ILocalVideoTrack.setEncoderConfiguration` 接线
  - [ ] 账本区间切分（关旧区间 `tier_change` + 开新区间）
  - [ ] 明确 UI 限制：`optimizationMode` 与 `codec` **开始共享后不可改**（置灰 + 说明原因）
- [ ] **3-5 统计面板**
  - [ ] `ILocalVideoTrack.getStats()` 轮询（`sendFrameRate` / `sendResolutionWidth` / `sendBytes` / `sendRttMs` / `sendJitterMs` / `sendPacketsLost`）
  - [ ] `client.on('network-quality')`（每 2s，uplink/downlink 0-6）
  - [ ] 展示：目标参数 vs 实际发送（目标码率 / 实际码率 / 分辨率 / FPS / 网络状况）
  - [ ] 容忍字段缺失（`sendFrameRate` 在 Firefox 不可得，`captureFrameRate` 在 Safari/Firefox 不可得）
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
