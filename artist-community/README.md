# 云音发现｜音乐人作品发现社区（独立应用）

这是本仓库中的 **独立 Web 项目**，与原有网易云音乐 API 服务器解耦。只提供真实的作品发现、音乐人投稿和人工审核，不模拟网易云播放，不收集第三方登录凭据，也不将站内访问解释成官方有效播放。

## 当前功能（阶段二）

- 本站邮箱/密码注册、登录、退出（scrypt 密码哈希，随机会话，数据库只保存会话 token 的 SHA-256）。
- HttpOnly / SameSite=Lax 会话 Cookie；正式 HTTPS 环境启用 Secure。
- 音乐人提交网易云公开主页 URL；服务生成证明码，待管理员核对简介后批准。**这里只是社区人工身份验证，不代表网易云官方认证。**
- 已绑定音乐人可以投稿网易云歌曲；默认 `pending`，需管理员审核才能出现在大厅。
- 已登录用户点击歌曲链接时记录**站内账号访问**，同一账号同一歌曲只记录一次；不能证明这些账号是不同自然人，更不能证明网易云有效播放。
- 登录用户专属 `/api/recommendations` 推荐队列：过滤自己的作品和已经点开过的作品，并优先展示站内访问较少的作品；游客看到公开大厅。
- PostgreSQL 数据存储、账号/作品唯一性、外键约束、记录去重和参数化查询。
- 单独的 Node.js + PostgreSQL 集成测试和 GitHub Actions 工作流。

## 环境要求

Node.js 20+、PostgreSQL 16+、npm。无需运行根目录的 `app.js`，不会改动主 API 接口。

### 1. 启动 PostgreSQL

```bash
export POSTGRES_PASSWORD='replace-with-a-long-random-secret'
docker compose -f artist-community/docker-compose.yml up -d
```

默认只向本机 `127.0.0.1:5432` 绑定端口。若已有 PostgreSQL，也可以自行创建数据库和用户。

### 2. 安装依赖并启动社区应用

```bash
cd artist-community
npm install
export DATABASE_URL="postgres://community:replace-with-a-long-random-secret@127.0.0.1:5432/artist_community"
export ARTIST_COMMUNITY_ADMIN_TOKEN="$(openssl rand -hex 32)"
npm start
```

浏览器打开 http://localhost:3100 。配置项见 `.env.example`。**示例文件仅作参考：程序不会自动加载 `.env`，要通过 shell 或进程管理器设置环境变量。**

服务器首次启动时执行 `schema.sql` 创建表；要求连接账号拥有建表权限。后续请引入版本化迁移和权限收敛。

### 3. 人工审核流程

1. 音乐人注册本站账号、提交音乐人主页；本站显示 `DISCOVERY-...` 证明码。
2. 音乐人将证明码**临时放进网易云公开主页简介**。
3. 管理员自行打开该网易云主页，核对数字 ID、名称及简介中的证明码。
4. 管理员在可信终端通过以下接口批准，之后音乐人提交的歌曲仍需单独审核。

```bash
# 手动从页面记录音乐人 UUID 与歌曲 UUID。管理员令牌必须保密。
curl -H "Authorization: Bearer $ARTIST_COMMUNITY_ADMIN_TOKEN" \
  http://127.0.0.1:3100/api/admin/review

curl -X POST -H "Authorization: Bearer $ARTIST_COMMUNITY_ADMIN_TOKEN" \
  -H "X-Community-Request: 1" -H "Content-Type: application/json" \
  -d '{}' http://127.0.0.1:3100/api/admin/profiles/ARTIST_UUID/approve

curl -X POST -H "Authorization: Bearer $ARTIST_COMMUNITY_ADMIN_TOKEN" \
  -H "X-Community-Request: 1" -H "Content-Type: application/json" \
  -d '{}' http://127.0.0.1:3100/api/admin/songs/SONG_UUID/approve
```

管理员访问应限制在内网、VPN 或经过额外身份验证的环境；不要将管理 token 嵌入网页或提交 Git。

## 检查

```bash
cd artist-community
npm test
```

本地未设置 `DATABASE_URL` 时，PostgreSQL 集成测试会自动跳过，其余 HTTP/密码测试不依赖数据库。仓库 CI 会启动专用 PostgreSQL 服务执行所有测试。

## 从第一阶段 JSON 版迁移

第一阶段创建的 `.artist-community-data.json` **不会被覆盖或自动导入**。第二阶段以 PostgreSQL 为唯一数据源，之前的匿名歌曲没有可验证的投稿者所有权，因此不自动赋予任何新账号。请保留原 JSON 作为备份，待作品所有权核验后由音乐人重新提交。不要直接将旧站内访客统计写入新表。

## 生产上线前仍需要

- 邮箱所有权验证、找回密码、禁用/删除账号、隐私告知与数据导出。
- 更强的多实例速率限制（如 Redis）、验证码、防机器人与封禁处理。
- 审核员的单独权限系统、审核证据记录、审计日志和撤销审批。
- 数据库自动备份、备份恢复演练、版本化 schema 迁移、指标监控。
- HTTPS、反向代理和密钥管理；`NODE_ENV=production` 时启用 Secure Cookie，切勿通过纯 HTTP 公网运行。
- 正式授权的数据接入；目前所有网易云官方播放指标一律为 `null/unavailable`。
- 当前“站内账号访问”仅表示有人从本站点过网易云链接，不意味着在网易云已真实完成歌曲播放。

**注意：** 网易云音乐人会员领取条件及官方有效播放判定必须以音乐人中心为准。本项目不提供自动互刷/批量假播放功能。
