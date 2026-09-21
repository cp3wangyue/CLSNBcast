# 现有架构分析

> 基线：上游 `main` @ `d943e16`，已自有化为 CLSNBcast（见 [upstream.md](./upstream.md)）。
> 本文档只描述**改造前的现状**，作为后续开发的回归风险图。
>
> 相关文档：
> - 数据模型设计 → [data-model-design.md](./data-model-design.md)
> - 开发顺序 → [development-plan.md](./development-plan.md)
> - 问题要点 → [open-questions.md](./open-questions.md)
> - 上游关系 → [upstream.md](./upstream.md)

---

## 1. 运行时拓扑

单 Node 进程同时提供 API 和前端静态资源。npm workspaces 单仓双包。

| 层 | 技术 | 说明 |
|---|---|---|
| `server/` | NestJS 10 + Express | 端口 `3520`（`server/src/main.ts:224`） |
| `web/` | React 18 + Vite 5 + Tailwind | 构建产物 `web/dist`，由 NestJS 托管 |
| 数据库 | SQLite (better-sqlite3) | `data/clsnbcast.db`，WAL 模式（`database.service.ts:144-148`） |
| KOOK 接入 | **Webhook**（v0.0.2 起替换 WebSocket） | 收件箱表 + 轮询 worker |
| 前端实时通道 | **SSE**（替换 socket.io） | `GET /api/share/stream` |
| 音视频 | Agora Web SDK NG | **CDN 动态加载，未锁版本** |

关键实现事实：

- NestJS 同时托管 SPA：`app.useStaticAssets(webDist, { index: false })` + 无扩展名 GET 回退 `index.html`（`server/src/main.ts:206-222`）。前端所有请求走相对路径 `/api/...`（`web/src/lib/api.ts`），**没有 `VITE_*` 环境变量注入**。
- Agora SDK 通过 `web/index.html` 的 `<script src="https://download.agora.io/sdk/release/AgoraRTC_N.js">` 加载，代码里用 `(window as any).AgoraRTC` 取全局对象（`useScreenShare.ts:10`、`useAgoraView.ts:5`）。`web/package.json` 里的 `agora-rtc-sdk-ng: ^4.20.2` **只用于类型**，运行时不用它。
  > ⚠️ 这是改造的一个真实风险点：`AgoraRTC_N.js` 是滚动更新的「最新版」，而自由画质和 `setEncoderConfiguration` 的行为强依赖 SDK 版本。见 [open-questions.md](./open-questions.md)。
- 管理端鉴权不是 NestJS Guard，而是 `main.ts` 里的全局 Express 中间件（`main.ts:104-196`）。唯一的真 Guard 是 `ShareTokenGuard`，只用在 `/api/share/*`。

---

## 2. 一次共享会话的完整数据流

```
KOOK 用户发送触发词
  └─ POST /api/integrations/kook/webhook
       → KookWebhookCodec.decode（verify_token 校验 + AES 解密 + zlib 兼容）
       → kook_webhook_events 收件箱（event_key 主键去重）
       → KookWebhookWorker（100ms 轮询 claim）
       → beginKookWebhookBusinessEffect（业务副作用幂等闸门）
       → KookEventRouter.route
       → KookService.handleIncomingMessage（content.includes(triggerWord) 子串匹配）
            → SessionService.createSession()          ← quality 默认 '1080p_2'
            → 私密卡片（含 shareUrl = /share?t=<token>）

分享者点卡片
  └─ GET  /api/share/info?t=token      → 返回 allowedQualities + qualityBitrates
  └─ POST /api/share/start             → 校验 quality ∈ allowedQualities
                                       → startSharing() → 发 session.started 事件
                                       → 公屏观看卡片
  └─ GET  /api/share/token?role=publisher   → uid=1
  └─ 浏览器: createScreenVideoTrack → client.join(appId, channel, token, uid) → publish

观众点卡片
  └─ GET /api/share/stream?t=token&role=viewer&vid=<uuid>   (SSE)
       → sessionService.viewerConnected()   ← 计费区间起点
  └─ GET /api/share/token?role=subscriber  → uid = random(100..99999)
  └─ 浏览器: client.join → subscribe

心跳与生命周期
  └─ publisher SSE 每 4s 心跳 → sessionService.heartbeat()
  └─ watchdog @Interval(5000)  → idle_timeout / no_viewer_timeout / heartbeat 丢失转 GRACE / max_age 24h
  └─ checkpointViewerDurations @Interval(10000) → 观众时长落盘

结束
  └─ endSession() → 发 session.ended → KOOK 更新卡片（观看数/时长/标准分钟/费用）
```

