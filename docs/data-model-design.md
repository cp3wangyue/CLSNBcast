# 数据模型设计

> AgoraProvider / QualityConfig / UsageLedger 三个新数据模型，以及配套的版本化迁移机制。
> 本文档中的 DDL 是**设计草案**，尚未写入代码。
>
> 相关文档：现状分析 → [architecture-analysis.md](./architecture-analysis.md) ｜ 开发顺序 → [development-plan.md](./development-plan.md) ｜ 问题要点 → [open-questions.md](./open-questions.md)

**设计原则**：尽量不动现有列语义（避免破坏 KOOK / Session / 观看链接 / 屏幕音频），新增能力用新表 + 少量新增列；所有新增列走版本化 migration。

---

## 1. 总览

```
                    ┌─────────────────────┐
                    │  agora_providers    │  Provider 池（多租户 / BYOK / 配额 / 健康）
                    └──────────┬──────────┘
                               │ 会话创建时固定绑定（不可变）
                    ┌──────────▼──────────┐
                    │      sessions       │  + provider_id / agora_app_id 快照
                    │                     │  + quality_preset_id / quality_config 快照
                    └──────────┬──────────┘
                               │ 观众进出 / 档位切换 / 结束
                    ┌──────────▼──────────┐
                    │   usage_intervals   │  ★ 计费事实来源（per provider/session/actor）
                    └──────────┬──────────┘
                               │ 定时汇总
                    ┌──────────▼──────────┐
                    │ provider_usage_     │  → quota 判断（O(1)）
                    │ monthly             │
                    └─────────────────────┘

                    ┌─────────────────────┐
                    │ quality_presets     │  预设档位（取代硬编码 QUALITY_PRESETS）
                    │ quality_config      │  档位规则 / 系数 / 单价 / 参数边界
                    └─────────────────────┘
```

---

## 2. QualityConfig（自由画质）

### 2.1 核心设计判断

**会话必须保存编码参数的不可变快照，而不是只存一个可变的 preset 引用。** 原因有二：

1. 账本需要可复现 —— 如果 preset 事后被管理员改了，历史会话的档位与计费无法重算。
2. 自定义模式下根本没有 preset key。

**同时，计费档位必须由分辨率推导，不能再由 preset key 反查。** 这是自由画质带来的最关键正确性问题：现有 `getQualityInfo(session.quality).tier`（`session.service.ts:547`）在自定义分辨率下会**静默回落到 `1080p_2` 的档位**，直接算错钱。

### 2.2 表 `quality_presets`（取代硬编码 QUALITY_PRESETS）

```sql
CREATE TABLE IF NOT EXISTS quality_presets (
  id                TEXT PRIMARY KEY,        -- 沿用现有 key: '480p_2','720p30',... 保证存量数据兼容
  label             TEXT NOT NULL,
  width             INTEGER NOT NULL,
  height            INTEGER NOT NULL,
  frame_rate        INTEGER NOT NULL,
  bitrate_min       INTEGER,                 -- Kbps, NULL = 不传
  bitrate_max       INTEGER,
  optimization_mode TEXT NOT NULL DEFAULT 'motion',  -- 'motion' | 'detail'
  codec             TEXT NOT NULL DEFAULT 'h264',    -- 'h264' | 'vp8' | 'vp9'
  enabled           INTEGER NOT NULL DEFAULT 1,      -- 软删除，不用真删（保护 allowed_qualities 引用）
  is_builtin        INTEGER NOT NULL DEFAULT 0,      -- 标记是否来自初始播种
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL DEFAULT 0
);
```

播种内容 = 现有 7 档（`session.types.ts:154-197`），`is_builtin=1`，`id` 完全沿用现有 key。

**约束**：`id` 不可变（`servers.allowed_qualities` 和存量 `sessions.quality` 都引用它）。改档位参数只改列；禁用用 `enabled=0`，不真删。

### 2.3 表 `quality_config`（取代硬编码的系数与单价）

单行表，便于类型化校验：

```sql
CREATE TABLE IF NOT EXISTS quality_config (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  tier_rules            TEXT NOT NULL,   -- JSON: 分辨率 → 档位 的规则数组
  audio_coefficients    TEXT NOT NULL,   -- JSON
  standard_minute_price REAL NOT NULL,   -- 元/标准分钟，默认 0.007
  usage_timezone        TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  limits                TEXT NOT NULL,   -- JSON: 自定义参数的硬边界
  updated_at            INTEGER NOT NULL DEFAULT 0
);
```

