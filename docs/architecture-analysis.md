# CLSNBcast 架构分析与改造设计

> 状态：**分析阶段产出，未修改任何业务代码。**
> 基线：`upstream/main` @ `d943e16`（rnm330/XgoatCast）
> 分析日期：2026-09-22

---

## 0. 项目初始化结果

| 项 | 结果 |
|---|---|
| `origin` | `https://github.com/cp3wangyue/CLSNBcast` |
| `upstream` | `https://github.com/rnm330/XgoatCast`（**push URL 已置为 `DISABLED_NO_PUSH`，防止误推上游**） |
| 本地 `main` | 已 `merge upstream/main --allow-unrelated-histories`，提交 `4f8e975` |

初始化前的实际情况：`CLSNBcast` 仓库只有一个 `Initial commit`，仅含 11 字节的 `README.md`（内容为 `# CLSNBcast`），**没有任何上游代码**。因此本次初始化把上游代码合并进本地 `main`，使上游提交成为本地历史的祖先节点。

**后续合并上游更新**：

```bash
git fetch upstream
git log --oneline HEAD..upstream/main     # 查看上游新增
git diff HEAD..upstream/main -- <path>    # 按需查看差异
git cherry-pick <sha>                     # 或选择性合并单个提交
git merge upstream/main                   # 或整体合并
```

**一处需要你确认的决定**：合并时 `README.md` 冲突，我取了上游版本（`git checkout --theirs README.md`），而不是保留 `# CLSNBcast`。理由是这样后续 `git merge upstream/main` 在 README 上不会反复冲突。如果你希望 README 体现本项目身份，告诉我，我单独加一个 `FORK.md` 或改 README（代价是以后上游改 README 时会有一次冲突）。

---

## 1. 当前架构分析

### 1.1 运行时拓扑

单 Node 进程同时提供 API 和前端静态资源。npm workspaces 单仓双包。

| 层 | 技术 | 说明 |
|---|---|---|
| `server/` | NestJS 10 + Express | 端口 `3520`（`server/src/main.ts:224`） |
| `web/` | React 18 + Vite 5 + Tailwind | 构建产物 `web/dist`，由 NestJS 托管 |
| 数据库 | SQLite (better-sqlite3) | `data/xgoatcast.db`，WAL 模式（`database.service.ts:144-148`） |
| KOOK 接入 | **Webhook**（v0.0.2 起替换 WebSocket） | 收件箱表 + 轮询 worker |
| 前端实时通道 | **SSE**（替换 socket.io） | `GET /api/share/stream` |
| 音视频 | Agora Web SDK NG | **CDN 动态加载，未锁版本** |

关键实现事实：

- NestJS 同时托管 SPA：`app.useStaticAssets(webDist, { index: false })` + 无扩展名 GET 回退 `index.html`（`server/src/main.ts:206-222`）。前端所有请求走相对路径 `/api/...`（`web/src/lib/api.ts`），**没有 `VITE_*` 环境变量注入**。
- Agora SDK 通过 `web/index.html` 的 `<script src="https://download.agora.io/sdk/release/AgoraRTC_N.js">` 加载，代码里用 `(window as any).AgoraRTC` 取全局对象（`useScreenShare.ts:10`、`useAgoraView.ts:5`）。`web/package.json` 里的 `agora-rtc-sdk-ng: ^4.20.2` **只用于类型**，运行时不用它。
  > ⚠️ 这是本次改造的一个真实风险点：`AgoraRTC_N.js` 是滚动更新的「最新版」，而自由画质和 `setEncoderConfiguration` 的行为强依赖 SDK 版本。见 §5.1。
- 管理端鉴权不是 NestJS Guard，而是 `main.ts` 里的全局 Express 中间件（`main.ts:104-196`）。唯一的真 Guard 是 `ShareTokenGuard`，只用在 `/api/share/*`。

### 1.2 一次共享会话的完整数据流

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

### 1.3 画质参数的现状（自由画质改造对象）

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

### 1.4 Agora 凭证与 Token 的现状（AgoraProvider 改造对象）

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

#### 🔴 已确认的严重缺陷：会话期间修改 App ID 会静默破坏活跃会话

因为 token 是**在签发时刻从实时服务器配置里读 appId**，而不是从会话快照读，所以：

1. 分享者 A 在 App ID `X` 下加入 channel `xc_abc` 并 publish；
2. 管理员在面板把该服务器的 App ID 改成 `Y`；
3. 观众 B 之后打开观看页 → `generateToken` 返回 App ID `Y` 的 token → `client.join('Y', 'xc_abc', ...)`；
4. B 加入的是另一个 Agora 项目下的同名 channel，**永远看不到 A 的画面**，且没有任何错误提示。

这正是你要求的「每一个 Share Session 创建时固定选择一个 AgoraProvider，publisher 和所有 subscriber 必须始终使用同一个 Provider / App ID / Channel」所要修的不变量。改造方案见 §3.2。

### 1.5 用量与计费现状（UsageLedger 改造对象）

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

**一处既有的计费不一致（改造时要注意，不要放大）**：

- 观众时长是 ACTIVE-only（`billingStartedAt` 只在 ACTIVE 时置位）；
- 主播时长用 `durationMs = endedAt - startedAt`（`session.service.ts:494`），**包含 GRACE 空档期**。
- 即：同一个 session 里，观众不付 grace 时间的钱，主播付。这是上游既有行为。引入 interval 账本后如果按 ACTIVE-only 统一口径，`estimatedCost` 会比现在**略低**。这是修正而非回归，但会改变历史对比口径，需要你确认（见 §5.7）。

### 1.6 数据库迁移机制现状

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

你要求「修改数据库结构时提供明确 migration」，所以需要一个最小版本化框架，见 §4 Phase 0-2。

### 1.7 部署现状