---

## 3. 画质参数的现状（自由画质改造对象）

画质目前有 **两处硬编码副本**，必须手工保持同步：

| 位置 | 内容 | 用途 |
|---|---|---|
| `server/src/modules/session/session.types.ts:154-197` | `QUALITY_PRESETS`（含 `tier` / `coefficient`） | 服务端校验、计费档位 |
| `web/src/hooks/useScreenShare.ts:34-70` | `QUALITY_OPTIONS`（含 `encoderConfig`） | 前端 UI 与编码参数 |

配置覆盖链路：

1. **全局码率覆盖** `global_config.qualityBitrates`，由 `sanitizeQualityBitrates` 校验（`super-admin.controller.ts:114-134`）：每个档位 `bitrateMin/bitrateMax` 必须为正数且 `bitrateMax >= bitrateMin`。
2. **每服务器画质白名单** `servers.allowed_qualities`（JSON 数组），写入时用 `QUALITY_PRESETS` 的 key 过滤（`server-admin.controller.ts:153-158`、`super-admin.controller.ts:302-307`）。
3. 会话表只存一个 **字符串 key**（`sessions.quality`），档位信息靠 `getQualityInfo(key)` 反查（`session.types.ts:199-201`，找不到时默认 `QUALITY_PRESETS[2]` = `1080p_2`）。
4. 前端编码参数拼装（`useScreenShare.ts:113-138`）：

```ts
const qOpt = QUALITY_OPTIONS.find((q) => q.key === qKey) || QUALITY_OPTIONS[2];
const { bitrateMin, bitrateMax, ...baseEncoderConfig } = qOpt.encoderConfig;
const encoderConfig = opts.bitrateConfig === undefined
  ? qOpt.encoderConfig
  : { ...baseEncoderConfig, ...opts.bitrateConfig };   // 服务端码率覆盖前端默认值
const screenTrack = await AgoraRTC.createScreenVideoTrack(
  { encoderConfig, optimizationMode: 'motion' },
  { AEC: false, AGC: false, ANS: false, restrictOwnAudio: true },
);
```

5. `optimizationMode` 目前**写死 `'motion'`**，两端一致。
6. codec 在 client 层写死 `'h264'`：`createClient({ mode, codec: 'h264' })`（`useScreenShare.ts:155-157`、`useAgoraView.ts:62-64`）。

**KOOK 层与画质完全解耦**：`kook.service.ts` 从不传 `quality` 给 `createSession`（`:373-379`、`:458-464`），所以 Bot 发起的会话永远是默认 `1080p_2`；画质 key 只从 Web 分享页经 `share.controller.ts:68-82` 落库。另外 `kook.service.ts:187-192` 拼了一个含 `appId` / `appCertificate` / `allowedQualities` 的 `serverConfig.agora` 对象，但**没有任何消费者**（只用到 `triggerWords` 和 `publicDomain`）——属于死代码。

---

## 4. Agora 凭证与 Token 的现状（AgoraProvider 改造对象）

凭证目前**按服务器、明文**存在 `servers` 表：

```sql
agora_app_id           TEXT NOT NULL DEFAULT '',   -- database.service.ts:178
agora_app_certificate  TEXT NOT NULL DEFAULT '',   -- database.service.ts:179  ← 明文
agora_token_expire_sec INTEGER NOT NULL DEFAULT 3600
```

唯一消费点是 `AgoraService.generateToken`（`agora.service.ts:20-45`）：

```ts
generateToken(channel: string, uid: number, role: AgoraRole, serverId?: string): AgoraTokenResponse {
  let appId = ''; let cert = ''; let expireSec = 3600;
  if (serverId) {
    const server = this.db.getServer(serverId);          // ← 每次调用实时查库
    if (server && server.agoraAppId) {
      appId = server.agoraAppId;
      cert  = server.agoraAppCertificate;
      expireSec = server.agoraTokenExpireSec;
    }
  }
  if (!appId || !cert) this.logger.warn('Agora App ID or Certificate not configured for server ' + (serverId || 'unknown'));
  const token = appId && cert
    ? RtcTokenBuilder.buildTokenWithUid(appId, cert, channel, uid, rtcRole, expireSec, expireSec)
    : '';
  return { token, channel, uid, appId, expireSec };
}
```