`tier_rules` —— **按像素数上界匹配，顺序即优先级**。边界值已对照声网官方文档确认（见 [open-questions.md](./open-questions.md)）：

```jsonc
[
  { "tier": "SD 标清",        "maxPixels": 307200,  "interactive": 4,    "ultraLowLatency": 2    },
  { "tier": "HD 高清",        "maxPixels": 921600,  "interactive": 4,    "ultraLowLatency": 2    },
  { "tier": "Full HD 全高清",  "maxPixels": 2073600, "interactive": 9,    "ultraLowLatency": 4.57 },
  { "tier": "2K",            "maxPixels": 3686400, "interactive": 16,   "ultraLowLatency": 8    },
  { "tier": "2K+ 超高清",      "maxPixels": null,    "interactive": 36,   "ultraLowLatency": 18   }
]
```

> ⚠️ 官方计费表里**没有「SD 标清」档**（SD 分辨率被归入 HD 档），所以 SD 与 HD 的系数相同。上游代码的注释也承认了这一点（`session.types.ts:51`：`'SD 标清': 4, // SD 分辨率映射到 HD 档`）。保留 SD 条目是为了让 640×480 这类分辨率有一个可读的档位名，系数与 HD 一致。
>
> ⚠️ `ultraLowLatency` 的 Full HD / 2K / 2K+ 值（4.57 / 8 / 18）**沿用上游现值**，但与我从官方文档抓到的值不一致，需要人工核对 —— 见 [open-questions.md](./open-questions.md)。

`audio_coefficients`：

```jsonc
{ "broadcaster": 1, "interactiveViewer": 1, "ultraLowLatencyViewer": 0.57 }
```

`limits` —— 用于自定义模式的校验与风险提示分级：

```jsonc
{
  "width":     { "min": 16, "max": 4096, "step": 2 },
  "height":    { "min": 16, "max": 2160, "step": 2 },
  "frameRate": { "min": 1,  "max": 120,  "recommendedMin": 5, "recommendedMax": 60 },
  "bitrate":   { "min": 1,  "max": 30000, "recommendedMin": 100, "recommendedMax": 5000 },
  "maxPixels": 8294400
}
```

`recommended*` 来自 Agora 官方建议（**码率 100–5000 Kbps**，SDK 类型定义原文），**只用于风险提示，不强制修改用户输入**。

### 2.4 `sessions` 新增列

```sql
ALTER TABLE sessions ADD COLUMN quality_preset_id TEXT;      -- preset 模式下为 id；自定义模式为 NULL
ALTER TABLE sessions ADD COLUMN quality_config    TEXT;      -- 生效编码参数的 JSON 快照（不可变）
ALTER TABLE sessions ADD COLUMN optimization_mode TEXT;      -- 快照，便于统计与复现
ALTER TABLE sessions ADD COLUMN codec             TEXT;      -- 快照
```

- **保留现有 `quality TEXT` 列不动**，继续存 preset id 或字面量 `'custom'`。这样 `ShareSession.quality`、`toInfo()`、KOOK 卡片、存量 API 全部不用改。
- `quality_config` 快照结构：

```jsonc
{
  "width": 1920, "height": 1080, "frameRate": 30,
  "bitrateMin": 2000, "bitrateMax": null,
  "optimizationMode": "motion", "codec": "h264",
  "tier": "Full HD 全高清",
  "source": "preset"          // 或 "custom"
}
```

档位 `tier` 也写进快照，这样即使 `tier_rules` 日后调整，历史会话的计费口径仍可复现。

### 2.5 校验规则

**必须拒绝（400）**：

- 非整数 / 非正数；
- 宽高为奇数（H.264 要求偶数）；
- `bitrateMax < bitrateMin`；
- 超出 `limits` 硬边界；
- `optimizationMode ∉ {motion, detail}`；
- `codec ∉ {h264, vp8, vp9}`；
- `width × height > limits.maxPixels`。

**只警告（不拦截，返回 warning 列表给前端展示）**：

- 码率超出 Agora 建议区间 100–5000 Kbps；
- 帧率超出建议区间；
- 该分辨率/帧率组合的像素吞吐率明显高于建议（例如 4K@60）。

现有 `sanitizeQualityBitrates`（`super-admin.controller.ts:114-134`）的校验风格（正数 + `bitrateMax >= bitrateMin`）正好是这个新校验器的子集。应抽出共享的 `QualityValidationService`，让三处（全局码率、服务器白名单、会话自定义）复用同一套规则，避免规则漂移。