| 文件 | 内容 |
|---|---|
| `Dockerfile` | 运行时镜像。`node:20.19-alpine`，只装 server 生产依赖 + 重编译 `better-sqlite3`，**拷贝预构建的 `server/dist` 和 `web/dist`**（镜像内不构建）。`VOLUME /app/data`、`EXPOSE 3520`、`HEALTHCHECK wget -q -O /dev/null http://localhost:3520/` |
| `docker-compose.yml` | 单服务 `xgoatcast`。端口 `127.0.0.1:${PORT:-3520}:3520`（**仅回环，期望前面有反代**）、命名卷 `xgoatcast-data:/app/data`、`env_file: .env`、healthcheck、日志轮转 10m×3 |
| `DEPLOY.md` | 手工 nginx 说明（`listen 80`、`proxy_pass 127.0.0.1:3520`、**SSE 必需的 `proxy_buffering off` 与长超时**、`client_max_body_size 1m`） |
| `deploy.sh` | 本地 build → tar → scp → 远端 `docker compose build --pull && up -d` → 轮询健康。**默认值硬编码** `SSH_HOST=rainyun`、`REMOTE_DIR=/root/xgoatcast` |

**缺口**：compose 里没有 HTTPS/反代服务（只写在文档里）；`.env.example` 未记录代码实际读取的 `KOOK_BOT_TOKEN`、`LEGACY_ADMIN_SUNSET_AT`；`main.ts` 没有 `app.set('trust proxy', ...)`，在 nginx 后面 `req.ip` 会退化成代理 IP，**使登录/绑定接口的按 IP 限流失效**（`main.ts:93`）。

### 1.8 全部环境变量（代码实际读取）

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

### 1.9 秘密的存储与暴露现状

| 秘密 | 存储 | 是否明文 | API 是否返回 |
|---|---|---|---|
| `servers.agora_app_certificate` | SQLite | 🔴 **明文** | 否，全部掩码为 `'******'` |
| `global_config.kookBotToken` / `kookVerifyToken` / `kookEncryptKey` | SQLite | 🔴 **明文** | 否，掩码 |
| `servers.server_secret` | SQLite | 🔴 **明文**（32 字节 hex） | 否 |
| `servers.password_hash` | SQLite | ✅ bcrypt | 否 |
| `SUPER_ADMIN_PASSWORD` | 环境变量 | ✅ 不入库 | 否 |

掩码实现是正确的（`super-admin.controller.ts:175,263`、`server-admin.controller.ts:129`），写回时用 `!== '******'` 判断跳过（`super-admin.controller.ts:298`、`server-admin.controller.ts:149`），所以掩码值不会被写回覆盖真值。

**但「明文落盘」与你的要求「App Certificate、Customer Secret 等敏感数据必须服务端加密存储」不符**，需要加密层。

其他已注意到的安全项（本次不改，仅记录）：

- HMAC 比较非常量时间：`if (sig !== parts[1])`（`main.ts:161`）。
- 管理 token 7 天有效且**无法吊销**；服务器重新绑定不会轮换 `server_secret`，旧 token 到期前一直有效。
- `main.ts:143` 处理 `role === 'server_admin'`，但签发端只发 `'space_admin'`（`server-admin.controller.ts:102`）——遗留分支。
- `helmet({ contentSecurityPolicy: false })`（`main.ts:60-62`）。

### 1.10 构建 / 类型检查 / 测试现状

| 包 | 脚本 |
|---|---|
| 根 | `build:web`、`build:server`、`build`（web 后 server）、`start` |
| `server` | `build` = `nest build`；`start` / `start:prod` = `node dist/main.js` |
| `web` | `build` = `tsc -b && vite build`；`preview` |

- 🔴 **全仓没有任何测试框架**：无 jest/vitest/mocha/supertest/`@nestjs/testing` 依赖，无 `*.spec.ts` / `*.test.ts(x)`，无测试配置，三个 `package.json` 都没有 `test` / `lint` / `typecheck` 脚本。
- 服务端 `tsconfig.json:15-16` 是 `strictNullChecks: false`、`noImplicitAny: false`，`skipLibCheck: true` —— 类型检查很宽松。

**结论**：你要求的「每完成一个阶段必须执行 build、typecheck 和相关测试」，**当前基线无法满足**（没有 typecheck 脚本，没有测试可跑）。这必须是 Phase 0 的第一件事，否则后续每个阶段的「验证」都是空话。

### 1.11 数据流影响面速查（改造时的回归风险图）

| 你要改的东西 | 直接受影响 | 连带受影响 |
|---|---|---|
| 画质参数 | `session.types.ts` QUALITY_PRESETS、`useScreenShare.ts` QUALITY_OPTIONS | `share.controller.ts`（校验/返回）、`server-admin.controller.ts:153-158`（白名单）、`super-admin.controller.ts:114-134`（全局码率）、`SuperAdminPage.tsx:234,377`、`ServerAdminPage.tsx:390-409`、`session.service.ts:547`（计费档位）、`kook.service.ts`（默认值） |
| Agora 凭证 | `agora.service.ts:20-45`、`servers.agora_*` 列 | `share.controller.ts:34-57`、`super-admin.controller.ts:297-306`、`server-admin.controller.ts:148-152`、`kook.service.ts:187-192`（死代码）、`ServerAdminPage.tsx:371-378` |
| 用量账本 | `session.service.ts` 观众在场 Map + `endSession` + `toInfo` | `session-sse.controller.ts:122-124,157-169`（进出场钩子）、`kook.service.ts:554-565`（结束卡片用 standardMinutes/estimatedCost）、`sessions.viewer_duration_ms` |
| 会话表加列 | `sessions` DDL + `ALLOWED_SESSION_COLS`（`database.service.ts:844-851`）+ `mapSessionRow`（`:548-577`）+ `ServerSession` 接口（`:102-130`）+ `ShareSession`（`session.types.ts:11-43`）+ `toDb`/`fromDb`（`session.service.ts:40-99`） | 全部读会话的 API |
| 服务器表加列 | `ALLOWED_SERVER_COLS`（`database.service.ts:667-677`）+ `mapServerRow`（`:580-609`）+ `ServerRecord`（`:28-55`） | 两个 admin controller |

> ⚠️ 会话/服务器表加列是**五处联动**：DDL、列白名单、行映射、接口类型、以及 `ShareSession` 的 `toDb`/`fromDb` 转换。漏任何一处都会静默丢字段（`updateSession` 对未知列只 warn 不抛错，`:859-862`）。这是本仓最容易踩的坑。

