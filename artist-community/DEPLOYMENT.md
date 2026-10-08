# 服务器部署手册 · 音乐人作品发现平台

本指南针对 Ubuntu/Debian Linux + Docker Compose。**截至本提交，没有实际连接用户服务器或上线域名**。切勿把 SSH 私钥、网易云账号 Cookie、SMTP 密码或数据库密码提交到 GitHub。

## 0. 重要功能边界

- 当前登录：本网站的邮箱登录及验证。
- 网易云登录：**尚未接入**。应先向 [网易云音乐开发者平台](https://developer.music.163.com/st/developer/) 申请项目、第三方授权登录权限，并取得实际可用的合作接口文档。网易云官方 `ncm-cli` 可以在开发者授权范围内扫码登录，但不能推定任意 Web 网站都有相同权限。
- 作品收听：用户自主打开网易云音乐官网/App 中的音乐作品，可在网易云官方客户端使用其正常的后台播放能力。本服务器不会代为登录、下载音频、模拟收听或上报虚假播放事件。
- 本站的点击记录不等于网易云认可的有效播放或独立真实听众。

## 1. 一台服务器的最少准备

需要可以用 SSH 登录的 Linux 主机、已安装 Docker Engine + Compose V2、Git 和一个指向服务器的域名。建议先在测试环境验证。

域名例子：`music.example.net`，**只作为示意，不是已部署地址**。

如果该服务器上已有 Nextcloud、WordPress、Nginx、Apache 或 Caddy，并正在占用 80/443 端口，选择下文的 `PROXY_MODE=external`。**不要停止或覆盖现有站点**。

新机器没有反向代理时可以使用 `PROXY_MODE=bundled`：容器内的 Caddy 占用 80/443 并尝试签发 HTTPS 证书，需要公网 DNS 指向主机并放行端口。

## 2. 首次准备运行目录

```bash
mkdir -p ~/apps/artist-platform/artist-community
# 在本地 checkout 此仓库的合并后 main，复制 artist-community/* 到此目录。
# 也可等待下文的 GitHub Actions 将已合并的代码推送到此目录。
cd ~/apps/artist-platform/artist-community
cp .env.production.example .env.production
chmod 600 .env.production
```

编辑 `.env.production` 并替换每一项示例值：

- `SITE_DOMAIN`，`PUBLIC_BASE_URL=https://你的域名`
- `POSTGRES_PASSWORD`，`DATABASE_URL`（数据库 URL 内的密码需要 percent-encoding）
- `ARTIST_COMMUNITY_ADMIN_TOKEN`：可用 `openssl rand -hex 32` 生成
- `MAIL_*`：真实 SMTP 邮箱与应用密码
- `ADMIN_BASIC_USER`，`ADMIN_BASIC_HASH`：仅内置 Caddy 模式使用的后台额外认证
- `PROXY_MODE=bundled` 或 `PROXY_MODE=external`

生成 Caddy 密码哈希：

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext '独立且足够长的管理员密码'
```

`ADMIN_BASIC_HASH` 的 bcrypt 字符串含有 `$`，请在 Compose env 文件中按其语法转义 `$`（通常每个 `$` 用 `$$`），并使用预检命令校验实际解析结果，不要把原始哈希写进代码库。

## 3. 启动

```bash
cd ~/apps/artist-platform/artist-community
bash deploy/preflight.sh
bash deploy/compose.sh up -d --build
bash deploy/compose.sh ps
```

检查容器内数据库连通性：

```bash
bash deploy/compose.sh exec -T app node -e "fetch('http://127.0.0.1:3100/api/health/ready').then(r => r.json()).then(console.log)"
```

应返回 `{"ready":true}` 才算内部就绪。再从外部访问 `https://你的域名/api/health/ready` 确认代理与 TLS。

### 有现成反向代理：PROXY_MODE=external

该模式使用 `docker-compose.external-proxy.yml`：

- 不启动 bundled Caddy 容器
- 仅将 Node 服务映射在服务器 `127.0.0.1:3100`
- PostgreSQL 仍然不对公网开放
- 你的现有 Nginx/Caddy/Apache 负责新的 `music.你的域名` 的 HTTPS 证书、转发和管理后台访问控制

现有代理需要将站点转发至 `http://127.0.0.1:3100`，保留 `Host` 请求头和正确 HTTPS；`/admin` 与 `/api/admin/*` 应由代理再加一层管理访问认证/网络白名单。

**多用户限流的重要设置：** 生产 Compose 会设 `ARTIST_COMMUNITY_TRUST_PROXY=true`，使 Node 根据代理转发的真实 IP 区分不同用户。可信反向代理**必须覆盖客户端提交的** `X-Forwarded-For`，否则恶意用户可以伪造来源 IP 绕过登录限流。内置 Caddy 已显式覆盖该请求头。

若现有代理使用 Nginx，请在新站点的 `location /` 反向代理配置中至少包含：

```nginx
proxy_pass http://127.0.0.1:3100;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto https;
```

这里使用 `$remote_addr` 而不是未经核验的客户端 `X-Forwarded-For` 链。如果还有 CDN 或多层代理，应先正确设置信任的上游地址与真实 IP 解析规则，再转发可信地址；**不要把 Node 3100 端口直接开放公网**。


**如果现有代理自身也在容器中，容器内的 127.0.0.1 通常不是宿主机**。须通过宿主机网关或共享 Docker 网络连接，具体取决于原代理部署方式，不能直接假定互通。

## 4. GitHub Actions 手动部署（合并 main 后）

工作流 `.github/workflows/artist-community-deploy.yml` 只允许对 `main` 执行，且需输入 `DEPLOY`，并使用受保护的 `production` Environment。请先审核并合并 PR #1，之后在 GitHub **Settings → Environments** 创建 `production`，设置审批规则，再在环境 Secrets 配置：

| 名称 | 内容 |
|---|---|
| `ARTIST_DEPLOY_SSH_HOST` | 服务器公网域名或 IP |
| `ARTIST_DEPLOY_USER` | 有权限执行 Docker 的独立部署用户 |
| `ARTIST_DEPLOY_SSH_KEY` | GitHub Actions 使用的 SSH 私钥（独立专用） |
| `ARTIST_DEPLOY_KNOWN_HOSTS` | **核验过指纹**的 SSH 主机公钥记录 |

在服务器端将匹配的部署公钥添加至该用户的 `~/.ssh/authorized_keys`，不要上传服务器的 SSH 私钥。部署用户需要 Docker 权限，而加入 `docker` 组基本等同 root 权限，因此仅授权专用可信用户。

第一次部署前**手动在服务器放置** `.env.production`，工作流不会生成、读取回 GitHub 或覆盖该文件。

操作：GitHub → Actions → **Deploy Artist Community** → Run workflow → 选择 `main` → 在确认字段输入 `DEPLOY`。工作流上传应用文件、执行预检，对已有数据库先备份，重建容器，再执行应用就绪检测。

GitHub Actions **不会**申请网易云开发者权限、配置你的 DNS/SMTP，也不会自动处理已有代理的路由。

## 5. 备份和恢复

首发后应安排备份到 Docker 数据卷**之外**的磁盘位置：

```bash
cd ~/apps/artist-platform/artist-community
BACKUP_DIR="$HOME/backups/artist-community" bash backup.sh
```

该脚本做 PostgreSQL `pg_dump` 并校验归档结构，**没有自动定时**。建议另行使用服务器上的 systemd timer/cron 每天执行，异地加密留存，定期演练恢复。恢复命令及风险说明见 [README](README.md)。

## 6. 验收和运维

- 公开首页（HTTPS）能加载；普通浏览者不被要求提供网易云密码或 Cookie
- 网站注册和邮箱验证：用户收到 SMTP 邮件、单次验证有效，重复令牌不能再使用
- 后台登录：`/admin` 只有管理员能进入，审核队列操作正常
- `/api/health/ready` 返回 `ready: true`
- `/api/auth/providers` 明确显示网易云授权登录 **不可用**（待取得正式权限）
- 普通用户可通过网易云官方页面自主打开歌曲，站内不播放机器人、不混淆官方有效播放指标
- 备份生成归档、恢复演练能够在隔离环境成功

## 7. 获取网易云第三方授权后的工作

依次取得：应用开发者资格、第三方用户授权方式的正式文档与访问权限、`appId`/签名私钥、明确的回调域名白名单、用户身份声明字段和用户数据授权范围。对接时需要带 `state`、短期单次授权码、严格回调地址校验和用户主动授权；持久化 token 需加密并支持撤销。正式 SDK、协议流程、播放许可均要经过真实测试才能宣布“支持网易云账号直接登录”。

**即使完成官方登录授权，也不代表允许服务器代替用户挂机播放或互相刷量。**
