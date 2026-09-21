# 问题要点清单

> 已决策 / 待决策 / 新发现的问题，以及需要人工核对的清单。
> 最后更新：2026-09-22
>
> 相关文档：现状分析 → [architecture-analysis.md](./architecture-analysis.md) ｜ 数据模型 → [data-model-design.md](./data-model-design.md) ｜ 开发顺序 → [development-plan.md](./development-plan.md)

---

## 1. 已决策

| # | 问题 | 决策 | 影响 |
|---|---|---|---|
| 1 | 改名范围 | **全面改名**（显示名、图标、命令、package name、DB 文件、Docker 服务/容器、卷、部署目录、channel 前缀、浏览器存储 key） | 22 个文件；因项目尚未部署，**零迁移成本** |
| 2 | 秘密加密范围 | **先只加密 Agora 相关**（App Certificate / Customer Secret）。KOOK 三密钥与 `server_secret` 放 Phase 5 | Phase 1 范围可控、便于评审 |
| 3 | 主播时长计费口径 | **保持现状**（`endedAt - startedAt`，含 GRACE 空档） | 观众 ACTIVE-only 与主播含 GRACE 的口径差异被保留，历史对比基准不变。账本按同口径记录 |
| 4 | quota 达到阈值的行为 | **停止分配新会话**，不中断进行中的会话 | 避免突袭用户，符合「不得破坏现有 Session / 观看链接」 |
| 5 | 部署状态 | **尚未部署** | 改名不写任何兼容 shim、不写数据迁移脚本 |
| 6 | 品牌标识 | **CLSNBcast + 🖥**，副标题「屏幕共享」 | 替代上游的「小羊 / 🐑」 |
| 7 | KOOK 帮助命令 | **改名 `/cbhelp`，保留 `/xchelp` 作为待弃用别名** | 老用户不会突然失效；过渡期后可删旧别名 |

### 1.1 已按推荐默认（原问题未回答，可随时推翻）

| # | 问题 | 采用的默认 | 理由 |
|---|---|---|---|
| 8 | 运行中可动态切换的参数 | **只切 分辨率 / 帧率 / 码率**；`optimizationMode` 与 `codec` 作为「开始共享前」选项 | SDK 限制：`optimizationMode` 不是 `VideoEncoderConfiguration` 字段（只是 track 创建参数，值只有 `motion`/`detail`），`codec` 是 `createClient({codec})` 的 client 级必填参数。两者都无法用 `setEncoderConfiguration` 切换 |
| 9 | Agora SDK 版本 | **锁到具体版本，仍走 Agora CDN**（`AgoraRTC_N-4.20.2.js`） | 一行改动即可消除「行为随版本漂移」；保留 CDN 便利性 |
| 10 | Provider 健康检查手段 | **离线校验（可解密 + 可试签 token）永远执行；配置了 Customer ID/Secret 时叠加官方用量 API；真实 RTC 探针仅手动触发** | 全程免费。声网没有免费的「验证 App ID 是否可用」接口，而 RTC 探针会产生真实计费 |
| 11 | 计费系数 | **改为管理员可配，默认沿用上游现值**，不改任何历史口径 | 见 §3.1：官方值我无法可靠确认，需人工核对后再调 |
| 12 | 计费周期与时区 | **`Asia/Shanghai` 自然月，单位「标准分钟」** | 写进 `quality_config.usage_timezone`，可改 |

---

## 2. 待决策

| # | 问题 | 需要你决定什么 | 我的建议 |
|---|---|---|---|
| A | 页脚署名 | `HomePage.tsx:5,6` 是 `DEVELOPER = 'xgoat小羊'` / `EMAIL = 'xgoateam@gmail.com'`。我不知道该换成什么 | 默认**删掉这两行**（连同常量），只保留 `© 2026 CLSNBcast`。若要保留署名，请提供开发者名与邮箱 |
| B | 站点图标 | `web/public/cover-default.png`（948 KB / 1280×720）大概率是上游的小羊美术，需要换 | 默认**生成一个简洁的 CLSNBcast 图标**（纯色底 + 文字/几何，出 SVG 与 256×256 PNG），同时保留 1280×720 的封面版本。如果你有现成图标，给我文件我直接换上 |
| C | 上游仓库链接 | `HomePage.tsx:4` 的 `GITHUB_URL` 现在指向 `https://github.com/rnm330/XgoatCast` | 默认改为我们自己的仓库 `https://github.com/cp3wangyue/CLSNBcast` |
| D | 计费系数最终值 | 见 §4 待核对清单 | 先沿用上游现值上线，你核对后再通过管理面板调整 |