---

## 2. Agora Web SDK 能力核实（设计前提）

我下载并核对了 SDK 的类型定义（`agora-rtc-sdk-ng@4.20.2` 的 `rtc-sdk_en.d.ts`），因为设计依赖这些细节：

### 2.1 `setEncoderConfiguration` 存在 ✅

```ts
// ILocalVideoTrack / ICameraVideoTrack
setEncoderConfiguration(config: VideoEncoderConfiguration | VideoEncoderConfigurationPreset): Promise<void>;
```

返回 Promise，可用于共享开始后动态切换分辨率 / 帧率 / 码率，**无需重建 Session 或重新 join**。你的判断是对的。

### 2.2 `VideoEncoderConfiguration` 的实际字段

```ts
export declare interface VideoEncoderConfiguration {
  width?: number | ConstrainLong;      // 支持 { max, min }
  height?: number | ConstrainLong;
  frameRate?: number | ConstrainLong;
  bitrateMin?: number;                 // Kbps
  bitrateMax?: number;                 // Kbps
  scaleResolutionDownBy?: number;      // @ignore
}
```

**只有这 6 个字段。** 没有 `orientationMode`、没有 `degradationPreference`、没有 `mirrorMode`（那是原生 SDK 的概念，Web SDK 不暴露）。SDK 注释明确：

> The actual bitrate may differ slightly from the value you set due to the limitations of the operation system or the web browser. **Agora recommends setting the bitrate between 100 Kbps and 5000 Kbps.**

### 2.3 `optimizationMode` 只有两个取值，且不能动态切换 ⚠️

```ts
optimizationMode?: "motion" | "detail";   // 出现于 ScreenVideoTrackInitConfig / CameraVideoTrackInitConfig
```

三个纠正你的设计假设的点：

1. **只有 `'motion'` 和 `'detail'` 两个值**，没有 `'balanced'`（那是 `degradationPreference` 的三值枚举，Web SDK 不暴露）。
2. `optimizationMode` **不属于 `VideoEncoderConfiguration`**，它是 track 创建配置（`createScreenVideoTrack` 的入参）。
3. 因此 **`setEncoderConfiguration` 无法动态切换 `optimizationMode`**。共享中途改它只能重建 track（会中断发布）。所以「共享开始后动态切换 optimizationMode」不可行，只能动态切 width/height/frameRate/bitrateMin/bitrateMax。

### 2.4 codec 是 client 级配置 ⚠️

```ts
export declare interface ClientConfig {
  codec: SDK_CODEC;   // 必填: "vp8" | "h264" | "vp9" | "h265" | "av1"
  mode: SDK_MODE;     // "live" | "rtc"
  ...
}
```

`createClient({ codec })` 是**必填**且在 client 生命周期内固定。改 codec 必须 `leave()` → 重建 client → 重新 `join()` → 重新 `publish()`，**这是会中断观众画面的操作**。当前两端都写死 `'h264'`。

所以「必要时支持选择 codec」应该实现为**会话开始前的选择**（存在 session 上、由 token/start 接口下发），而不是运行中切换。

### 2.5 官方预设表（重要：key 与 Agora 同名但值不同）

SDK 内置 `SUPPORT_VIDEO_ENCODER_CONFIG_LIST` / `SUPPORT_SCREEN_ENCODER_CONFIG_LIST`，`VideoEncoderConfigurationPreset = keyof typeof SUPPORT_VIDEO_ENCODER_CONFIG_LIST`。相关条目：

| Agora preset | 分辨率 | fps | 码率 (Kbps) |
|---|---|---|---|
| `480p_2` | 640×480 | 30 | 1000 |
| `720p_2` | 1280×720 | 30 | 2000 |
| `1080p_2` | 1920×1080 | 30 | 3000 |
| `1080p_5` | 1920×1080 | 60 | 4780 |
| `720p_auto` | 1280×720 | 30 | 3000（仅 Safari 建议） |

> 🔴 **命名冲突陷阱**：本项目的 preset key 与 Agora 内置 key 部分同名但**语义不同**。例如本项目的 `1080p_2` = 1920×1080@30 `bitrateMin: 2000`（无 max），而 Agora 的 `1080p_2` = 1920×1080@30 `bitrate 3000`。当前代码走的是自定义对象路径（传 `VideoEncoderConfiguration`），没触发这个坑；但**后续绝对不能把本项目的 quality key 直接当作 `VideoEncoderConfigurationPreset` 字符串传给 SDK**，否则画质会莫名其妙变化。改造时应在类型层面隔离这两种 key。

### 2.6 监控所需 API 齐备 ✅

```ts
// ILocalVideoTrack.getStats(): LocalVideoTrackStats
interface LocalVideoTrackStats {
  codecType?: "H264" | "H265" | "VP8" | "VP9" | "AV1X" | "AV1";
  sendBytes: number; sendPackets: number; sendPacketsLost: number;
  sendFrameRate?: number; captureFrameRate?: number;
  sendJitterMs: number; sendRttMs: number;
  sendResolutionWidth: number; sendResolutionHeight: number;
  captureResolutionWidth: number; captureResolutionHeight: number;
  // ... targetSendBitrate 等
}
// IRemoteVideoTrack.getStats(): RemoteVideoTrackStats
// client.on('network-quality', (stats: NetworkQuality) => ...)  // 每 2s 回调
interface NetworkQuality { uplinkNetworkQuality: 0|1|2|3|4|5|6; downlinkNetworkQuality: 0|1|2|3|4|5|6; }
```

足以实现「显示当前目标参数 + SDK 实际发送统计（目标码率 / 实际码率 / 分辨率 / FPS / 网络状况）」。注意：`sendFrameRate` 在 Firefox 上不可得，`captureFrameRate` 在 Safari/Firefox 上不可得，UI 要能容忍缺失字段。

---

## 3. 数据模型设计

设计原则：**尽量不动现有列语义**（避免破坏 KOOK / Session / 观看链接 / 屏幕音频），新增能力用新表 + 少量新增列；所有新增列走版本化 migration。

