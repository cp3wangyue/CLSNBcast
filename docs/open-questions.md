# 问题要点清单

> 已决策 / 待决策 / 新发现的问题与校准方案。
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
| 11 | 计费系数 | **改为管理员可配**；默认取官方确认值（音频 `0.57` / HD `2` / Full HD `4.5` / 2K `8` / 2K+ `18`），其中 Full HD 修正了上游的 `4.57` | 见 §4：公开文档只能当参考默认值，最终以你自己账号的声网控制台账单为准校准 |
| 12 | 计费周期与时区 | **`Asia/Shanghai` 自然月，单位「标准分钟」** | 写进 `quality_config.usage_timezone`，可改 |

---

## 2. 待决策

上一轮遗留的 A/B/C/D 四项已全部处理完毕：

| # | 问题 | 结果 |
|---|---|---|
| A | 页脚署名 | **暂时不写**。已按决定删除 `DEVELOPER` / `EMAIL` 常量与页脚署名行，只保留 `© 2026 CLSNBcast` |
| B | 站点图标 | **采用新生成的 SVG 图标** `web/public/clsnbcast-icon.svg`；上游那张 948 KB / 1280×720 小羊美术已删除（它只被 favicon 引用） |
| C | 上游仓库链接 | 已改为 `https://github.com/cp3wangyue/CLSNBcast` |
| D | 计费系数 | 已定案，见 **§4**（改为数据驱动校准，不再作为待决策项） |

**当前没有阻塞性待决策项。** 开工后新出现的问题补充到本节；与计费相关但尚未确认的小项见 §4.3 与 §5。

---

## 3. 新发现的问题

### 3.1 🔴 计费系数与官方文档不一致 → 已分析定案，见 §4

上游 `ULTRA_LOW_LATENCY_COEFFICIENTS` 的 **Full HD 值为 `4.57`，官方文档为 `4.5`**（5 次独立抽取全部一致），是系统性高估，且因极速直播是默认模式而影响面最大。另外官方计费表里**没有「SD 标清」档**（SD 归入 HD，上游代码注释已承认这点，处理方式正确）。2K / 2K+ 两格无法从公开文档收敛。

完整核对过程、逐格置信度、以及改为「数据驱动校准」的决定见 **§4**。

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
| 7 | ⏳ 无 CI、无 lint（**CI 已补，lint 仍缺**） | 全仓 | 没有自动化质量门禁 | **CI 已完成**：`.github/workflows/ci.yml` 在 push / PR 时跑 `npm run verify`（typecheck + build + test），实测通过。**lint 仍缺**：本仓从未引入 ESLint，且 `verify` 不含 lint，加进来需要先定规则集与存量告警的处理方式 |
| 8 | ✅ **`strictNullChecks` 已开启**（2026-09-25 评估后落地） | `server/tsconfig.json` | 类型错误容易漏到运行时 | **已开启**：实测仅 14 处报错（集中 2 个文件），改完 0 错误、0 新增依赖。文档原先担心「会炸开改动面」**不成立**。`noImplicitAny` **仍关闭** —— 它有 10 处报错，但全部是同一个根因：`better-sqlite3` 无类型声明且未装 `@types/better-sqlite3`，修它要新增依赖，超出「收紧类型」范围，留待决策 |
| 9 | `kook.service.ts` 死代码 | `kook.service.ts:187-192` 拼了含 `appCertificate` 的 `serverConfig.agora`，无任何消费者 | 无用代码 + 明文证书在内存里多一份 | Phase 1 顺手清理 |
| 10 | `.env.example` 不完整 | `.env.example` | 代码读取的 `KOOK_BOT_TOKEN`、`LEGACY_ADMIN_SUNSET_AT` 未记录 | Phase 4 |
| 11 | ✅ `deploy.sh` 曾硬编码默认值 | `deploy.sh:4` `SSH_HOST=rainyun` | 换环境需改脚本 | **已修**：`SSH_HOST` 改为必填（环境变量或首个位置参数），缺失时在构建前报错；新增可选 `SSH_PORT` 与 `-h/--help` |
| 12 | ✅ **`incremental` + `deleteOutDir` 组合导致产物残缺**（上游遗留，严重） | `server/tsconfig.json` 的 `incremental: true` 把增量信息写到 `dist` 之外的 `server/tsconfig.build.tsbuildinfo`，而 `server/nest-cli.json` 开了 `deleteOutDir` | **第二次及以后的构建什么都不输出**，`dist` 变成空目录或只剩改动过的文件。`deploy.sh` 与 Docker 镜像会拿到残缺产物，容器启动即 `MODULE_NOT_FOUND` | **Phase 0 已修**（`tsconfig.build.json` 设 `incremental: false`） |
| 13 | ✅ **`rootDir` 推断导致入口点漂移** | `server/tsconfig.build.json` 原先未固定 `rootDir` | 在 `server/` 根目录新增任何 `.ts`（如 `vitest.config.ts`）都会把 `rootDir` 上移，产物从 `dist/main.js` 变成 `dist/src/main.js`，打断 `Dockerfile` 的 `CMD` 与 `deploy.sh` 的存在性检查 | **Phase 0 已修**（显式固定 `rootDir: "./src"`） |
| 14 | ⚠️ **`better-sqlite3` 在 Node 20 上无预编译包，装不上**（2026-09-22 真实部署时发现） | `server/package.json:20` `better-sqlite3: ^12.11.1` | v12.x 只发布 ABI 127/137/141/147 的预编译包，**没有 Node 20 的 ABI 115**，npm 回退到源码编译；无 Python / C++ 工具链的机器直接安装失败（`gyp ERR! find Python`）。Docker 路径不受影响（镜像内装了工具链现场编译） | **Windows 部署已在 `DEPLOY.md` 记录解法**（换用有 ABI 115 预编译包的 `v11.10.0`）；**仓库依赖声明未改**——是否把版本约束下调以便所有环境统一，留待决策 |