---

## 3. 新发现的问题

### 3.1 🔴 计费系数与官方文档不一致

**官方表里没有「SD 标清」档。** 声网新计费模型（2024 年 7 月起）的视频档位只有 4 档，SD 分辨率被归入 HD 档。上游代码注释也承认了这点（`session.types.ts:51`：`'SD 标清': 4, // SD 分辨率映射到 HD 档`）。所以 SD 与 HD 用同一系数是正确的，保留 SD 条目只是为了给 640×480 一个可读的档位名。

**更值得关注的是极速直播系数。** 对比结果：

| 档位 | 上游 `ULTRA_LOW_LATENCY_COEFFICIENTS` | 我从官方文档抓到的值 | 一致？ |
|---|---|---|---|
| 音频 | 0.57 | 0.57 | ✅ |
| HD 高清 | 2 | 2 | ✅ |
| Full HD 全高清 | 4.57 | 4.5 | ❌ 不一致 |
| 2K | 8 | 7 或 7.8 | ❌ 不一致（两次抓取结果还互相矛盾） |
| 2K+ 超高清 | 18 | 8 或 18 | ❌ 不一致（两次抓取结果还互相矛盾） |

**为什么这件事重要**：极速直播是**默认模式**（`lowLatency: false`），所以绝大多数会话走的就是这套系数，直接影响 `estimatedCost` 与后续 quota 判断。

**为什么我无法直接下结论**：我用 `WebFetch` 抓官方文档两次，两次结果互相矛盾（2K+ 得到 `8` 和 `18` 两个值；2K 得到 `7` 和 `7.8`）。官方文档的表格在文本抽取时结构丢失，**我无法可靠确认**。因此按决策 11 默认沿用上游现值，另出核对清单（§4）。

**顺带一个可疑点**：上游的极速直播系数恰好都是互动直播系数的**一半**（HD 2=4/2，FullHD 4.57≈9/2，2K 8=16/2，2K+ 18=36/2），只有音频 0.57 例外。这暗示上游可能是按「一半」推算而非查官方表。而官方表若为 `2, 4.5, 7, 8` 则**不是**整齐的一半关系。这进一步说明需要人工核对。

> 无论最终值是什么，`quality_config` 都让系数变成管理员可配，不需要改代码发版。这是本项设计的主要收益。

### 3.2 ✅ 官方档位边界已确认

以下边界值已对照官方文档确认，可直接用于 `tier_rules`：

| 档位 | 集合分辨率范围 |
|---|---|
| HD 高清 | ≤ 921,600（1280×720） |
| Full HD 全高清 | 921,600 ＜ x ≤ 2,073,600（1920×1080） |
| 2K | 2,073,600 ＜ x ≤ 3,686,400（2560×1440） |
| 2K+ 超高清 | ＞ 3,686,400 |

另有官方说明：**最终计算结果保留到个位数，向上取整**（现有 `toInfo()` 的 `Math.ceil` 与之一致）；主播与互动直播观众的系数完全相同（音频 1 / HD 4 / FullHD 9 / 2K 16 / 2K+ 36）。

### 3.3 其他发现

| # | 问题 | 位置 | 影响 | 计划 |
|---|---|---|---|---|
| 1 | **首页有指向上游仓库的链接** | `web/src/pages/HomePage.tsx:4` `GITHUB_URL = 'https://github.com/rnm330/XgoatCast'` | 与「不要与上游仓库产生关系」直接冲突 | 本轮改名一并修掉 |
| 2 | 缺 `trust proxy` | `server/src/main.ts`（未设置） | 反代后 `req.ip` 退化为代理 IP，**使登录/绑定接口的按 IP 限流失效**（`main.ts:93`） | Phase 4 |
| 3 | HMAC 比较非常量时间 | `main.ts:161` `if (sig !== parts[1])` | 理论上的时序侧信道 | Phase 5 |
| 4 | 遗留角色分支 | `main.ts:143` 处理 `role='server_admin'`，但签发端只发 `'space_admin'`（`server-admin.controller.ts:102`） | 死分支，增加阅读成本 | Phase 5 |
| 5 | 管理 token 无法吊销 | `super-admin.controller.ts:37-59` | 7 天有效期内无法失效；重新绑定服务器不轮换 `server_secret` | Phase 5 |
| 6 | favicon `type` 与实际格式不匹配 | `web/index.html:5` 声明 `type="image/svg+xml"` 但指向 PNG | 轻微；部分浏览器可能不加载 | **本轮改名一并修** |
| 7 | 无 CI、无 lint | 全仓 | 没有自动化质量门禁 | Phase 0 至少补 typecheck + test；CI 待定 |
| 8 | 服务端类型检查宽松 | `server/tsconfig.json:15-16` `strictNullChecks: false` / `noImplicitAny: false` | 类型错误容易漏到运行时 | 不在 Phase 0 一次性收紧（会炸开改动面），后续单独评估 |
| 9 | `kook.service.ts` 死代码 | `kook.service.ts:187-192` 拼了含 `appCertificate` 的 `serverConfig.agora`，无任何消费者 | 无用代码 + 明文证书在内存里多一份 | Phase 1 顺手清理 |
| 10 | `.env.example` 不完整 | `.env.example` | 代码读取的 `KOOK_BOT_TOKEN`、`LEGACY_ADMIN_SUNSET_AT` 未记录 | Phase 4 |
| 11 | `deploy.sh` 硬编码默认值 | `deploy.sh:4,5,6` `SSH_HOST=rainyun`、`REMOTE_DIR=/root/clsnbcast` | 换环境需改脚本 | Phase 4 |