### 3.1 QualityConfig（自由画质）

**核心设计判断**：会话必须保存**编码参数的不可变快照**，而不是只存一个可变的 preset 引用。原因有二：

1. 账本需要可复现——如果 preset 事后被管理员改了，历史会话的档位/计费无法重算。
2. 自定义模式下根本没有 preset key。

同时，**计费档位必须由分辨率推导，不能再由 preset key 反查**——这是自由画质带来的最关键正确性问题。现有 `getQualityInfo(session.quality).tier`（`session.service.ts:547`）在自定义分辨率下会静默回落到 `1080p_2` 的档位，导致计费错误。

#### 表 `quality_presets`（取代硬编码的 QUALITY_PRESETS）

```sql
CREATE TABLE IF NOT EXISTS quality_presets (
  id               TEXT PRIMARY KEY,        -- 沿用现有 key: '480p_2','720p30',... 保证存量数据兼容
  label            TEXT NOT NULL,
  width            INTEGER NOT NULL,
  height           INTEGER NOT NULL,
  frame_rate       INTEGER NOT NULL,
  bitrate_min      INTEGER,                 -- Kbps, NULL = 不传
  bitrate_max      INTEGER,
  optimization_mode TEXT NOT NULL DEFAULT 'motion',  -- 'motion' | 'detail'
  codec            TEXT NOT NULL DEFAULT 'h264',     -- 'h264' | 'vp8' | 'vp9'
  enabled          INTEGER NOT NULL DEFAULT 1,       -- 软删除，不用真删（保护 allowed_qualities 引用）
  is_builtin       INTEGER NOT NULL DEFAULT 0,       -- 标记是否来自初始播种
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL DEFAULT 0
);
```

播种内容 = 现有 7 档（`session.types.ts:154-197`），`is_builtin=1`，`id` 完全沿用现有 key。**key 不可变**（`allowed_qualities` 和存量 `sessions.quality` 都引用它），改档位参数只改列，禁用用 `enabled=0`。

#### 表/配置 `quality_config`（取代硬编码的系数与单价）

放在 `global_config` 的一个 key 里（`qualityConfig`，JSON），或独立单行表。推荐后者以便类型化校验：

```sql
CREATE TABLE IF NOT EXISTS quality_config (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  tier_rules               TEXT NOT NULL,   -- JSON: 分辨率→档位 的规则数组
  audio_coefficients       TEXT NOT NULL,   -- JSON
  standard_minute_price    REAL NOT NULL,   -- 元/标准分钟，默认 0.007
  usage_timezone           TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  limits                   TEXT NOT NULL,   -- JSON: 自定义参数的硬边界
  updated_at               INTEGER NOT NULL DEFAULT 0
);
```

`tier_rules` 结构（**按像素数上界匹配**，顺序即优先级）：

```jsonc
[
  { "tier": "SD 标清",       "maxPixels": 307200,  "interactive": 4,    "ultraLowLatency": 2    },
  { "tier": "HD 高清",       "maxPixels": 921600,  "interactive": 4,    "ultraLowLatency": 2    },
  { "tier": "Full HD 全高清", "maxPixels": 2073600, "interactive": 9,    "ultraLowLatency": 4.57 },
  { "tier": "2K",           "maxPixels": 3686400, "interactive": 16,   "ultraLowLatency": 8    },
  { "tier": "2K+ 超高清",    "maxPixels": null,    "interactive": 36,   "ultraLowLatency": 18   }
]
```

`audio_coefficients`：

```jsonc
{ "broadcaster": 1, "interactiveViewer": 1, "ultraLowLatencyViewer": 0.57 }
```

`limits`（用于自定义模式的校验与风险提示分级）：

```jsonc
{
  "width":       { "min": 16,  "max": 4096, "step": 2 },
  "height":      { "min": 16,  "max": 2160, "step": 2 },
  "frameRate":   { "min": 1,   "max": 120,  "recommendedMin": 5, "recommendedMax": 60 },
  "bitrate":     { "min": 1,   "max": 30000, "recommendedMin": 100, "recommendedMax": 5000 },
  "maxPixels":   8294400
}
```

`recommended*` 来自 Agora 官方建议（100–5000 Kbps），**只用于风险提示，不强制修改用户输入**——完全符合你的要求。

> ⚠️ 待确认：`tier_rules` 的像素边界值我按现有代码的 6 档（SD/HD/FullHD/2K/2K+）反推设定，**上界的具体数字需要对照声网最新计费文档确认后才能用于 quota 强制**。在确认前，先只用于展示与估算。

#### `sessions` 新增列

```sql
ALTER TABLE sessions ADD COLUMN quality_preset_id TEXT;      -- preset 模式下的 id；自定义模式为 NULL
ALTER TABLE sessions ADD COLUMN quality_config    TEXT;      -- 生效编码参数的 JSON 快照（不可变）
ALTER TABLE sessions ADD COLUMN optimization_mode TEXT;      -- 快照，便于统计与复现
ALTER TABLE sessions ADD COLUMN codec             TEXT;      -- 快照
```

- 保留现有 `quality TEXT` 列不动，继续存 preset id 或字面量 `'custom'`，这样 `ShareSession.quality`、`toInfo()`、KOOK 卡片、存量 API 全部不用改。
- `quality_config` 是**快照**：`{ width, height, frameRate, bitrateMin, bitrateMax, optimizationMode, codec, tier, source: 'preset'|'custom' }`。
- 档位 `tier` 也写进快照，这样即使 `tier_rules` 日后调整，历史会话的计费口径仍可复现。

#### 校验规则（服务端权威，前端镜像）

必须拒绝（400）：
- 非整数 / 非正数；
- 宽高为奇数（H.264 要求偶数）；
- `bitrateMax < bitrateMin`；
- 超出 `limits` 硬边界；
- `optimizationMode ∉ {motion, detail}`；
- `codec ∉ {h264, vp8, vp9}`；
- 宽×高 > `limits.maxPixels`。

