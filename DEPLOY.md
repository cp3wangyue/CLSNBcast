# 部署指南（自托管）

在普通 Linux VPS 上使用 Docker Compose 部署 CLSNBcast。

有两种形态：

- **推荐**：Caddy 反向代理 + 自动 HTTPS（`docker-compose.yml`）
- **备选**：已有 Nginx 自行终止 TLS（见文末）

---

## 0. 前置条件

- 服务器安装 Docker 与 Docker Compose 插件
- 一个指向本机公网 IP 的域名（A 记录），例如 `share.example.com`
- 开放 **80 / 443** 端口（80 用于 HTTP-01 证书校验与跳转）

> ⚠️ **必须使用 HTTPS。** 浏览器只在安全上下文或 localhost 下允许
> `getDisplayMedia`（屏幕采集），通过 `http://` 访问时分享页会直接报权限错误。

---

## 1. 准备文件

```bash
git clone https://github.com/cp3wangyue/CLSNBcast.git
cd CLSNBcast

cp .env.example .env
```

编辑 `.env`，至少填写：

| 变量 | 说明 |
|---|---|
| `DOMAIN` | 对外域名，Caddy 用它自动签发证书 |
| `SUPER_ADMIN_PASSWORD` | 超管登录密码（**未设置则服务拒绝启动**） |
| `SECRET_ENCRYPTION_KEY` | 32 字节主密钥，见下 |

生成主密钥：

```bash
openssl rand -hex 32
```

> 🔐 该密钥用于加密存储 Agora App Certificate 与 Customer Secret。
> **务必备份**：丢失后库中已存的凭证将无法解密。
> 它只在首次运行时需要；一旦库中已有密文，缺失该变量会导致启动失败（这是刻意的，避免带着读不出凭证的状态继续运行）。

---

## 2. 本地构建产物

镜像内**不编译**源码，只装载构建好的 `dist`。

```bash
npm install
npm run build          # = build:web + build:server
```

产物：`server/dist/`、`web/dist/`。

---

## 3. 上传到服务器并启动

把以下内容上传到服务器同一目录：

```
Dockerfile
docker-compose.yml
deploy/Caddyfile
package.json
package-lock.json
server/package.json
web/package.json
server/dist/
web/dist/
.env                   # 不要提交到仓库
```

启动：

```bash
docker compose build --pull
docker compose up -d
```

查看状态（两个服务都应为 healthy）：

```bash
docker compose ps
docker compose logs -f
```

### 用 deploy.sh 一键部署

在项目根目录执行（本地构建 → 打包 dist → 上传 → 远端重建容器 → 等待健康）：

```bash
SSH_HOST=user@your-server ./deploy.sh
# 或把主机作为第一个参数
./deploy.sh user@your-server
```

部署目标**没有内置默认值**，`SSH_HOST` 必填；若缺失，脚本会在本地构建之前就报错退出。
可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SSH_HOST` | 无（必填） | 目标主机，也可以是 `~/.ssh/config` 里的 Host 别名 |
| `SSH_PORT` | 沿用 ssh 默认 | 非标准 SSH 端口时指定 |
| `REMOTE_DIR` | `/root/clsnbcast` | 远端部署目录 |
| `SERVICE` | `clsnbcast` | compose 服务名 |
| `HEALTH_TIMEOUT` | `120` | 等待变为 healthy 的秒数 |

远端 `.env` 必须事先存在（脚本会在远端校验，缺失即中止），`.env` 与数据卷都不会被覆盖。

> **Windows 用户**：部署脚本与它打包上传的文件通过 `.gitattributes` 固定为 LF 行尾。
> 不要在开启 `core.autocrlf` 的情况下绕过该配置改动 `deploy.sh` —— 脚本第 4 步会把一段
> 脚本经 ssh 交给远端 Linux bash，CRLF 会让远端的每一行都因尾随 `\r` 而解析失败。
> 若已出现该问题，在 WSL 或 Linux 下执行部署即可。

---

## 4. 初始化配置

1. 访问 `https://<你的域名>/super`，用 `SUPER_ADMIN_PASSWORD` 登录
2. 「全局配置」：填写 KOOK Bot Token、Verify Token、Encrypt Key、公网域名
3. KOOK 开发者后台：连接模式设为 **WebHook**，Callback URL 填超管页面显示的地址
   （**必须保留 `?compress=0`**），并填写相同的 Encrypt Key