---

## 4. 待人工核对清单

### 4.1 声网计费系数（优先级最高）

请在**声网控制台 → 用量/计费页面**或可正常访问的官方文档中核对下表，然后通过管理面板调整（无需改代码）：

| 档位 | 主播 / 互动直播观众 | 极速直播观众（上游现值） | 请填写官方值 |
|---|---|---|---|
| 音频 | 1 | 0.57 | |
| HD 高清（含 SD） | 4 | 2 | |
| Full HD 全高清 | 9 | **4.57** | |
| 2K | 16 | **8** | |
| 2K+ 超高清 | 36 | **18** | |

参考文档（我抓取时结构丢失，需你确认）：
`https://doc.shengwang.cn/doc/rtc/android/billing/billing-strategy`

另外请确认：
- [ ] 后付费单价是否仍为 **7 元 / 1000 标准分钟**（即 0.007 元/分钟）？
- [ ] 是否存在我们未考虑的计费项（例如录制、转码、CDN 推流）？

### 4.2 其他待确认

- [ ] **`monthly_quota_standard_minutes` 的初始值**：每个 Provider 配多少？（不写死 10000，由你按实际账户配额填）
- [ ] **极速直播 vs 互动直播的默认值**：新会话默认走哪个？（现状默认极速直播 `lowLatency: false`）
- [ ] **自定义画质的默认预设**：KOOK Bot 发起的会话目前硬编码默认 `1080p_2`（`session.service.ts:146`）。自由画质上线后，默认档位是否改为每服务器可配？

---

## 5. 已确认的技术事实（供决策参考）

以下均已通过阅读 SDK 类型定义（`agora-rtc-sdk-ng@4.20.2` 的 `rtc-sdk_en.d.ts`）或代码核实，不是推测：

| 事实 | 依据 |
|---|---|
| `ILocalVideoTrack.setEncoderConfiguration(config): Promise<void>` 存在 | SDK 类型定义 |
| `VideoEncoderConfiguration` 只有 `width` / `height` / `frameRate` / `bitrateMin` / `bitrateMax` / `scaleResolutionDownBy` 六个字段 | SDK 类型定义 |
| `optimizationMode` 只有 `'motion'` 和 `'detail'` 两个值（**没有 `'balanced'`**），且只出现在 track 创建配置里 | SDK 类型定义 |
| codec 是 `ClientConfig.codec`（必填，`vp8`/`h264`/`vp9`/`h265`/`av1`），client 生命周期内固定 | SDK 类型定义 |
| Agora 官方建议码率区间 **100–5000 Kbps** | SDK 类型定义注释原文 |
| 本项目 preset key 与 Agora 内置 preset 名**部分同名但语义不同**（例：本项目 `1080p_2` = 1920×1080@30 `bitrateMin: 2000` 无 max；Agora `1080p_2` = 1920×1080@30 `bitrate: 3000`） | SDK 预设表对比 |
| 监控数据齐备：`LocalVideoTrackStats`（`sendFrameRate` / `sendResolutionWidth/Height` / `sendBytes` / `sendRttMs` / `sendJitterMs` / `sendPacketsLost`）+ `client.on('network-quality')` 每 2s | SDK 类型定义 |
| 字段缺失情况：`sendFrameRate` 在 Firefox 不可得；`captureFrameRate` 在 Safari/Firefox 不可得；`sendPacketsLost` 在 Safari 不可得 | SDK 类型定义注释 |