只警告（不拦截，返回 warning 列表给前端展示）：
- 码率超出 Agora 建议区间 100–5000 Kbps；
- 帧率超出建议区间；
- 该分辨率/帧率组合的像素吞吐率明显高于建议（例如 4K@60）。

现有 `sanitizeQualityBitrates`（`super-admin.controller.ts:114-134`）的校验风格（正数 + `bitrateMax >= bitrateMin`）正好是这个新校验器的子集，可以抽成一个共享的 `QualityValidationService`，让三处（全局码率、服务器白名单、会话自定义）复用同一套规则，避免规则漂移。

### 3.2 AgoraProvider（多租户）

#### 表 `agora_providers`

```sql
CREATE TABLE IF NOT EXISTS agora_providers (
  id                    TEXT PRIMARY KEY,             -- uuid
  owner_type            TEXT NOT NULL,                -- 'platform' | 'space' | 'user'
  owner_id              TEXT NOT NULL DEFAULT '',     -- platform=''；space=serverId；user=KOOK userId
  name                  TEXT NOT NULL,
  app_id                TEXT NOT NULL,                -- 非秘密
  app_certificate_enc   TEXT NOT NULL DEFAULT '',     -- 🔐 密文
  customer_id           TEXT,                         -- 可选，非秘密
  customer_secret_enc   TEXT,                         -- 🔐 密文
  enabled               INTEGER NOT NULL DEFAULT 1,
  priority              INTEGER NOT NULL DEFAULT 100, -- 越小越优先
  token_expire_sec      INTEGER NOT NULL DEFAULT 3600,
  health_status         TEXT NOT NULL DEFAULT 'unknown',  -- unknown|healthy|degraded|unhealthy
  health_checked_at     INTEGER,
  health_message        TEXT NOT NULL DEFAULT '',
  monthly_quota_standard_minutes REAL,                -- NULL = 不限；🔴 不写死 10000
  quota_enforced        INTEGER NOT NULL DEFAULT 0,
  estimated_usage_standard_minutes REAL NOT NULL DEFAULT 0,  -- 由账本汇总的缓存
  usage_period_key      TEXT NOT NULL DEFAULT '',      -- 'YYYY-MM'
  last_used_at          INTEGER,
  allowed_preset_ids    TEXT,                          -- 可选：限制该 provider 可用画质
  note                  TEXT NOT NULL DEFAULT '',
  created_at            INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agora_providers_owner  ON agora_providers(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_agora_providers_select ON agora_providers(enabled, priority);
```

设计要点：

- `owner_type` 三态直接对应你的三种绑定需求：`platform`（我们自己的，全局默认）、`space`（KOOK 服务器自带，等价于现在的 per-server 配置）、`user`（BYOK，用户自带凭证）。
- `monthly_quota_standard_minutes` 可空 = 不限，由管理员配置；**不存在任何硬编码的 10000**。
- `estimated_usage_standard_minutes` 是**从账本汇总的缓存**，用于快速做 quota 判断，不作为事实来源（事实来源是 `usage_intervals`）。这样「不要依赖外部统计接口」和「本地记录算 estimated usage」都满足。
- 敏感列一律 `_enc` 后缀 + 密文，命名上强制提醒。

#### 秘密加密方案

新增 `SecretCryptoService`：

- 算法 **AES-256-GCM**，每条记录独立随机 12 字节 IV；
- 主密钥来自环境变量 `SECRET_ENCRYPTION_KEY`（32 字节，base64 或 hex）；
- 存储格式带版本前缀，便于轮换：`v1:<iv_b64>:<tag_b64>:<ct_b64>`；
- 解密失败必须抛错并**不泄露任何密文内容到日志**；
- 启动门禁：若已存在任何非空的 `*_enc` 列而 `SECRET_ENCRYPTION_KEY` 缺失 → **fatal 退出**（与 `main.ts:16-20` 的 `SUPER_ADMIN_PASSWORD` 门禁同风格），避免用随机密钥把已有数据解不开。

**存量数据迁移**：把每个已配置 `agora_app_id` + `agora_app_certificate` 的服务器，迁移成一行 `owner_type='space', owner_id=<serverId>` 的 provider，证书加密写入，然后**清空 `servers.agora_app_certificate`**（保留 `agora_app_id` 作为只读回退展示，或一并废弃）。这样明文秘密从库里彻底消失。

#### `sessions` 新增列（Provider 绑定）

```sql
ALTER TABLE sessions ADD COLUMN provider_id   TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN agora_app_id  TEXT NOT NULL DEFAULT '';   -- 签发时的 App ID 快照
```

**不可变性约束**：`provider_id` 与 `agora_app_id` 在会话创建时写入，此后**任何路径都不得修改**。

- 建议在 `DatabaseService.updateSession` 的 `ALLOWED_SESSION_COLS` 里**不加入这两列**，从物理上禁止误改（现有实现对未知列只 warn 并跳过，`:859-862`）。
- 新增专用方法 `setSessionProviderBinding(id, providerId, appId)`，仅在创建时调用一次。

#### Provider 解析与 Token 签发（修复 §1.4 的缺陷）

新增 `AgoraProviderService`：

```ts
resolveForSession(input: { serverId: string; sharerUserId: string; requestedProviderId?: string })
  : { provider: AgoraProvider } | { error: 'NO_PROVIDER' | 'NOT_AUTHORIZED' | 'QUOTA_EXCEEDED' }
```

解析优先级：

1. **显式指定** `requestedProviderId` —— 必须校验调用者有权使用该 provider（`owner_type='platform'` 需管理员；`space` 需属于该 serverId；`user` 需 ownerId 匹配），否则 `NOT_AUTHORIZED`。
2. **服务器默认** `owner_type='space' AND owner_id=serverId`，且 `enabled=1`、健康、未超 quota。
3. **用户自带** `owner_type='user' AND owner_id=sharerUserId`，同上条件。
4. **平台池** `owner_type='platform'`，按 `priority` 升序，跳过禁用/不健康/超 quota 的。
5. 全部不可用 → 会话创建失败并返回明确错误码，**绝不静默回退到任意 App ID**。

`generateToken` 签名改造（关键）：