4. 邀请机器人进服务器，随后按页面提示绑定服务器管理面板

### Agora 凭证（多租户）

凭证不再填在服务器配置里，而在**「Agora 凭证池」**中管理：

- `platform` = 我们自己的账号，作为全局默认池
- `space` = 某个 KOOK 服务器自带凭证
- `user` = 用户自带凭证（BYOK）

App Certificate 加密存储，**任何接口都不会返回明文**；需要轮换时重新填写即可。

会话创建时会固定绑定一个 Provider，并在会话上记录 App ID 快照。
若之后改动了 Provider 的 App ID，进行中的会话会明确报错要求重新发起，
而不会被静默发到另一个声网项目。

---

## 5. 数据与备份

SQLite 数据库位于命名卷 `clsnbcast-data` 的 `/app/data/clsnbcast.db`。

备份：

```bash
docker run --rm \
  -v clsnbcast-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/clsnbcast-data-$(date +%F).tar.gz -C /data .

# 恢复
docker run --rm \
  -v clsnbcast-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/clsnbcast-data-YYYY-MM-DD.tar.gz -C /data
```

> 备份时建议先 `docker compose stop clsnbcast`，或使用 SQLite 的 `.backup` 命令以获得一致性快照。
> 备份里包含加密后的凭证，**同时需要 `SECRET_ENCRYPTION_KEY` 才能恢复使用**。

---

## 6. 升级

```bash
# 拉取上游更新后重新构建 dist
npm install && npm run build
# 上传 dist 与必要的配置文件
docker compose build --pull
docker compose up -d
```

数据库迁移由应用启动时自动执行（见 `schema_migrations` 表）。**升级前请备份数据卷。**

---

## 7. 运维命令

```bash
docker compose ps            # 状态与健康检查
docker compose logs -f       # 日志
docker compose restart       # 重启
docker compose down          # 停止（保留数据卷）
docker compose down -v       # 停止并删除数据卷（⚠️ 会丢数据）
```

---

## 备选：使用已有的 Nginx

如果你已有 Nginx 负责 TLS，可以只运行应用容器，并把 Nginx 指到它。此时：

1. 在 `docker-compose.yml` 中给 `clsnbcast` 加回端口映射：

   ```yaml
   ports:
     - "127.0.0.1:${PORT:-3520}:3520"
   ```

2. 删除（或不启动）`caddy` 服务。

3. Nginx 参考配置：

   ```nginx
   server {
       listen 443 ssl http2;
       server_name share.example.com;

       # ssl_certificate / ssl_certificate_key ...

       location / {
           proxy_pass http://127.0.0.1:3520;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;

           proxy_http_version 1.1;

           # SSE 支持（必须关闭缓冲）
           proxy_buffering off;
           proxy_cache off;
           proxy_read_timeout 86400s;
           proxy_send_timeout 86400s;
       }

       client_max_body_size 2m;
   }
   ```

> 应用只信任**一跳**代理（`trust proxy = 1`）。若 Nginx 外层还有 CDN 或多层代理，
> 需要相应调整；否则按 IP 的登录限流会失效。

---

## 环境变量一览

见 [.env.example](./.env.example)。运行时读取的变量：

| 变量 | 必填 | 说明 |
|---|---|---|
| `SUPER_ADMIN_PASSWORD` | ✅ | 超管密码，同时作为超管 token 的 HMAC 密钥 |
| `SECRET_ENCRYPTION_KEY` | 建议 | 秘密加密主密钥（32 字节 hex/base64） |
| `DOMAIN` | 部署时 | Caddy 对外域名 |
| `PORT` | | 应用监听端口，默认 3520 |
| `ALLOWED_ORIGINS` | | CORS 额外域名，逗号分隔 |
| `KOOK_BOT_TOKEN` | | 首次启动时播种到数据库 |
| `KOOK_API_TIMEOUT_MS` | | KOOK HTTP 超时，默认 10000 |
| `DATA_DIR` | | 数据目录，默认 `<工作目录>/data` |
| `TRUST_PROXY` | | 设为 `false` 可关闭 `trust proxy`（仅在直接暴露应用时） |

> 任何秘密都**不会**出现在前端 bundle 中，也不会写入日志（进程级日志脱敏）。
