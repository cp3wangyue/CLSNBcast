# 上游关系与代码同步

> 本文档是仓库中**唯一**记录上游来源的地方。
> `README.md`、前端文案、KOOK 卡片文案、代码标识符均已自有化为 **CLSNBcast**，与上游不存在品牌关系。
> 保留上游关系的目的只有一个：**代码溯源与选择性合并**。

---

## 1. 远端配置

| 远端 | 地址 | 用途 |
|---|---|---|
| `origin` | `https://github.com/cp3wangyue/CLSNBcast` | 我们的仓库，日常 push 目标 |
| `upstream` | `https://github.com/rnm330/XgoatCast` | 只读参考源 |

`upstream` 的 push URL 已被显式禁用，防止误推：

```bash
git remote -v
# upstream  https://github.com/rnm330/XgoatCast.git (fetch)
# upstream  DISABLED_NO_PUSH (push)
```

---

## 2. 基线

本项目基于上游 `main` 分支的 **`d943e16`**（`fix: harden KOOK webhook processing and deployment`）初始化。

初始化时 `origin` 仓库是空的（只有一个 11 字节的 `README.md`，内容是 `# CLSNBcast`，没有任何代码），因此执行了：

```bash
git remote add upstream https://github.com/rnm330/XgoatCast.git
git remote set-url --push upstream DISABLED_NO_PUSH
git fetch upstream
git merge upstream/main --allow-unrelated-histories
```

`--allow-unrelated-histories` 是必需的：两个仓库没有共同祖先。合并后上游提交成为本地历史的**祖先节点**，这是后续能正常 `merge` / `cherry-pick` 的前提条件。

> 如果当初改成「reset 到上游再强推」，虽然历史更干净，但会破坏「保留上游、可选择性合并」的能力，并且是破坏性的远端操作。

---

## 3. 同步上游更新

```bash
# 1. 拉取上游最新提交
git fetch upstream

# 2. 看有什么新东西
git log --oneline HEAD..upstream/main
git log --oneline --stat HEAD..upstream/main

# 3a. 整体合并（建议先看 diff 再决定）
git diff HEAD..upstream/main
git merge upstream/main

# 3b. 或只挑某个提交
git cherry-pick <sha>
```

合并后必须验证：

```bash
npm install && npm run build
```

---

## 4. 合并策略与冲突规避

本项目对上游做了长期客制化，合并冲突不可避免。以下几条能显著降低冲突面：

1. **不要重排上游文件的行，不要顺手调整上游代码的缩进或格式。** 只做必要的最小改动，git 的三方合并才能在多数情况下自动处理。
2. **品牌改名会与上游产生广泛冲突。** 改名触及 22 个文件里的字符串与标识符。这是已知且接受的代价。合并时如果冲突集中在品牌字符串上，取上游的逻辑、保留我们的命名即可。
3. **新增能力优先放新文件/新模块**（例如后续的 `AgoraProviderService`、`usage` 模块），而不是把上游文件改得面目全非。上游文件里只加最小接线。
4. **`README.md` 已被重写为自有版本**，上游改 README 时会冲突。处理方式：保留我们的 README，不采纳上游的 README 变更。
5. **合并前先确认基线可构建**，避免把上游的问题和本地的问题混在一起排查。
6. 涉及数据库结构的上游变更，注意本项目的迁移机制与上游不同（本项目引入了版本化 migration，见 [data-model-design.md](./data-model-design.md) 第 5 节），不能直接照搬上游的 `PRAGMA table_info` + `ALTER` 写法。

---

## 5. 上游值得参考的实现

以下上游实现质量较好，后续开发可参考其思路（而非照搬代码）：

| 主题 | 上游位置 | 备注 |
|---|---|---|
| KOOK Webhook 幂等 | `kook-webhook.worker.ts` + `kook_webhook_events` / `kook_webhook_effects` 表 | 「收件箱去重 + 业务副作用闸门」两层设计，能正确处理崩溃窗口而不重复产生会话或卡片。后续 Provider / 账本的写操作可复用同样的幂等思路 |
| 观众计费区间 | `session.service.ts` 的 `viewerPresenceMap` / `accrueViewerDuration` / `pauseViewerBilling` | 已有「区间」概念的雏形（`billingStartedAt` → 结算）。UsageLedger 就是把这个内存区间持久化 |
| 观众去重 | `session.service.ts` 的 `viewerIdsMap` + `session-sse.controller.ts:countViewers` | 用 viewerId 去重，避免重连重叠导致重复计数 |
| 画质预设与折算系数 | `session.types.ts` | 将被 QualityConfig 取代，见 [data-model-design.md](./data-model-design.md) 第 2 节 |
| SSE 长连接保活 | `session-sse.controller.ts` | 发布端 4s 心跳同时驱动 session heartbeat，设计紧凑 |

---

## 6. 与上游的行为差异（累积记录）

随着客制化推进，这里记录与上游的**有意行为差异**，便于合并上游时判断哪些差异必须保留：

| 差异 | 引入 commit | 必须保留 |
|---|---|---|
| 品牌自有化（CLSNBcast / 🖥 / `cbhelp` / `cb_` channel 前缀） | `refactor: rebrand ...` | ✅ 必须保留 |
| `README.md` 自有化 | `refactor: rebrand ...` | ✅ 必须保留 |
| （后续）AgoraProvider 多租户、UsageLedger、自由画质 | 见 [development-plan.md](./development-plan.md) | ✅ 必须保留 |