```ts
// 旧: generateToken(channel, uid, role, serverId)   ← 实时查库，会漂移
// 新: generateToken(session: ServerSession, uid: number, role: AgoraRole): AgoraTokenResponse
generateToken(session, uid, role) {
  if (!session.providerId) throw new BadRequestException('SESSION_PROVIDER_MISSING');
  const provider = this.providers.getById(session.providerId);
  if (!provider || !provider.enabled) throw new BadRequestException('PROVIDER_UNAVAILABLE');

  // 🔒 不变量断言：provider 的 App ID 必须与会话快照一致
  if (provider.appId !== session.agoraAppId) {
    this.logger.error(`App ID drift: session=${session.id} snapshot=${session.agoraAppId} provider=${provider.appId}`);
    throw new BadRequestException({ code: 'PROVIDER_APPID_CHANGED', message: '该共享的声网配置已变更，请重新发起共享' });
  }

  const cert = this.crypto.decrypt(provider.appCertificateEnc);   // 仅此一处使用明文
  const token = RtcTokenBuilder.buildTokenWithUid(
    provider.appId, cert, session.channel, uid, rtcRole, provider.tokenExpireSec, provider.tokenExpireSec,
  );
  return { token, channel: session.channel, uid, appId: provider.appId, expireSec: provider.tokenExpireSec };
}
```

这样 `share.controller.ts:47-48` 的调用点从 `this.agora.generateToken(req.session.channel, uid, r, serverId)` 改为 `this.agora.generateToken(req.session, uid, r)`——`req.session` 是 DB 行，已含 `providerId` 和 `agoraAppId` 快照。

**结果**：publisher 和所有 subscriber 必然使用同一个 Provider / App ID / Channel；管理员改 App ID 只会影响新会话，活跃会话得到明确报错而不是静默黑屏。完全满足你的要求，且**不实现任何以规避计费为目的的跨账号自动轮换**。

#### 健康检查设计（需要你确认的一点）

Agora 没有「免费且廉价地验证 App ID/Certificate 是否有效」的接口。可选手段：

| 手段 | 成本 | 能验证什么 |
|---|---|---|
| A. 离线：用 provider 的 appId+cert 试签一个 token，校验格式与长度 | 免费 | 证书非空、可解密、格式合法 |
| B. 调用 Agora RESTful API（需 Customer ID/Secret） | 免费额度内 | 账号有效、项目存在、真实用量 |
| C. 真实 RTC join 探针（临时 channel 加入后离开） | **产生计费** | 端到端可用性 |

**建议**：默认 A（永远执行）+ 有 Customer 凭证时叠加 B；C 仅在管理员手动触发时执行并明确提示会产生费用。请在开工前确认这个取舍。

#### 用量阈值行为

- 达到 `monthly_quota_standard_minutes` 时：**停止向该 provider 分配新会话**，已在进行的会话**不中断**。
- 理由：中断活跃会话会直接破坏「新增功能不得破坏现有 Session / 观看链接」的要求，且对用户是突袭。
- 周期键按 `quality_config.usage_timezone` 计算自然月。

### 3.3 UsageLedger

采用**事件 + 结算区间 + 月度汇总**三层。区间层是记账核心，因为自由画质引入了「会话中途切换档位」，单一聚合值无法表达。

#### 表 `usage_events`（追加写原始事件，审计与排查用）

```sql
CREATE TABLE IF NOT EXISTS usage_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  provider_id   TEXT NOT NULL DEFAULT '',
  server_id     TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL,             -- 'publisher' | 'viewer'
  actor_id      TEXT NOT NULL,             -- publisher: sharerUserId；viewer: viewerId
  event_type    TEXT NOT NULL,             -- 'join'|'leave'|'tier_change'|'session_end'|'crash_recovery'
  occurred_at   INTEGER NOT NULL,
  tier          TEXT,
  width         INTEGER, height INTEGER, frame_rate INTEGER, bitrate_max INTEGER,
  low_latency   INTEGER NOT NULL DEFAULT 0,
  detail        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_usage_events_session  ON usage_events(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_provider ON usage_events(provider_id, occurred_at);
```

#### 表 `usage_intervals`（结算区间，**计费事实来源**）

```sql
CREATE TABLE IF NOT EXISTS usage_intervals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL,
  provider_id    TEXT NOT NULL,
  server_id      TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL,            -- 'publisher' | 'viewer'
  actor_id       TEXT NOT NULL,
  tier           TEXT NOT NULL,            -- 结算时快照，如 'Full HD 全高清'
  width INTEGER, height INTEGER, frame_rate INTEGER, bitrate_max INTEGER,
  low_latency    INTEGER NOT NULL DEFAULT 0,
  billing_model  TEXT NOT NULL,            -- 'interactive' | 'ultra_low_latency'
  coefficient    REAL NOT NULL,            -- 快照系数
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,                  -- NULL = 仍在进行（仅进程存活期间）
  duration_ms    INTEGER,                  -- ended_at - started_at
  standard_ms    REAL,                     -- duration_ms × coefficient
  closed_reason  TEXT,                     -- 'viewer_left'|'session_end'|'grace'|'tier_change'|'crash_recovery'
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_intervals_provider ON usage_intervals(provider_id, started_at);
CREATE INDEX IF NOT EXISTS idx_usage_intervals_session  ON usage_intervals(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_intervals_open     ON usage_intervals(ended_at) WHERE ended_at IS NULL;
```

**为什么用区间而不是只加计数**：

- 直接满足「按 publisher / viewer 记录加入时间、离开时间、观看时长」；
- 档位中途变化时，关旧区间、开新区间，各自带自己的 `tier` + `coefficient`，账目天然正确；
- `coefficient` 与 `tier` 都是**结算时快照**，日后改 `tier_rules` 不影响历史；
- 与 Agora 官方用量 API 对账时，区间可以按 provider + 时间窗口聚合，和官方口径直接可比。

#### 表 `provider_usage_monthly`（滚动汇总缓存）

