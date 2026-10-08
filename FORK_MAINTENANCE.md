# Zerlinpi Fork 维护与音乐人社区开发指南

本仓库为 [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) 的 **Fork**，并不是上游仓库的官方新版本。

## 仓库边界

- **`zerlinpi/api-enhanced/main`**：你的主分支，包含 `artist-community/` 私有定制功能。
- **`NeteaseCloudMusicApiEnhanced/api-enhanced/main`**：上游 API 代码，只作为更新来源，不接收你的社区业务改动。
- **`sync/upstream-proposal`**：自动更新时创建的**待审核分支**。上游不会再直接写入你的 `main`。
- **`artist-community/`**：独立音乐人作品发现 Web 服务，使用独立的 `package.json` 和数据库；不可把它当成上游 API 的路由文件。

## 获取上游更新

Fork 默认分支上的 `.github/workflows/sync.yml` 每天检查上游，也可以在 GitHub Actions 里手动执行。它将：

1. 从上游读取 `main` 并尝试在临时分支合并。
2. 如果上游已经包含在 Fork 历史中，不进行改动。
3. 如果可以自动合并，仅更新 `sync/upstream-proposal`，并创建或更新 PR，**不会自动合并到主分支**。
4. 如果 Git 合并冲突，动作会失败并保留 `main` 不变。需由维护者在专门分支手动解决冲突。

**GitHub 设置要求：** Settings → Actions → General → Workflow permissions 中需允许 GitHub Actions 创建 Pull requests；否则 Actions 可能成功推送提案分支但无法自动创建 PR。在这种情况下请从 `sync/upstream-proposal` 手动创建 PR。

使用默认 GitHub `GITHUB_TOKEN` 推送的同步提案，可能不会自动触发其它 PR 工作流；**必须主动检查比较结果并通过 CI 后才人工合并**。必要时由维护者重新触发验证工作流。

## 本地同步指令

```bash
git clone https://github.com/zerlinpi/api-enhanced.git
cd api-enhanced
git remote add upstream https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced.git
git fetch origin main
git fetch upstream main

# 永远在独立分支审阅；不要直接把上游 main 强制推到你的 main。
git switch -c chore/review-upstream origin/main
git merge --no-ff upstream/main
# 检查差异并运行测试后，推送此分支，向 zerlinpi/main 提 PR。
```

特别检查 `.github/workflows/`、`package.json`、`artist-community/` 是否受到影响。若出现冲突，不要使用 `git reset --hard upstream/main` 覆盖你的定制代码。

## 继承的上游发布工作流

`.github/workflows/release-on-version-change.yml` 原先尝试发布到上游 npm 包名、Docker Hub 和 GHCR 地址。**在 Fork 上已添加上游仓库身份检查，不允许执行这些发布任务。** 要发布自己的 API 软件包，应独立制定新的包名和镜像地址（例如 `ghcr.io/zerlinpi/...`），并获得自己的发布凭证，不要复用上游品牌或发布令牌。

`.github/workflows/opencode.yml` 的外部 AI Bot 配置只属于上游。在 Fork 上此 Job 已禁用；不能因为有人评论 `/oc` 就加载上游第三方配置或执行代码。

`.github/workflows/build-dev.yml` 仅在主 API 核心代码变更时自动打包，避免音乐人社区文档或页面更新反复触发跨平台编译。

## 社区部署与正式上线

请看 [artist-community/DEPLOYMENT.md](artist-community/DEPLOYMENT.md)。部署工作流 `Deploy Artist Community` 仅能手动从你自己的 `main` 执行，必须配置专用服务器 SSH 凭证，并通过 `production` Environment 的保护规则。

**网易云官方授权登录尚未接通；用户可通过本站注册、访问网易云官方作品页面自主收听，但本站不托管网易云登录态、不代用户挂机播放，也不能保证播放被网易云判为有效播放。**

## 测试

```bash
cd artist-community
npm install
npm test
```

`artist-community/fork-workflows.test.js` 将检查三个重要防回归条件：不直接同步上游到主分支；Fork 不运行上游发布或 AI Bot；社区修改不触发主 API 平台打包。设置 `DATABASE_URL` 后还会运行数据库集成测试。