### 2.6 运行时可切换的参数范围（受 SDK 限制）

| 参数 | 运行中可切？ | 依据 |
|---|---|---|
| width / height / frameRate / bitrateMin / bitrateMax | ✅ 可切 | `ILocalVideoTrack.setEncoderConfiguration(config): Promise<void>` |
| optimizationMode | ❌ 不可切 | 它是 track 创建参数，**不是 `VideoEncoderConfiguration` 字段**；只能重建 track（会中断画面） |
| codec | ❌ 不可切 | `createClient({ codec })` 是 client 级必填参数，改它必须 leave → 重建 → join → publish |

**已决策**：动态切换只做 分辨率 / 帧率 / 码率；`optimizationMode` 与 `codec` 作为「开始共享前」的选项。

---

## 3. AgoraProvider（多租户）

### 3.1 表 `agora_providers`

```sql
CREATE TABLE IF NOT EXISTS agora_providers (
  id                             TEXT PRIMARY KEY,             -- uuid
  owner_type                     TEXT NOT NULL,                -- 'platform' | 'space' | 'user'
  owner_id                       TEXT NOT NULL DEFAULT '',     -- platform=''；space=serverId；user=KOOK userId
  name                           TEXT NOT NULL,
  app_id                         TEXT NOT NULL,                -- 非秘密
  app_certificate_enc            TEXT NOT NULL DEFAULT '',     -- 🔐 密文
  customer_id                    TEXT,                         -- 可选，非秘密
  customer_secret_enc            TEXT,                         -- 🔐 密文
  enabled                        INTEGER NOT NULL DEFAULT 1,
  priority                       INTEGER NOT NULL DEFAULT 100, -- 越小越优先
  token_expire_sec               INTEGER NOT NULL DEFAULT 3600,
  health_status                  TEXT NOT NULL DEFAULT 'unknown',  -- unknown|healthy|degraded|unhealthy
  health_checked_at              INTEGER,
  health_message                 TEXT NOT NULL DEFAULT '',
  monthly_quota_standard_minutes REAL,                        -- NULL = 不限；🔴 不写死 10000
  quota_enforced                 INTEGER NOT NULL DEFAULT 0,
  estimated_usage_standard_minutes REAL NOT NULL DEFAULT 0,    -- 由账本汇总的缓存
  usage_period_key               TEXT NOT NULL DEFAULT '',      -- 'YYYY-MM'
  last_used_at                   INTEGER,
  allowed_preset_ids             TEXT,                          -- 可选：限制该 provider 可用画质
  note                           TEXT NOT NULL DEFAULT '',
  created_at                     INTEGER NOT NULL DEFAULT 0,
  updated_at                     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agora_providers_owner  ON agora_providers(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_agora_providers_select ON agora_providers(enabled, priority);
```

设计要点：

- `owner_type` 三态直接对应三种绑定需求：`platform`（我们自己的，全局默认）、`space`（KOOK 服务器自带，等价于现在的 per-server 配置）、`user`（BYOK，用户自带凭证）。
- `monthly_quota_standard_minutes` 可空 = 不限，由管理员配置；**不存在任何硬编码的 10000**。
- `estimated_usage_standard_minutes` 是**从账本汇总的缓存**，用于快速做 quota 判断，不作为事实来源（事实来源是 `usage_intervals`）。这样「不依赖外部统计接口」和「本地记录算 estimated usage」都满足。
- 敏感列一律 `_enc` 后缀 + 密文，命名上强制提醒。

### 3.2 秘密加密方案

新增 `SecretCryptoService`：

- 算法 **AES-256-GCM**，每条记录独立随机 12 字节 IV；
- 主密钥来自环境变量 `SECRET_ENCRYPTION_KEY`（32 字节，base64 或 hex）；
- 存储格式带版本前缀，便于轮换：`v1:<iv_b64>:<tag_b64>:<ct_b64>`；
- 解密失败必须抛错，且**不泄露任何密文内容到日志**；
- 启动门禁：若已存在任何非空的 `*_enc` 列而 `SECRET_ENCRYPTION_KEY` 缺失 → **fatal 退出**（与 `main.ts:16-20` 的 `SUPER_ADMIN_PASSWORD` 门禁同风格），避免用随机密钥把已有数据解不开。