```sql
CREATE TABLE IF NOT EXISTS provider_usage_monthly (
  provider_id        TEXT NOT NULL,
  period_key         TEXT NOT NULL,        -- 'YYYY-MM'
  standard_minutes   REAL NOT NULL DEFAULT 0,
  publisher_minutes  REAL NOT NULL DEFAULT 0,
  viewer_minutes     REAL NOT NULL DEFAULT 0,
  session_count      INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, period_key)
);
```

由定时任务从 `usage_intervals` 重算。`agora_providers.estimated_usage_standard_minutes` 是它的最新值副本，供 quota 判断 O(1) 读取。**quota 判断只读本地账本，不读外部接口。**

#### 表 `usage_reconciliation`（对账，可选，明确非核心）

```sql
CREATE TABLE IF NOT EXISTS usage_reconciliation (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id      TEXT NOT NULL,
  period_key       TEXT NOT NULL,
  source           TEXT NOT NULL,          -- 'local' | 'agora_api'
  standard_minutes REAL NOT NULL,
  fetched_at       INTEGER NOT NULL,
  drift_minutes    REAL,
  note             TEXT NOT NULL DEFAULT ''
);
```

仅供报表展示「本地估算 vs 官方数据」的差异，**业务逻辑（quota、计费、会话）一律不依赖它**。

#### 埋点位置（对应现有代码）

| 时机 | 现有位置 | 账本动作 |
|---|---|---|
| 会话创建 | `session.service.ts:115-162` | 写 `provider_id` / `agora_app_id` 快照 |
| 主播开始共享 | `startSharing` `:194-265` | 开 publisher interval（ACTIVE 起算） |
| 主播停止 → GRACE | `stopSharing` `:297-330` | 关 publisher interval，`reason='grace'` |
| 心跳恢复 ACTIVE | `heartbeat` `:267-292` | 开新 publisher interval |
| 观众连接 | `viewerConnected` `:333-354` ← 由 `session-sse.controller.ts:122-124` 调用 | 开 viewer interval（ACTIVE 时） |
| 观众断开 | `viewerDisconnected` `:357-371` ← `session-sse.controller.ts:157-169` | 关 viewer interval，`reason='viewer_left'` |
| 计费暂停/恢复 | `pauseViewerBilling` / `resumeViewerBilling` `:429-443` | 关/开区间 |
| 档位切换 | 新功能 | 关旧区间（`tier_change`）+ 开新区间 |
| 会话结束 | `endSession` `:488-529` | 关闭所有未关区间，`reason='session_end'` |
| 进程崩溃恢复 | 启动时 | 把 `ended_at IS NULL` 的区间关闭，`reason='crash_recovery'`，`duration_ms` 上限取最后心跳/检查点 |

#### 与现有展示的兼容

`toInfo()` 的 `billingDetail` / `standardMinutes` / `estimatedCost` 是 KOOK 结束卡片的数据源（`kook.service.ts:554-565`），**不能破坏**。做法：

- 保留 `sessions.viewer_duration_ms` 列及其语义，但改为**从 `usage_intervals` 的 viewer 区间求和写入**，这样 `toInfo()` 逻辑几乎不变；
- `toInfo()` 里的硬编码系数与单价改为从 `quality_config` 读取；
- `getQualityInfo(session.quality).tier` 改为「优先读 `sessions.quality_config` 快照里的 tier，回退到 preset 反查」——同时修好自定义画质的计费，并让旧记录行为不变。

---

## 4. 推荐的开发顺序

排序依据：**依赖关系 + 风险**。每项独立 commit，每阶段结束跑 `typecheck + build + test`。

### Phase 0 — 基础工程（前置，不改业务行为）

| # | 任务 | 为什么必须最先做 |
|---|---|---|
| 0-1 | 加 `typecheck` / `test` 脚本与测试框架（建议 server 与 web 统一用 vitest，减少工具种类），提供 `npm run verify` = typecheck + build + test | 现状**零测试、零 typecheck 脚本**，你要求的阶段验收目前无法执行 |
| 0-2 | 引入版本化 migration：`schema_migrations` 表 + `migrations/` 注册表，把现有 `migrate()` 的内容包装为 baseline migration #1 | 你明确要求「修改数据库结构时提供明确 migration」；后续所有新表/新列都走这里 |
| 0-3 | `SecretCryptoService`（AES-256-GCM + 版本前缀 + 启动门禁）+ 单元测试 | 后续所有秘密存储都依赖它；无消费者，纯新增，零回归风险 |

### Phase 1 — AgoraProvider（多租户）

先做 Provider 再做画质，理由：会话必须先绑定 Provider 并落 App ID 快照，否则自由画质放开后无法把用量归属到账号，也无法保证不变量。

| # | 任务 |
|---|---|
| 1-1 | `agora_providers` 表 + repository + service（CRUD / priority / 健康 / quota 字段）+ 接入加密 |
| 1-2 | 存量迁移：per-server 凭证 → `owner_type='space'` provider 行；`sessions` 加 `provider_id` + `agora_app_id` 并回填；清空明文 `agora_app_certificate` |
| 1-3 | `generateToken(session, uid, role)` 改造 + App ID 不变量断言（修复 §1.4 缺陷）；保持响应结构不变 |
| 1-4 | `resolveForSession` 解析策略（显式 / space 默认 / user BYOK / 平台池）+ 失败码 |
| 1-5 | 管理端 API + UI（超管全量 CRUD；服务器管理员为自身 space 配置 BYOK；掩码 + 永不返回明文） |
| 1-6 | 健康检查任务（方案 A/B）+ 月度用量汇总任务 |

### Phase 2 — UsageLedger

先于自由画质，理由：账本必须先在位，才能记录任意档位（现有聚合值无法表达档位变化）。

| # | 任务 |
|---|---|
| 2-1 | `usage_events` + `usage_intervals` + `provider_usage_monthly` 表 + repository + 单元测试 |
| 2-2 | 在 `SessionService` 接入区间开关（观众进出 / grace / endSession）+ 启动崩溃恢复（此步不改计费展示，纯旁路写入，便于验证不影响现有功能） |
| 2-3 | `viewer_duration_ms` 改为由账本求和；`toInfo()` 系数与单价改读 `quality_config` |
| 2-4 | quota 强制（停止分配新会话）+ 超管用量看板 |
| 2-5 | （可选，后置）Agora 官方用量 API 对账 |

