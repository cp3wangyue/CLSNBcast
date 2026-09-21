# CLSNBcast · 屏幕共享

聊天软件快捷屏幕共享工具。在频道发条消息即可发起共享，观众免登录观看。当前支持 **KOOK**。

基于 Agora 声网 RTC 做音视频传输，其余部分（前端、后端、Bot、数据库、Session 管理、Agora 凭证管理、RTC Token 签发）全部自托管，可部署在自己的 Linux VPS 上。

---

## 功能特性

- **免登录观看** —— 频道成员点击卡片即可观看，无需安装、无需注册
- **双模式直播** —— 极速直播（延迟 1500–2000ms，费用较低，默认）与低延迟模式（延迟 400–800ms，费用较高）
- **窗口声音隔离** —— 只共享选中窗口的声音，语音软件不被采集，解决共享时的回声问题
- **自动节费管理** —— 自动检测共享状态（无人观看超时、心跳丢失、会话最大时长），无需手动干预
- **多画质可选** —— 480P ~ 4K 共 7 档画质，由服务器管理员按服务器开放
- **服务器主自管理** —— 每服务器独立管理面板，频道主可自行配置画质、Agora 凭证、超时参数

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | NestJS 10 + Express |
| 前端 | React 18 + Vite 5 + TypeScript + Tailwind CSS |
| 数据库 | SQLite（better-sqlite3，WAL 模式） |
| Bot | KOOK Webhook（收件箱表 + 幂等 worker） |
| 实时通道 | SSE（发布端心跳 + 状态推送） |
| 音视频 | Agora Web SDK NG（RTC Token 由本服务端签发） |

单 Node 进程同时提供 API 与前端静态资源，无需额外 Web 服务器（生产环境建议在前面加反向代理提供 HTTPS）。

---

## KOOK 使用指南

### 1. 邀请机器人

邀请机器人到你的 KOOK 服务器。机器人加入后自动向频道主发送绑定卡片。

### 2. 绑定管理面板

频道主点击绑定卡片，设置管理密码，然后配置 Agora App ID 和 App Certificate（每服务器独立配置）。若需重新调起绑定，频道主发送 `/cbhelp`。

### 3. 发起屏幕共享

频道内发送触发词（默认「屏幕共享」）→ 机器人推送卡片 → 点击「开始共享」→ 浏览器弹窗授权屏幕（记得勾选「分享音频」）→ 频道成员点击卡片免登录观看。

> 触发词由**超管**在超管面板中为各服务器配置，频道主不可自行修改。

### 可用指令

| 指令 | 说明 |
|---|---|
| `屏幕共享` | 发起共享（默认触发词，超管可在面板自定义） |
| `/cbhelp` | 频道主：绑定/管理面板；普通成员：使用说明卡片（含一键发起共享按钮） |
| `/xchelp` | 同上，`/cbhelp` 的待弃用别名 |

### 权限提示

屏幕采集需要 **HTTPS** 环境（`localhost` 除外）。通过 `http://` 访问时浏览器会拒绝采集权限。

---

## 部署

完整部署说明（含反向代理与 HTTPS 配置）见 [DEPLOY.md](./DEPLOY.md)。

快速开始：

```bash
# 1. 配置环境变量
cp .env.example .env
vim .env                       # 至少填写 SUPER_ADMIN_PASSWORD

# 2. 本地构建前端与后端产物（镜像内不编译，只装载 dist）
npm install
npm run build

# 3. 构建镜像并启动
docker compose up -d --build
```

启动后访问超管面板完成 KOOK 与公网域名配置：

1. 打开 `/super`，用 `SUPER_ADMIN_PASSWORD` 登录
2. 在「全局配置」填入 KOOK Bot Token、Verify Token、Encrypt Key 和公网域名
3. 在 KOOK 开发者后台把机器人连接模式设为 **WebHook**，Callback URL 填超管页面显示的地址（**必须保留 `?compress=0`**）
4. 在 KOOK 后台填写相同的 Encrypt Key，完成 Challenge 后上线机器人

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `SUPER_ADMIN_PASSWORD` | ✅ | 超管登录密码。**未设置则服务拒绝启动** |
| `PORT` | | 服务端口，默认 `3520` |
| `ALLOWED_ORIGINS` | | CORS 额外允许的域名，逗号分隔。不设则仅允许本地开发域名 |
| `KOOK_API_TIMEOUT_MS` | | KOOK HTTP API 请求超时（毫秒），默认 `10000` |
| `KOOK_BOT_TOKEN` | | 首次启动时播种到数据库。也可登录超管面板后填写 |

> Agora 凭证不在环境变量配置 —— 机器人加入服务器后，由频道主在管理面板中为每个服务器独立配置。

### 数据持久化

SQLite 数据库位于容器内 `/app/data/clsnbcast.db`，通过命名卷 `clsnbcast-data` 持久化。升级或重建容器不会丢失数据。

---

## 模块结构

```
server/src/modules/
├── database/       SQLite 数据层（表结构、迁移、配置）
├── agora/          Agora RTC Token 签发
├── kook/           KOOK Bot：Webhook 收件箱 + 幂等 worker + 卡片构建
├── session/        会话生命周期（状态机、观众计数、计费区间、watchdog）
├── share/          共享页 API（info / token / start / stop）
├── auth/           分享链接鉴权 Guard
├── events/         模块间事件总线
├── notices/        公告系统
├── super-admin/    超管面板 API
└── server-admin/   服务器管理员 API

web/src/
├── pages/          首页 / 共享 / 观看 / 超管 / 服务器管理
├── hooks/          useScreenShare / useAgoraView / useSessionSSE
├── components/     公告组件
└── lib/            API 封装 / 屏幕音频劫持 / 工具函数
```

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture-analysis.md](./docs/architecture-analysis.md) | 现有架构分析：会话数据流、耦合点、回归风险图 |
| [docs/data-model-design.md](./docs/data-model-design.md) | AgoraProvider / QualityConfig / UsageLedger 数据模型设计 |
| [docs/development-plan.md](./docs/development-plan.md) | 开发顺序与阶段计划 |
| [docs/open-questions.md](./docs/open-questions.md) | 问题要点清单（已决策 / 待决策 / 新发现） |
| [docs/upstream.md](./docs/upstream.md) | 代码溯源与上游同步策略 |

---

## 开发

```bash
npm install            # 安装 server + web 两个 workspace 的依赖

# 开发模式
npm run build:web      # 构建前端
npm run build:server   # 构建后端
npm run build          # 两者都构建
npm start              # 以生产模式启动（需先 build）
```

本地开发时前端 Vite 会把 `/api` 代理到 `http://localhost:3520`，可用 `VITE_API_TARGET` 覆盖。

启动后端需要 `SUPER_ADMIN_PASSWORD` 环境变量，否则进程会直接退出。