**已决策**：Phase 1 只加密 Agora 相关（`app_certificate_enc`、`customer_secret_enc`）。`global_config` 的三个 KOOK 密钥与 `servers.server_secret` 放 Phase 5 单独 commit。

**存量数据迁移**：把每个已配置 `agora_app_id` + `agora_app_certificate` 的服务器，迁移成一行 `owner_type='space', owner_id=<serverId>` 的 provider，证书加密写入，然后**清空 `servers.agora_app_certificate`**。这样明文秘密从库里彻底消失。

### 3.3 `sessions` 新增列（Provider 绑定）

```sql
ALTER TABLE sessions ADD COLUMN provider_id   TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN agora_app_id  TEXT NOT NULL DEFAULT '';   -- 签发时的 App ID 快照
```

**不可变性约束**：`provider_id` 与 `agora_app_id` 在会话创建时写入，此后**任何路径都不得修改**。

- 实现手段：**不把这两列加入 `DatabaseService.ALLOWED_SESSION_COLS`**（`database.service.ts:844-851`），从物理上禁止 `updateSession` 误改（现有实现对未知列只 warn 并跳过，`database.service.ts:859-862`）。
- 新增专用方法 `setSessionProviderBinding(id, providerId, appId)`，仅在创建时调用一次。

### 3.4 Provider 解析与 Token 签发

新增 `AgoraProviderService`：

```ts
resolveForSession(input: { serverId: string; sharerUserId: string; requestedProviderId?: string })
  : { provider: AgoraProvider } | { error: 'NO_PROVIDER' | 'NOT_AUTHORIZED' | 'QUOTA_EXCEEDED' }
```

解析优先级：

1. **显式指定** `requestedProviderId` —— 必须校验调用者有权使用该 provider（`platform` 需管理员；`space` 需属于该 serverId；`user` 需 ownerId 匹配），否则 `NOT_AUTHORIZED`。
2. **服务器默认** `owner_type='space' AND owner_id=serverId`，且 `enabled=1`、健康、未超 quota。
3. **用户自带** `owner_type='user' AND owner_id=sharerUserId`，同上条件。
4. **平台池** `owner_type='platform'`，按 `priority` 升序，跳过禁用/不健康/超 quota 的。
5. 全部不可用 → 会话创建失败并返回明确错误码，**绝不静默回退到任意 App ID**。

`generateToken` 签名改造（关键，修复 [architecture-analysis.md](./architecture-analysis.md) 第 4 节的缺陷）：

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

调用点从 `this.agora.generateToken(req.session.channel, uid, r, serverId)` 改为 `this.agora.generateToken(req.session, uid, r)`（`share.controller.ts:47-48`）—— `req.session` 是 DB 行，已含 `providerId` 和 `agoraAppId` 快照。

**结果**：publisher 和所有 subscriber 必然使用同一个 Provider / App ID / Channel；管理员改 App ID 只影响新会话，活跃会话得到明确报错而不是静默黑屏。

> **不实现**以规避服务商免费额度或计费限制为目的的跨账号自动轮换。Provider Pool 只用于多租户、自带凭证、容量管理与故障容灾。

### 3.5 健康检查

声网没有「免费且廉价地验证 App ID/Certificate 是否有效」的接口。可选手段：

| 手段 | 成本 | 能验证什么 |
|---|---|---|
| A. 离线：用 provider 的 appId+cert 试签一个 token，校验格式与长度 | 免费 | 证书非空、可解密、格式合法 |
| B. 调用 Agora RESTful API（需 Customer ID/Secret） | 免费额度内 | 账号有效、项目存在、真实用量 |
| C. 真实 RTC join 探针（临时 channel 加入后离开） | **产生计费** | 端到端可用性 |

**已决策（按推荐默认）**：A 永远执行；配置了 Customer 凭证时叠加 B；C 仅在管理员手动触发时执行并明确提示会产生费用。

### 3.6 用量阈值行为

**已决策**：达到 `monthly_quota_standard_minutes` 时，**停止向该 provider 分配新会话**，已在进行的会话**不中断**。

理由：中断活跃会话会直接破坏「新增功能不得破坏现有 Session / 观看链接」的要求，且对用户是突袭。周期键按 `quality_config.usage_timezone`（默认 `Asia/Shanghai`）计算自然月。

---

## 4. UsageLedger

采用**事件 + 结算区间 + 月度汇总**三层。区间层是记账核心，因为自由画质引入了「会话中途切换档位」，单一聚合值无法表达。

### 4.1 表 `usage_events`（追加写原始事件，审计与排查用）

