## OpenClaw Infoflow 插件（适配 OpenClaw 2026.5.4）

这是一个 OpenClaw Channel Plugin，用于对接百度如流（Infoflow）消息平台。

### 目录结构

- `index.ts`: OpenClaw 插件入口（注册 channel + webhook 路由）
- `openclaw.plugin.json`: 插件 manifest（包含 `channelConfigs`，用于配置 schema/setup surfaces）
- `src/channel.ts`: ChannelPlugin 实现（account/config/security/groups/outbound/actions）
- `src/actions.ts`: message tool 的动作适配（send/delete 等）
- `src/monitor.ts`: webhook 入口与 account monitor（webhook / websocket 两种接收模式）
- `src/ws-receiver.ts`: WebSocket 接收器（动态加载 `@baidu/infoflow-sdk-nodejs`）

### 构建与测试

```bash
npm install
npm run typecheck
npm run test
npm run build
```

OpenClaw 运行时会加载编译产物 `dist/index.js`（由 `tsconfig.build.json` 输出到 `dist/`）。

### 本地部署到 OpenClaw

仓库内置一键部署脚本，会把插件同步到 `~/.openclaw/extensions/infoflow`，并确保 build 完成后重启 gateway：

```bash
bash scripts/deploy.sh
```

当配置里检测到 `connectionMode=websocket`（包含账号级配置）时，脚本会自动安装 `@baidu/infoflow-sdk-nodejs`。
默认私有源为 `http://registry.npm.baidu-int.com`，也可通过环境变量覆盖：

```bash
BAIDU_NPM_REGISTRY=http://registry.npm.baidu-int.com bash scripts/deploy.sh
```

### 首次安装（推荐命令）

下面的安装命令块由 `npm run sync-readme-install-version` 自动维护，版本号始终与 npm 上当前的 `latest` / `beta` dist-tag 保持一致，请直接复制使用。

#### 方式 A：通过独立 tools 包安装并部署（推荐，支持 `update` 子命令）

正式版（`latest` dist-tag）：

<!-- sync:infoflow-plugin-version:latest -->
```bash
npm cache clean --force
npx -y --prefer-online @chbo297/infoflow-openclaw-tools update \
  --version 2026.5.8 --registry https://registry.npmjs.org
```
<!-- /sync:infoflow-plugin-version:latest -->

Beta 版（`beta` dist-tag，按需）：

<!-- sync:infoflow-plugin-version:beta -->
```bash
npm cache clean --force
npx -y --prefer-online @chbo297/infoflow-openclaw-tools@beta update \
  --version 2026.5.9-beta.1 --registry https://registry.npmjs.org
```
<!-- /sync:infoflow-plugin-version:beta -->

> 加上 `npm cache clean --force` 和 `--prefer-online`，可避免本机 npm metadata 缓存尚未刷新而看不到刚发布版本（典型表现为 `ETARGET: No matching version found`）。

#### 方式 B：通过 OpenClaw 插件命令安装

正式版：

<!-- sync:infoflow-plugin-version:latest -->
```bash
openclaw plugins install @chbo297/infoflow@2026.5.8
```
<!-- /sync:infoflow-plugin-version:latest -->

Beta 版：

<!-- sync:infoflow-plugin-version:beta -->
```bash
openclaw plugins install @chbo297/infoflow@2026.5.9-beta.1
```
<!-- /sync:infoflow-plugin-version:beta -->

安装后建议检查插件状态：

```bash
openclaw plugins list
openclaw plugins inspect infoflow
```

#### 如遇 `ETARGET: No matching version found`

刚发布的版本可能在本机 npm metadata 缓存里看不到，按下面顺序排查：