### Phase 3 — 自由画质

| # | 任务 |
|---|---|
| 3-1 | `quality_presets` + `quality_config` 表，播种现有 7 档；管理端 CRUD；`QUALITY_PRESETS` 常量退化为种子数据 |
| 3-2 | 自定义模式：`sessions.quality_config` 快照 + 服务端校验服务 + 风险提示引擎 + `/api/share/start` 接受自定义参数 |
| 3-3 | 前端：`QUALITY_OPTIONS` 改为 API 驱动 + 「自定义」表单（校验 + 风险提示） |
| 3-4 | `setEncoderConfiguration` 动态切换：新增会话内改档位接口 + hook + 账本区间切分（分辨率/帧率/码率可切；**optimizationMode 与 codec 不可切**，见 §2.3/2.4） |
| 3-5 | 统计面板：`getStats()` + `network-quality` + 目标 vs 实际对比（容忍字段缺失） |

### Phase 4 — 自托管部署

| # | 任务 |
|---|---|
| 4-1 | compose 硬化：加反向代理服务（Caddy 自动 HTTPS 或 nginx）+ healthcheck + 卷/环境变量文档化 + `main.ts` 开启 `trust proxy` + 日志脱敏守卫 |
| 4-2 | 文档：重写 `DEPLOY.md`，补全 `.env.example`（含 `SECRET_ENCRYPTION_KEY`、`KOOK_BOT_TOKEN`、`LEGACY_ADMIN_SUNSET_AT`） |

> Phase 4 与前面**无代码依赖**，如果你想要一个可测试的 VPS 环境，可以提前到 Phase 1 之后并行做（此时 `SECRET_ENCRYPTION_KEY` 等新变量已确定）。但建议至少放在 Phase 1 之后，避免 compose 反复改环境变量。

### Phase 5 — 安全加固（可选，建议但非必需）

| # | 任务 |
|---|---|
| 5-1 | HMAC 常量时间比较（`main.ts:161`） |
| 5-2 | 管理 token 吊销机制 / 重新绑定时轮换 `server_secret` |
| 5-3 | KOOK 三个密钥与 `server_secret` 一并加密（复用 `SecretCryptoService`） |

---

## 5. 待你决策的问题

以下是我无法从代码或需求推导出唯一答案的点，**开工前需要你确认**：

### 5.1 Agora SDK 版本锁定
`web/index.html` 从 `download.agora.io/sdk/release/AgoraRTC_N.js` 加载**滚动最新版**。自由画质 + `setEncoderConfiguration` 的行为强依赖版本，且这是供应链风险（第三方 CDN 内容随时可变）。
**建议**：锁到具体版本（如 `AgoraRTC_N-4.20.2.js`）或把 SDK 纳入 `web/` 依赖后打包自托管。要选哪种？

### 5.2 `optimizationMode` 无法中途切换
经核实 Web SDK 只有 `'motion' | 'detail'`，且它是 track 创建参数、不在 `VideoEncoderConfiguration` 内。所以「共享开始后动态切换 optimizationMode」不可实现（只能重建 track，会中断画面）。
**建议**：`optimizationMode` 作为会话开始前的选择；运行中只允许动态切换 分辨率 / 帧率 / 码率。是否接受？

### 5.3 codec 选择是会话级而非运行中可切
`createClient({ codec })` 必填且 client 生命周期内固定，改 codec 需 leave → 重建 → join → publish（观众会看到中断）。
**建议**：codec 作为会话开始前选项（存 session、由 start 接口下发），不做运行中切换。是否接受？另外默认值是否继续用 `h264`？

### 5.4 加密范围
你的需求明确点名 App Certificate 与 Customer Secret。但 `global_config.kookBotToken` / `kookVerifyToken` / `kookEncryptKey` 和 `servers.server_secret` **同样是明文落盘**。
**建议**：Phase 1 只加密 Agora 相关（范围可控、可评审），KOOK 与 server_secret 放到 Phase 5 单独一个 commit。还是希望一次全加密？

### 5.5 健康检查手段
见 §3.2 的 A/B/C 三方案。方案 C 会产生真实计费。
**建议**：默认 A（离线，免费）+ 有 Customer 凭证时叠加 B；C 仅手动触发并提示费用。是否接受？

### 5.6 quota 达到阈值的行为
**建议**：停止分配**新**会话，不中断进行中的会话。
另外需要确认：月度周期按哪个时区（建议 `Asia/Shanghai`）？阈值是「标准分钟」还是「金额」？

### 5.7 主播时长计费口径（既有不一致）
现状：观众时长是 ACTIVE-only，主播时长（`duration_ms`）**包含 GRACE 空档**。
**建议**：账本统一为 ACTIVE-only（更准确、更省），但这会让新会话的 `estimatedCost` 比旧口径**略低**，历史对比口径会变。
需要你决定：统一为 ACTIVE-only，还是保持现状（主播含 grace）以维持口径一致？

### 5.8 计费档位边界值需对照官方文档
§3.1 的 `tier_rules.maxPixels` 是我按现有 6 档反推的。**在用于 quota 强制前，需要对照声网最新计费文档确认像素边界**。在确认前，这些值只用于展示与估算。你能提供参考文档，还是让我去查？

### 5.9 README 处理
见 §0。是否要恢复 `# CLSNBcast` 标识（代价：以后上游改 README 会有一次冲突）？

---

## 6. 本次分析未做的事

- 未修改任何业务代码（`server/src/**`、`web/src/**` 零改动）。
- 未新增依赖，未安装 `node_modules`，未执行 build/typecheck（因为基线没有 typecheck 脚本，且本阶段只做分析）。
- 未改动 `.env.example` / Dockerfile / docker-compose.yml。
- 未实现任何 §3 的表结构或 §4 的任务。

新增文件仅本文档。§3 的 DDL 是设计草案，**尚未写入代码**，等你逐项下达开发任务后再实施。