```sql
CREATE TABLE IF NOT EXISTS usage_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  server_id   TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL,             -- 'publisher' | 'viewer'
  actor_id    TEXT NOT NULL,             -- publisher: sharerUserId；viewer: viewerId
  event_type  TEXT NOT NULL,             -- 'join'|'leave'|'tier_change'|'session_end'|'crash_recovery'
  occurred_at INTEGER NOT NULL,
  tier        TEXT,
  width       INTEGER, height INTEGER, frame_rate INTEGER, bitrate_max INTEGER,
  low_latency INTEGER NOT NULL DEFAULT 0,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_usage_events_session  ON usage_events(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_provider ON usage_events(provider_id, occurred_at);
```

### 4.2 表 `usage_intervals`（结算区间，**计费事实来源**）

```sql
CREATE TABLE IF NOT EXISTS usage_intervals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  provider_id   TEXT NOT NULL,
  server_id     TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL,            -- 'publisher' | 'viewer'
  actor_id      TEXT NOT NULL,
  tier          TEXT NOT NULL,            -- 结算时快照，如 'Full HD 全高清'
  width INTEGER, height INTEGER, frame_rate INTEGER, bitrate_max INTEGER,
  low_latency   INTEGER NOT NULL DEFAULT 0,
  billing_model TEXT NOT NULL,            -- 'interactive' | 'ultra_low_latency'
  coefficient   REAL NOT NULL,            -- 快照系数
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,                  -- NULL = 仍在进行（仅进程存活期间）
  duration_ms   INTEGER,                  -- ended_at - started_at
  standard_ms   REAL,                     -- duration_ms × coefficient
  closed_reason TEXT,                     -- 'viewer_left'|'session_end'|'grace'|'tier_change'|'crash_recovery'
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_intervals_provider ON usage_intervals(provider_id, started_at);
CREATE INDEX IF NOT EXISTS idx_usage_intervals_session  ON usage_intervals(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_intervals_open     ON usage_intervals(ended_at) WHERE ended_at IS NULL;
```

**为什么用区间而不是只加计数**：

- 直接满足「按 publisher / viewer 记录加入时间、离开时间、观看时长」；
- 档位中途变化时，关旧区间、开新区间，各自带自己的 `tier` + `coefficient`，账目天然正确；
- `coefficient` 与 `tier` 都是**结算时快照**，日后改 `tier_rules` 不影响历史；
- 与 Agora 官方用量 API 对账时，区间可按 provider + 时间窗口聚合，与官方口径直接可比。

**口径（已决策：保持现状）**：

- **观众**：只计 `ACTIVE` 状态区间（与现状一致，`GRACE`/`PENDING` 不计）。
- **主播**：按 `endedAt - startedAt`，**含 GRACE 空档**（与现状 `durationMs` 一致，不改历史对比基准）。
- 两条口径不同是上游既有行为，账本如实记录，不在本次改造中统一。

### 4.3 表 `provider_usage_monthly`（滚动汇总缓存）

```sql
CREATE TABLE IF NOT EXISTS provider_usage_monthly (
  provider_id       TEXT NOT NULL,
  period_key        TEXT NOT NULL,        -- 'YYYY-MM'
  standard_minutes  REAL NOT NULL DEFAULT 0,
  publisher_minutes REAL NOT NULL DEFAULT 0,
  viewer_minutes    REAL NOT NULL DEFAULT 0,
  session_count     INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, period_key)
);
```

由定时任务从 `usage_intervals` 重算。`agora_providers.estimated_usage_standard_minutes` 是它的最新值副本，供 quota 判断 O(1) 读取。**quota 判断只读本地账本，不读外部接口。**

### 4.4 表 `usage_reconciliation`（对账，可选，明确非核心）

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

### 4.5 埋点位置（对应现有代码）