```bash
# 1) 强制清缓存 + 在线拉取最新元数据
npm cache clean --force
npx -y --prefer-online @chbo297/infoflow-openclaw-tools@beta update \
  --version <要装的版本> --registry https://registry.npmjs.org

# 2) 直接查 registry，确认版本确实可见
npm view @chbo297/infoflow versions --registry https://registry.npmjs.org

# 3) 确认默认 registry 未被改到镜像源（有些内网会重写到 cnpm/baidu 镜像，那里同步可能滞后）
npm config get registry            # 期望: https://registry.npmjs.org/
# 临时强制覆盖（不改全局配置）：
npm_config_registry=https://registry.npmjs.org \
  npx -y --prefer-online @chbo297/infoflow-openclaw-tools@beta update \
  --version <要装的版本> --registry https://registry.npmjs.org

# 4) 直接 curl 验证那台机器能否拿到 manifest
curl -sI https://registry.npmjs.org/@chbo297/infoflow | head -5
curl -s https://registry.npmjs.org/@chbo297/infoflow/<要装的版本> | head -50
```

### tools 包的常用参数

- `--version <version>`: 指定安装版本（默认 `latest`）
- `--registry <url>`: 插件包下载源（默认 `https://registry.npmjs.org`）
- `--baidu-registry <url>`: `@baidu/infoflow-sdk-nodejs` 下载源（默认读取 `npm_config_registry`，否则回退 `http://registry.npm.baidu-int.com`）
- `--channel-id <id>`: 目标插件目录名（默认 `infoflow`，安装到 `~/.openclaw/extensions/<id>`）
- `--dry-run`: 仅打印命令，不写入系统

说明：

- `npx ... update` 与 `bash scripts/deploy.sh` 复用同一套部署核心逻辑（依赖安装、websocket 依赖校验、构建、配置写入、按状态重启 gateway）。
- 如果 gateway 未运行，脚本会跳过重启，仅完成插件安装与构建。
- 插件包 `@chbo297/infoflow` 不再内置 `child_process` CLI，避免被 `openclaw plugins install` 的危险代码检测拦截。

### WebSocket 模式（可选）

当 `connectionMode="websocket"` 时，插件会动态 `import("@baidu/infoflow-sdk-nodejs")`。
该依赖在 `peerDependencies` 中标记为 optional：不使用 websocket 模式时无需安装。

### 版本升级、打 tag、推送与 npm 发布流程

每次发布新版本时，先把 `package.json` 的 `version` 设为待发版本号，再按下面顺序执行。`sync` 脚本会：

- 把"发版流程"代码块内的版本号、`git tag`、`git commit -m` 等同步成当前 `package.json` 的版本（"current" stream）；
- 同时把上文"首次安装"段落里 `:latest` / `:beta` 两个 stream 的标记区按 npm 上的 dist-tag 刷新——若当前正在发的是 stable 版本，`:latest` 标记区会同步写成新版本号；若是 prerelease，`:beta` 标记区会同步写成新版本号。

<!-- sync:infoflow-plugin-version -->
```bash
# 1) 修改版本号（会同步 package-lock.json）
npm version 2026.5.9-beta.1 --no-git-tag-version

# 2) 同步 README：current/latest/beta 三个标记区一起刷新（latest/beta 会从 npm 拉真实 dist-tag）
npm run sync-readme-install-version

# 3) 编辑 CHANGELOG.md 顶部，添加本版本章节

# 4) 发布前校验
npm run typecheck
npm run test
npm run build

# 5) 提交版本变更
git add package.json package-lock.json README.md CHANGELOG.md scripts src
git commit -m "2026.5.9-beta.1"

# 6) 打 tag 并推送代码与 tag
git tag 2026.5.9-beta.1
git push origin main
git push origin 2026.5.9-beta.1

# 7) 发布到 npm
#    - Beta 预发（不占用 latest dist-tag）：
npm publish --tag beta --registry https://registry.npmjs.org
#    - 正式版（同时占用 latest）：
# npm publish --registry https://registry.npmjs.org

# 8) 发布成功后再跑一次 sync，把 README 的 :latest / :beta 标记区刷新到 npm 最新 dist-tag，并提交
npm run sync-readme-install-version
git add README.md && git commit -m "docs: refresh README install commands" || true
git push origin main || true
```
<!-- /sync:infoflow-plugin-version -->