调用链（`share.controller.ts:42-57`）：`serverId = req.session.guildId` → 实时查库取 appId/cert → 签发。返回体 `AgoraTokenResponse` 只含 `{token, channel, uid, appId, expireSec}`，**不含 cert，这一点是正确的**。App ID 本身不是秘密，返回给前端是正常做法。

### 🔴 已确认的严重缺陷：会话期间修改 App ID 会静默破坏活跃会话

因为 token 是**在签发时刻从实时服务器配置里读 appId**，而不是从会话快照读，所以：

1. 分享者 A 在 App ID `X` 下加入 channel `cb_abc` 并 publish；
2. 管理员在面板把该服务器的 App ID 改成 `Y`；
3. 观众 B 之后打开观看页 → `generateToken` 返回 App ID `Y` 的 token → `client.join('Y', 'cb_abc', ...)`；
4. B 加入的是另一个 Agora 项目下的同名 channel，**永远看不到 A 的画面**，且没有任何错误提示。

这正是「每个 Share Session 创建时固定选择一个 AgoraProvider，publisher 和所有 subscriber 必须始终使用同一个 Provider / App ID / Channel」所要修的不变量。改造方案见 [data-model-design.md](./data-model-design.md) 第 3 节。

---

## 5. 用量与计费现状（UsageLedger 改造对象）

**只有会话级聚合，没有明细账本。**

`sessions` 表相关列（`database.service.ts:271-298`）：

| 列 | 含义 |
|---|---|
| `viewer_duration_ms` | 所有观众在 ACTIVE 状态下的累计在线毫秒（旧记录为 NULL） |
| `total_viewer_joins` | viewerId 去重后的加入数 |
| `peak_viewers` | 峰值并发观众数 |
| `duration_ms` | `endedAt - startedAt` |

观众在场的运行时状态全在 `SessionService` 的内存 Map 里（`session.service.ts:19-27`）：`viewerPresenceMap`（含 `billingStartedAt` 计费区间起点）、`viewerDurationMsMap`、`joinCountMap`、`viewerIdsMap`、`lastViewerMap`。计费区间只在 `ACTIVE` 时开启，`GRACE`/`PENDING` 期间 `pauseViewerBilling` 暂停（`session.service.ts:429-443`），每 10s 落盘一次（`:461-471`）。

计费模型**全部硬编码**在 `session.types.ts`：

```ts
INTERACTIVE_LIVE_COEFFICIENTS   = { 音频:1, 'SD 标清':4, 'HD 高清':4, 'Full HD 全高清':9, '2K':16, '2K+ 超高清':36 }
ULTRA_LOW_LATENCY_COEFFICIENTS = { 音频:0.57, 'SD 标清':2, 'HD 高清':2, 'Full HD 全高清':4.57, '2K':8, '2K+ 超高清':18 }
STANDARD_MINUTE_PRICE = 0.007    // 元 / 标准分钟
```

费用在 `SessionService.toInfo()` 里算（`session.service.ts:538-634`）：档位由 `getQualityInfo(session.quality).tier` 反查 → 取系数 → 主播按音频系数、观众按视频系数 → 求和向上取整 → × 0.007。

**缺口清单**：

- 没有 per-viewer 记录（加入时间、离开时间、单次时长）——只有总和。
- 没有 per-provider / per-publisher 维度。
- 没有月度聚合，没有 quota 概念（全代码库搜不到 quota）。
- 没有 `providerId`，无法归属到 Agora 账号。
- 档位来自 preset key 反查，**自由画质下会失效**（自定义分辨率没有对应 preset key）。

**一处既有的计费不一致（已决定保持现状）**：

- 观众时长是 ACTIVE-only（`billingStartedAt` 只在 ACTIVE 时置位）；
- 主播时长用 `durationMs = endedAt - startedAt`（`session.service.ts:494`），**包含 GRACE 空档**。
- 即：同一个 session 里，观众不付 grace 时间的钱，主播付。这是上游既有行为，**已决定保留**（见 [open-questions.md](./open-questions.md) 决策 3），账本按同口径记录，不改历史对比基准。

---

## 6. 数据库迁移机制现状

**手写、幂等、无版本表。** 全部逻辑在 `DatabaseService.migrate()`（`database.service.ts:160-451`），两种模式：