---

## 4. 计费系数：核对结论与校准方案

### 4.1 核对结论

我通过多个平台路径（android / ios / flutter）反复抓取官方计费文档的「标准时长折算系数」表，共 5 次独立抽取。逐格结果：

| 档位 | 主播 / 互动直播观众 | 极速直播观众（官方） | 上游现值 | 结论 |
|---|---|---|---|---|
| 音频 | 1 | **0.57** | 0.57 | ✅ 一致 |
| HD 高清（含 SD） | 4 | **2** | 2 | ✅ 一致 |
| 全 HD 全高清 | 9 | **4.5** | 4.57 | ✅ **已修正为 4.5**（Phase 2-3 落地，随配置默认值生效） |
| 2K | 16 | 7.8 或 8（3:2 分歧） | 8 | 🕓 **待定**，暂用 `8` |
| 2K+ 超高清 | 36 | 18 或 8（3:2 分歧） | 18 | 🕓 **待定**，暂用 `18` |

**置信度**：

- **0.57 / 2 / 4.5 已确认**：5 次抽取全部一致，且 0.57 在文档自身的计算示例里被二次印证（「360 × 0.57 = 205.2 秒」）。
- **2K / 2K+ 无法从公开文档收敛**：5 次抽取出现 3:2 分歧（`7.8 / 18` 对 `7 / 8`）。官方文档的表格在文本抽取时结构丢失，我无法进一步确定。

**一个有用的旁证**：除音频外，极速直播系数恰好都是互动直播系数的**一半** —— 2 = 4/2、4.5 = 9/2、18 = 36/2。该关系在四个视频档位中成立三个，唯一被破坏的格子正是争议中的 2K（若为 8 则关系完全成立；若为 7 或 7.8 则破坏）。所以 **2K+ = 18 比 8 可信**（取 8 会让两个格子同时破坏该关系），2K 我倾向 8。

**实际影响**：极速直播是默认模式，所以这套系数覆盖绝大多数会话。但真正被高频命中是 **Full HD**（默认画质 1080p），而这一格正是上游明确写错的地方。修掉它消除的是约 **1.5% 的系统性高估**。2K / 2K+ 只在用户主动选高档位时才命中，影响面小得多。

### 4.2 决定：不设人工核对，改为数据驱动校准

公开文档不是权威来源 —— **权威来源是你自己账号在声网控制台的实际计费数据**。你最初的架构要求里也写了「声网不同账户、项目和计费模型可能不同」，这正说明公开表格只能当参考默认值。

所以这件事从「待你核对」改成「设计内建的校准流程」：

1. **Phase 2 交付时**，`quality_config` 的系数默认值取官方确认值：音频 `0.57` / HD `2` / Full HD `4.5` / 2K `8` / 2K+ `18`（后两者为**待定**的暂用值，见 §4.3）。
2. **每条 `usage_intervals` 在结算时快照当时的 `coefficient` 与 `tier`**，所以后续调整系数不会篡改历史账目。
3. **`usage_reconciliation` 记录「本地估算 vs 声网官方用量」的差异**，Phase 2-5 接入官方用量 API 后自动落库。
4. **校准动作**：拿到第一个完整计费周期的真实数据后，对比本地估算与官方账单，按差异调整 `quality_config` 的系数 —— **通过管理面板改，不需要改代码发版**。

这样 2K / 2K+ 的悬而未决不再是阻塞项：先用可配默认值上线，用真实数据收敛。**唯一现在就该修的是 Full HD（4.57 → 4.5）**，因为它已确认且有系统性影响。

### 4.3 待定项（先用默认值推进，不阻塞开发）

以下三项我无法从公开信息确定，**先用下列默认值实现并标注为待定**。三项都通过管理面板配置，调整不需要改代码发版：

| 待定项 | 暂用默认值 | 何时能定 |
|---|---|---|
| 2K / 2K+ 极速直播系数 | `8` / `18` | 第一个完整计费周期后，用 `usage_reconciliation` 对比官方账单校准 |
| 后付费单价 | `0.007` 元/标准分钟（= 7 元 / 1000 标准分钟） | 你查声网控制台价格页确认；各账户可能有差异 |
| 未建模的计费项（录制 / 转码 / CDN 推流） | 不建模 | 若你的账户账单里出现这些项，再补 |

---

## 5. 待定项（不阻塞开发，先用默认值推进）

| 待定项 | 暂用默认值 | 说明 |
|---|---|---|
| `monthly_quota_standard_minutes` 初始值 | 不设（`NULL` = 不限） | 字段可空，**不写死 10000**。等你按实际账户配额填；在此之前不触发 quota 拦截 |
| 新会话默认直播模式 | 极速直播（`lowLatency: false`） | 保持上游现状，改动最小 |
| KOOK Bot 发起的会话默认画质 | `1080p_2` | 保持上游现状。自由画质上线后（Phase 3）再评估是否改为每服务器可配 |

**原则**：以上全部先用「保持现状」或「不限」作为默认值实现，使开发不被阻塞；任何一项都不需要改代码就能调整。

---

## 6. 已确认的技术事实（供决策参考）

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
