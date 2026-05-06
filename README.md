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

### WebSocket 模式（可选）

当 `connectionMode="websocket"` 时，插件会动态 `import("@baidu/infoflow-sdk-nodejs")`。
该依赖在 `peerDependencies` 中标记为 optional：不使用 websocket 模式时无需安装。