```ts
// 模式 A：新表 → CREATE TABLE IF NOT EXISTS 直接追加
CREATE TABLE IF NOT EXISTS notices (...);

// 模式 B：新列 → PRAGMA table_info 探测后 ALTER
const sessCols = this.db.prepare("PRAGMA table_info(sessions)").all() as any[];
if (!sessCols.some(c => c.name === 'low_latency')) {
  this.db.exec(`ALTER TABLE sessions ADD COLUMN low_latency INTEGER NOT NULL DEFAULT 0`);
}
```

也包含数据回填（例如给存量服务器生成 `server_secret`，`:256-267`）。

**评价**：对单进程 SQLite 应用够用，且存量库安全。问题在于：

- 没有 `schema_migrations` 版本表 → **无法知道某个库执行到哪一步**，无法写「只执行一次」的数据迁移；
- 新库路径 = 基础 `CREATE` + 一串 `ALTER`，与存量库路径不同，容易出现两边结构漂移；
- 迁移逻辑与 `DatabaseService` 耦合，越加越长（已 291 行）。

改造方案见 [data-model-design.md](./data-model-design.md) 第 5 节。

---

## 7. 部署现状

| 文件 | 内容 |
|---|---|
| `Dockerfile` | 运行时镜像。`node:20.19-alpine`，只装 server 生产依赖 + 重编译 `better-sqlite3`，**拷贝预构建的 `server/dist` 和 `web/dist`**（镜像内不构建）。`VOLUME /app/data`、`EXPOSE 3520`、`HEALTHCHECK wget -q -O /dev/null http://localhost:3520/` |
| `docker-compose.yml` | 单服务 `clsnbcast`。端口 `127.0.0.1:${PORT:-3520}:3520`（**仅回环，期望前面有反代**）、命名卷 `clsnbcast-data:/app/data`、`env_file: .env`、healthcheck、日志轮转 10m×3 |
| `DEPLOY.md` | 手工 nginx 说明（`listen 80`、`proxy_pass 127.0.0.1:3520`、**SSE 必需的 `proxy_buffering off` 与长超时**、`client_max_body_size 1m`） |
| `deploy.sh` | 本地 build → tar → scp → 远端 `docker compose build --pull && up -d` → 轮询健康。**默认值硬编码** `SSH_HOST=rainyun`、`REMOTE_DIR=/root/clsnbcast` |

**缺口**：compose 里没有 HTTPS/反代服务（只写在文档里）；`.env.example` 未记录代码实际读取的 `KOOK_BOT_TOKEN`、`LEGACY_ADMIN_SUNSET_AT`；`main.ts` 没有 `app.set('trust proxy', ...)`，在 nginx 后面 `req.ip` 会退化成代理 IP，**使登录/绑定接口的按 IP 限流失效**（`main.ts:93`）。

---

## 8. 全部环境变量（代码实际读取）

| 变量 | 位置 | 用途 |
|---|---|---|
| `SUPER_ADMIN_PASSWORD` | `main.ts:16` | 启动强校验；**同时是超管 token 的 HMAC 密钥** |
| `SUPER_ADMIN_PASSWORD` | `super-admin.controller.ts:42` | bcrypt hash + HMAC secret |
| `SUPER_ADMIN_PASSWORD` | `server-admin.controller.ts:110` | 服务器 token 的 HMAC **回退**密钥 |
| `ALLOWED_ORIGINS` | `main.ts:76-77` | CORS 白名单 |
| `PORT` | `main.ts:224` | 监听端口，默认 3520 |
| `KOOK_BOT_TOKEN` | `database.service.ts:385,411,414` | 播种/回填 `global_config.kookBotToken` |
| `LEGACY_ADMIN_SUNSET_AT` | `database.service.ts:421` | 旧管理面板下线时间 |
| `KOOK_API_TIMEOUT_MS` | `kook-api.client.ts:25` | KOOK HTTP 超时，默认 10000 |
| `VITE_API_TARGET` | `web/vite.config.ts:16` | 仅开发期代理目标 |

---

## 9. 秘密的存储与暴露现状

| 秘密 | 存储 | 是否明文 | API 是否返回 |
|---|---|---|---|
| `servers.agora_app_certificate` | SQLite | 🔴 **明文** | 否，全部掩码为 `'******'` |
| `global_config.kookBotToken` / `kookVerifyToken` / `kookEncryptKey` | SQLite | 🔴 **明文** | 否，掩码 |
| `servers.server_secret` | SQLite | 🔴 **明文**（32 字节 hex） | 否 |
| `servers.password_hash` | SQLite | ✅ bcrypt | 否 |
| `SUPER_ADMIN_PASSWORD` | 环境变量 | ✅ 不入库 | 否 |

