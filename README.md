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

### 通过 npx 一键更新安装

发布到 npm 后，可直接通过 `npx` 安装/升级到指定版本：

```bash
npm_config_registry=http://registry.npm.baidu-int.com npx -y @chbo297/infoflow update --version 2026.5.5
```

常用参数：

- `--version <version>`: 指定安装版本（默认 `latest`）
- `--registry <url>`: 指定 npm 源（默认读取 `npm_config_registry`，否则回退 `http://registry.npm.baidu-int.com`）
- `--channel-id <id>`: 目标插件目录名（默认 `infoflow`，安装到 `~/.openclaw/extensions/<id>`）
- `--dry-run`: 仅打印命令，不写入系统

说明：

- `npx ... update` 与 `bash scripts/deploy.sh` 复用同一套部署核心逻辑（依赖安装、websocket 依赖校验、构建、配置写入、按状态重启 gateway）。
- 如果 gateway 未运行，脚本会跳过重启，仅完成插件安装与构建。

### WebSocket 模式（可选）

当 `connectionMode="websocket"` 时，插件会动态 `import("@baidu/infoflow-sdk-nodejs")`。
该依赖在 `peerDependencies` 中标记为 optional：不使用 websocket 模式时无需安装。

### 版本升级、打 tag、推送与 npm 发布流程

每次发布新版本（例如 `2026.5.5`）建议按以下顺序执行：

```bash
# 1) 修改版本号（会同步 package-lock.json）
npm version 2026.5.5 --no-git-tag-version

# 2) 发布前校验
npm run typecheck
npm run test
npm run build

# 3) 提交版本变更
git add package.json package-lock.json README.md scripts src
git commit -m "2026.5.5"

# 4) 打 tag 并推送代码与 tag
git tag 2026.5.5
git push origin main
git push origin 2026.5.5

# 5) 发布 npm（可按需指定 registry）
npm publish
# 或
# npm publish --registry https://registry.npmjs.org
```