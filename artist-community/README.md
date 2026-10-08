# 云音发现｜独立音乐人作品发现 Web

在 `artist-community/` 目录运行的独立 Web 服务，**不会更改主仓库的网易云 API 路由**。目标是用户主动发现歌曲，而非以自动播放操纵网易云数据。

## 已实现（阶段三）

- 本站邮箱账号注册/登录，`scrypt` 密码哈希、数据库中的会话哈希。
- **邮件验证**：新账号收到 24 小时内有效的单次验证链接；未验证邮箱不能创建音乐人档案或投稿作品。
- **密码找回**：30 分钟单次密码重置链接；重置后撤销该用户全部登录会话；对未知邮箱提供统一回复。
- 网易云公开音乐人主页声明、临时证明码、管理员人工核实。
- 歌曲投稿与审核、响应式用户端和 [可视化审核后台](/admin)（输入管理员密钥，不保存在 localStorage）。
- PostgreSQL 存储、官方作品链接、站内账号访问去重、优先低曝光未访问作品的推荐。
- `GET /api/official/metrics`：**官方授权数据源扩展点**，默认仅返回 `officialValidPlays: null` 和 `officialTaskStatus: "unavailable"`；未接入任何未经授权的数据接口。
- 生产 Docker Compose（PostgreSQL + Node.js + Caddy 自动 HTTPS）、手动备份校验脚本、独立 CI 测试。

**数据边界**：站内账号访问不代表真实播放、不等于不同自然人，也不等于网易云官方有效播放或会员领取任务达标。

## 本地运行

需要 Node.js 20+、Docker 与 Compose、npm。使用当前目录相对于仓库根目录的命令：

```bash
export POSTGRES_PASSWORD='use-a-strong-db-password'
docker compose -f artist-community/docker-compose.yml up -d
cd artist-community
npm install
export DATABASE_URL='postgres://community:use-a-strong-db-password@127.0.0.1:5432/artist_community'
export ARTIST_COMMUNITY_ADMIN_TOKEN="$(openssl rand -hex 32)"
export PUBLIC_BASE_URL='http://127.0.0.1:3100'
export MAIL_MODE=console
npm start
```

访问 http://127.0.0.1:3100；审核界面为 http://127.0.0.1:3100/admin 。

`MAIL_MODE=console` 会在**本地终端**打印验证和重置链接，**仅可在受控开发环境使用，不能用于真实用户或生产**。正式 SMTP 环境请设置 `MAIL_HOST`、`MAIL_PORT`、`MAIL_SECURE`、`MAIL_USER`、`MAIL_PASSWORD`、`MAIL_FROM`（见 `.env.example`）。程序不会自动加载 `.env`。

首次连接 PostgreSQL 时执行 `schema.sql` 幂等建表/扩列。旧数据仍保留；新增列 `email_verified_at` 默认为空，旧账号需要补做邮箱确认。

## 使用与人工审核流程

1. 先注册平台邮箱账号，点邮件链接，点击页面确认验证，再登录。
2. 提交网易云音乐人公开主页（例如 `https://music.163.com/artist?id=123`），复制 `DISCOVERY-...` 证明码至该主页简介。
3. 管理员访问 `/admin`，粘贴服务端提供的 `ARTIST_COMMUNITY_ADMIN_TOKEN`，加载队列，打开公开主页核对证明码后批准。
4. 音乐人提交歌曲后，管理员继续人工核对作品归属并批准；歌曲才对其他用户可见。
5. 登录用户访问作品链接可以形成一次**站内账号访问记录**，推荐页将逐渐排除已看过的歌曲。

管理员页面不属于网易云官方后台，认证仅表示本站的人工核查；不应仅根据一个容易被复制的名称批准。

## 正式服务器部署模板（尚未实际上线）

准备 Linux 主机、指向该主机公网 IP 的域名、已放行的 TCP 80/443（HTTP/HTTPS）和 UDP 443（HTTP/3），以及有效 SMTP 凭证：

```bash
cd artist-community
cp .env.production.example .env.production
chmod 600 .env.production
# 编辑 .env.production，填写随机数据库密码、管理员令牌、域名、SMTP 凭证
# 注意：DATABASE_URL 中的密码需要进行 URL 百分号编码
# 用 caddy hash-password 生成 ADMIN_BASIC_HASH；含 $ 的哈希建议使用单引号包住整值
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'choose-a-separate-admin-password'
docker compose --env-file .env.production -f docker-compose.prod.yml config --quiet
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

Caddy 自动申请、续期 TLS 证书，普通站点通过域名访问，`/admin` 和 `/api/admin/*` 另受 HTTP Basic Auth 保护。可视化管理后台还要求独立的 Bearer 管理密钥，不要共享或提交到 Git。生产模式会启用 Secure Cookie，并要求 `PUBLIC_BASE_URL` 是 HTTPS。

**这里提供的是部署配置，没有实际连接你的服务器、DNS 或 SMTP 服务，也没有公网发布。**

## PostgreSQL 备份与恢复

生产脚本 `backup.sh` 使用 Compose 内 PostgreSQL 容器进行 `pg_dump -Fc`，再通过同一容器的 `pg_restore --list` 检查归档格式成功后才保留文件。选用 Docker 卷之外的**长期保存目录**：

```bash
cd artist-community
BACKUP_DIR=/srv/backups/artist-community bash backup.sh
# 可选：BACKUP_RETENTION_DAYS=14 启用目录内的到期备份清理
```

该脚本**不会自行定时执行**。可由你在服务器中设置 cron/systemd timer 每天运行，并将备份再加密复制到异地存储。保持目录仅管理员可读。

恢复前务必先在测试环境完成恢复演练，停止应用写入并确认选中正确数据库。示例（`RESTORE_BACKUP` 指向已验证的备份）：

```bash
cd artist-community
export RESTORE_BACKUP=/srv/backups/artist-community/artist-community-YYYYMMDDTHHMMSSZ.dump
docker compose --env-file .env.production -f docker-compose.prod.yml stop app
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T db \
  pg_restore -U community -d artist_community --clean --if-exists --no-owner --no-acl \
  < "$RESTORE_BACKUP"
docker compose --env-file .env.production -f docker-compose.prod.yml start app
```

`--clean` **会覆盖目标数据库对象**；不要直接在唯一的生产数据库中尝试恢复，应先验证备份、保留完整副本并安排维护窗口。备份验证归档格式不等于恢复演练。

## 检查

```bash
cd artist-community
npm test
```

离线 HTTP / 前端语法测试可以不需要数据库；设置 `DATABASE_URL` 时运行 PostgreSQL 集成测试。独立 CI 文件：`.github/workflows/artist-community-ci.yml`。

## 技术限制与上线前工作

- 邮件发出依赖有效 SMTP 服务和 SPF/DKIM/DMARC；不能保证所有邮件被投递。
- 当前限制登录/重置频率的计数器为**单 Node 进程内存**，多副本生产部署前应升级 Redis 限流并增加验证码。
- 需要增加账号注销与数据删除、举报/撤回、邮箱修改验证、审核撤销、审计员角色及操作证据、版本化迁移和备份恢复演练。
- 当前身份验证只核对公开证明码，不是网易云授权登录。
- 官方任务数据接入必须先获得合法授权，并独立取得音乐人的数据读取授权；不能假设第三方逆向接口就等同官方授权。

## 第一阶段 JSON 数据迁移

旧 `.artist-community-data.json` 不会被覆盖，也不会自动导入 PostgreSQL。匿名作品无法确认归属，应在所有权验证后由账号持有人重新提交；旧匿名浏览量不可直接视为新登录用户访问量。