掩码实现是正确的（`super-admin.controller.ts:175,263`、`server-admin.controller.ts:129`），写回时用 `!== '******'` 判断跳过（`super-admin.controller.ts:298`、`server-admin.controller.ts:149`），所以掩码值不会被写回覆盖真值。

**但「明文落盘」与要求不符**，需要加密层。已决定：Phase 1 只加密 Agora 相关（App Certificate / Customer Secret），KOOK 三密钥与 `server_secret` 放 Phase 5。

---

## 10. 构建 / 类型检查 / 测试现状

| 包 | 脚本 |
|---|---|
| 根 | `build:web`、`build:server`、`build`（web 后 server）、`start` |
| `server` | `build` = `nest build`；`start` / `start:prod` = `node dist/main.js` |
| `web` | `build` = `tsc -b && vite build`；`preview` |

- 🔴 **全仓没有任何测试框架**：无 jest/vitest/mocha/supertest/`@nestjs/testing` 依赖，无 `*.spec.ts` / `*.test.ts(x)`，无测试配置，三个 `package.json` 都没有 `test` / `lint` / `typecheck` 脚本。
- 服务端 `tsconfig.json:15-16` 是 `strictNullChecks: false`、`noImplicitAny: false`，`skipLibCheck: true` —— 类型检查很宽松。
- 无 CI（无 `.github/` 等）。

**结论**：「每完成一个阶段必须执行 build、typecheck 和相关测试」当前基线**无法满足**（没有 typecheck 脚本，没有测试可跑）。这必须是 Phase 0 的第一件事，否则后续每个阶段的「验证」都是空话。

---

## 11. 数据流影响面速查（改造时的回归风险图）

| 要改的东西 | 直接受影响 | 连带受影响 |
|---|---|---|
| 画质参数 | `session.types.ts` QUALITY_PRESETS、`useScreenShare.ts` QUALITY_OPTIONS | `share.controller.ts`（校验/返回）、`server-admin.controller.ts:153-158`（白名单）、`super-admin.controller.ts:114-134`（全局码率）、`SuperAdminPage.tsx:234,377`、`ServerAdminPage.tsx:390-409`、`session.service.ts:547`（计费档位）、`kook.service.ts`（默认值） |
| Agora 凭证 | `agora.service.ts:20-45`、`servers.agora_*` 列 | `share.controller.ts:34-57`、`super-admin.controller.ts:297-306`、`server-admin.controller.ts:148-152`、`kook.service.ts:187-192`（死代码）、`ServerAdminPage.tsx:371-378` |
| 用量账本 | `session.service.ts` 观众在场 Map + `endSession` + `toInfo` | `session-sse.controller.ts:122-124,157-169`（进出场钩子）、`kook.service.ts:554-565`（结束卡片用 standardMinutes/estimatedCost）、`sessions.viewer_duration_ms` |
| 会话表加列 | `sessions` DDL + `ALLOWED_SESSION_COLS`（`database.service.ts:844-851`）+ `mapSessionRow`（`:548-577`）+ `ServerSession` 接口（`:102-130`）+ `ShareSession`（`session.types.ts:11-43`）+ `toDb`/`fromDb`（`session.service.ts:40-99`） | 全部读会话的 API |
| 服务器表加列 | `ALLOWED_SERVER_COLS`（`database.service.ts:667-677`）+ `mapServerRow`（`:580-609`）+ `ServerRecord`（`:28-55`） | 两个 admin controller |

> ⚠️ **会话/服务器表加列是五处联动**：DDL、列白名单、行映射、接口类型、以及 `ShareSession` 的 `toDb`/`fromDb` 转换。漏任何一处都会静默丢字段（`updateSession` 对未知列只 warn 不抛错，`database.service.ts:859-862`）。这是本仓最容易踩的坑。

---

## 12. 本次分析未做的事

- 未修改任何业务代码（`server/src/**`、`web/src/**` 零逻辑改动；品牌改名只替换字符串与标识符）。
- 未实现数据模型或开发计划中的任何任务。
- 未改动数据库结构。

数据模型的 DDL 是**设计草案**，见 [data-model-design.md](./data-model-design.md)，尚未写入代码。