| 时机 | 现有位置 | 账本动作 |
|---|---|---|
| 会话创建 | `session.service.ts:115-162` | 写 `provider_id` / `agora_app_id` 快照 |
| 主播开始共享 | `startSharing` `:194-265` | 开 publisher interval（ACTIVE 起算） |
| 主播停止 → GRACE | `stopSharing` `:297-330` | 主播区间**不关**（口径含 GRACE）；观众区间关，`reason='grace'` |
| 心跳恢复 ACTIVE | `heartbeat` `:267-292` | 观众区间重新开 |
| 观众连接 | `viewerConnected` `:333-354` ← 由 `session-sse.controller.ts:122-124` 调用 | 开 viewer interval（ACTIVE 时） |
| 观众断开 | `viewerDisconnected` `:357-371` ← `session-sse.controller.ts:157-169` | 关 viewer interval，`reason='viewer_left'` |
| 计费暂停/恢复 | `pauseViewerBilling` / `resumeViewerBilling` `:429-443` | 关/开**观众**区间 |
| 档位切换 | 新功能 | 关旧区间（`tier_change`）+ 开新区间（观众与主播都切） |
| 会话结束 | `endSession` `:488-529` | 关闭所有未关区间，`reason='session_end'` |
| 进程崩溃恢复 | 启动时 | 把 `ended_at IS NULL` 的区间关闭，`reason='crash_recovery'`，`duration_ms` 上限取最后心跳/检查点 |

### 4.6 与现有展示的兼容

`toInfo()` 的 `billingDetail` / `standardMinutes` / `estimatedCost` 是 KOOK 结束卡片的数据源（`kook.service.ts:554-565`），**不能破坏**。做法：

- 保留 `sessions.viewer_duration_ms` 列及其语义，但改为**从 `usage_intervals` 的 viewer 区间求和写入**，这样 `toInfo()` 逻辑几乎不变；
- `toInfo()` 里的硬编码系数与单价改为从 `quality_config` 读取；
- `getQualityInfo(session.quality).tier` 改为「优先读 `sessions.quality_config` 快照里的 `tier`，回退到 preset 反查」—— 同时修好自定义画质的计费，并让旧记录行为不变。

---

## 5. 版本化迁移机制

现状是手写幂等迁移、**无版本表**（见 [architecture-analysis.md](./architecture-analysis.md) 第 6 节）。引入最小版本化框架：

### 5.1 表 `schema_migrations`

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
```

### 5.2 迁移注册表

```ts
// server/src/modules/database/migrations/index.ts
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'baseline',  up: baseline },          // 现有 migrate() 的全部内容，包装为 baseline
  { version: 2, name: 'agora_providers', up: agoraProviders },
  { version: 3, name: 'usage_ledger',    up: usageLedger },
  { version: 4, name: 'quality_config',  up: qualityConfig },
];
```

执行逻辑：

```ts
this.db.exec(CREATE TABLE IF NOT EXISTS schema_migrations ...);
const applied = new Set(this.db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
for (const m of MIGRATIONS) {
  if (applied.has(m.version)) continue;
  this.db.transaction(() => { m.up(this.db); recordMigration(m); })();
  this.logger.log(`Applied migration ${m.version}: ${m.name}`);
}
```

### 5.3 关键约束

1. **baseline 必须完全保留现有 `migrate()` 的幂等语义**（`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 守卫 + `INSERT OR IGNORE`），因为存量库和新库都会跑它。
2. **version 号一旦发布不可复用、不可修改**。要改已发布的迁移，新增一个 version。
3. **每个迁移在自己的事务里执行**，失败则整体回滚，`schema_migrations` 不记录。
4. **不提供 down 迁移**（SQLite 的 `ALTER` 能力有限，且本项目无回滚需求）；需要回退时手写脚本。
5. 数据回填（例如存量凭证 → provider 行）也走迁移，而不是散落在 `migrate()` 里。

### 5.4 ⚠️ 会话 / 服务器表加列的五处联动

给 `sessions` 或 `servers` 加列时，**必须同时改这五处**，漏任何一处都会静默丢字段：

| # | 位置 | 说明 |
|---|---|---|
| 1 | 迁移里的 `ALTER TABLE ... ADD COLUMN` | DDL |
| 2 | `ALLOWED_SESSION_COLS` / `ALLOWED_SERVER_COLS` | 列白名单（`database.service.ts:844-851` / `:667-677`）。不在白名单里的列会被 `updateSession`/`updateServer` **静默跳过**（只 warn，不抛错） |
| 3 | `mapSessionRow` / `mapServerRow` | 数据库下划线列名 → 驼峰字段的映射（`database.service.ts:548-577` / `:580-609`） |
| 4 | `ServerSession` / `ServerRecord` 接口 | 类型定义（`database.service.ts:102-130` / `:28-55`） |
| 5 | `ShareSession`（`session.types.ts:11-43`）+ `toDb` / `fromDb` | 内存模型与转换（`session.service.ts:40-99`） |

例外：`provider_id` / `agora_app_id` 是**故意不加**到白名单的（见 3.3），用于物理禁止修改。
