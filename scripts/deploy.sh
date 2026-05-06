#!/usr/bin/env bash
# 部署 openclaw-infoflow 插件到本地 OpenClaw 并重启 gateway

set -e

PLUGIN_ID="infoflow"
PLUGIN_DIR="$HOME/.openclaw/extensions/$PLUGIN_ID"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> 同步插件文件到 $PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR"
rsync -av --delete "$PROJECT_DIR/" "$PLUGIN_DIR/" \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude scripts

echo "==> 链接 openclaw peer dependency（build 前确保可解析）"
if [ -n "$OPENCLAW_DIR" ] && [ -d "$OPENCLAW_DIR" ]; then
  OPENCLAW_GLOBAL="$OPENCLAW_DIR"
elif command -v pnpm >/dev/null 2>&1; then
  OPENCLAW_GLOBAL="$(pnpm root -g 2>/dev/null)/openclaw"
else
  OPENCLAW_GLOBAL="$(npm root -g 2>/dev/null)/openclaw"
fi

if [ -d "$OPENCLAW_GLOBAL" ]; then
  mkdir -p "$PLUGIN_DIR/node_modules"
  rm -rf "$PLUGIN_DIR/node_modules/openclaw"
  ln -s "$OPENCLAW_GLOBAL" "$PLUGIN_DIR/node_modules/openclaw"
  echo "  ✓ 已链接 $OPENCLAW_GLOBAL -> $PLUGIN_DIR/node_modules/openclaw"
else
  echo "  ✗ 找不到全局 openclaw 安装，尝试使用 which openclaw 推断..."
  OPENCLAW_BIN="$(which openclaw 2>/dev/null)"
  if [ -n "$OPENCLAW_BIN" ]; then
    # pnpm global shim (macOS): extract the openclaw.mjs path from the shim.
    OPENCLAW_SHIM_BASEDIR="$(cd "$(dirname "$OPENCLAW_BIN")" && pwd)"
    OPENCLAW_MJS_REL="$(grep -Eo 'global/[^ ]+/\\.pnpm/openclaw@[^ ]+/node_modules/openclaw/openclaw\\.mjs' "$OPENCLAW_BIN" | head -1)"
    if [ -n "$OPENCLAW_MJS_REL" ]; then
      OPENCLAW_MJS_ABS="$OPENCLAW_SHIM_BASEDIR/$OPENCLAW_MJS_REL"
      OPENCLAW_GLOBAL="$(dirname "$OPENCLAW_MJS_ABS")"
    else
      # npm layout fallback
      OPENCLAW_GLOBAL="$(cd "$(dirname "$OPENCLAW_BIN")/.." && pwd)/lib/node_modules/openclaw"
    fi

    if [ -d "$OPENCLAW_GLOBAL" ]; then
      mkdir -p "$PLUGIN_DIR/node_modules"
      rm -rf "$PLUGIN_DIR/node_modules/openclaw"
      ln -s "$OPENCLAW_GLOBAL" "$PLUGIN_DIR/node_modules/openclaw"
      echo "  ✓ 已链接 $OPENCLAW_GLOBAL -> $PLUGIN_DIR/node_modules/openclaw"
    else
      echo "  ✗ 无法找到 openclaw 安装目录，跳过链接（插件可能无法加载/无法编译）"
    fi
  else
    echo "  ✗ openclaw 未安装，跳过链接（插件可能无法加载/无法编译）"
  fi
fi

echo "==> 安装依赖"
cd "$PLUGIN_DIR" && npm install --silent

WEBSOCKET_ENABLED="false"
if [ -f "$CONFIG_FILE" ]; then
  WEBSOCKET_ENABLED="$(node -e "
    const fs = require('fs');
    try {
      const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
      const section = cfg?.channels?.infoflow ?? {};
      const topMode = section?.connectionMode;
      const accounts = section?.accounts && typeof section.accounts === 'object' ? Object.values(section.accounts) : [];
      const accountWebsocket = accounts.some((acc) => acc && typeof acc === 'object' && acc.connectionMode === 'websocket');
      const enabled = topMode === 'websocket' || accountWebsocket;
      process.stdout.write(enabled ? 'true' : 'false');
    } catch {
      process.stdout.write('false');
    }
  ")"
fi

if [ "$WEBSOCKET_ENABLED" = "true" ]; then
  echo "==> 检测到 websocket 模式，确保安装 @baidu/infoflow-sdk-nodejs"
  BAIDU_NPM_REGISTRY="${BAIDU_NPM_REGISTRY:-${NPM_CONFIG_REGISTRY_BAIDU:-http://registry.npm.baidu-int.com}}"

  # 校验方式用 import()（与插件运行时一致）。注意：一些包可能禁止访问 package.json 子路径。
  if node --input-type=module -e "import('@baidu/infoflow-sdk-nodejs').then(()=>process.exit(0)).catch(()=>process.exit(1))"; then
    echo "  ✓ @baidu/infoflow-sdk-nodejs 已可用"
  else
    echo "  - 使用私有源安装: $BAIDU_NPM_REGISTRY"
    # 重要：npm 11 对 peerDependencies + --no-save 的行为在某些场景下不会落盘安装。
    # 这里改为写入部署目录的 optionalDependencies（不会影响仓库，下一次 rsync 会覆盖），确保依赖真的安装到 node_modules。
    npm_config_registry="$BAIDU_NPM_REGISTRY" npm install --save-optional --registry "$BAIDU_NPM_REGISTRY" @baidu/infoflow-sdk-nodejs

    if node --input-type=module -e "import('@baidu/infoflow-sdk-nodejs').then(()=>process.exit(0)).catch(()=>process.exit(1))"; then
      echo "  ✓ 运行时依赖校验通过：@baidu/infoflow-sdk-nodejs"
    else
      echo "  ✗ @baidu/infoflow-sdk-nodejs 仍不可用（websocket 模式必须）。"
      echo "    请确认私有源、网络与鉴权后重试："
      echo "    npm_config_registry=$BAIDU_NPM_REGISTRY npm install --save-optional --registry $BAIDU_NPM_REGISTRY @baidu/infoflow-sdk-nodejs"
      exit 1
    fi
  fi
else
  echo "==> 当前非 websocket 模式，跳过 @baidu/infoflow-sdk-nodejs 安装"
fi

echo "==> 构建插件（确保 build 完成）"
cd "$PLUGIN_DIR"

# 1) Prefer package.json scripts.build if present
if node -e "const p=require('./package.json'); process.exit(p?.scripts?.build ? 0 : 1)"; then
  echo "  - 检测到 scripts.build，执行 npm run build"
  npm run build
else
  # 2) Fallback to tsc when tsconfig.json exists
  if [ -f "$PLUGIN_DIR/tsconfig.json" ]; then
    BUILD_TSCONFIG="tsconfig.json"
    if [ -f "$PLUGIN_DIR/tsconfig.build.json" ]; then
      BUILD_TSCONFIG="tsconfig.build.json"
    fi
    echo "  - 未检测到 scripts.build，回退执行 TypeScript 编译（npx -p typescript tsc -p $BUILD_TSCONFIG）"
    npx -y -p typescript tsc -p "$BUILD_TSCONFIG"
  else
    echo "  ✗ 未检测到 scripts.build 且不存在 tsconfig.json，无法确认已完成编译"
    exit 1
  fi
fi

# 3) Post-build sanity check: outDir defaults to dist, but honor tsconfig.json if present.
OUT_DIR="dist"
if [ -f "$PLUGIN_DIR/tsconfig.json" ]; then
  OUT_DIR_FROM_TSCONFIG="$(node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('tsconfig.json','utf8'));
    const outDir = cfg?.compilerOptions?.outDir;
    if (typeof outDir === 'string' && outDir.trim()) process.stdout.write(outDir.trim());
  ")"
  if [ -n "$OUT_DIR_FROM_TSCONFIG" ]; then
    OUT_DIR="$OUT_DIR_FROM_TSCONFIG"
  fi
fi

if [ ! -d "$PLUGIN_DIR/$OUT_DIR" ]; then
  echo "  ✗ 构建完成但未发现产物目录：$PLUGIN_DIR/$OUT_DIR"
  echo "    请检查 tsconfig.json 的 outDir 或 build 脚本是否输出到其它目录"
  exit 1
fi
echo "  ✓ 已检测到构建产物目录：$PLUGIN_DIR/$OUT_DIR"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "  ✗ 未找到 $CONFIG_FILE，请先完成 OpenClaw 初始化后再部署"
  exit 1
fi

echo "==> 更新 OpenClaw 配置"
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
  const id = '$PLUGIN_ID';

  // 1. plugins.entries: 确保插件已启用
  cfg.plugins = cfg.plugins ?? {};
  cfg.plugins.entries = cfg.plugins.entries ?? {};
  if (!cfg.plugins.entries[id]) {
    cfg.plugins.entries[id] = { enabled: true };
    console.log('  + 已添加 plugins.entries.' + id);
  } else if (!cfg.plugins.entries[id].enabled) {
    cfg.plugins.entries[id].enabled = true;
    console.log('  + 已启用 plugins.entries.' + id);
  } else {
    console.log('  ✓ plugins.entries.' + id + ' 已存在');
  }

  // 2. plugins.allow: 如果配置了白名单，确保插件在列表中
  if (Array.isArray(cfg.plugins.allow)) {
    if (!cfg.plugins.allow.includes(id)) {
      cfg.plugins.allow.push(id);
      console.log('  + 已添加到 plugins.allow');
    } else {
      console.log('  ✓ plugins.allow 已包含 ' + id);
    }
  } else {
    console.log('  - plugins.allow 未配置，跳过');
  }

  fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n');
"

echo "==> 检查 OpenClaw gateway 运行状态"
GATEWAY_STATUS="$(openclaw gateway status 2>/dev/null || true)"
DID_RESTART="false"
if echo "$GATEWAY_STATUS" | rg -q "Runtime: running"; then
  echo "==> gateway 当前运行中，执行重启"
  openclaw gateway restart
  DID_RESTART="true"
else
  echo "==> gateway 当前未运行，按要求跳过启动/重启"
fi

echo "==> 检查启动状态"
sleep 2
if [ "$DID_RESTART" = "true" ]; then
  # Restart 之后才做运行态确认，避免误匹配其它 openclaw 进程。
  if openclaw gateway status 2>/dev/null | rg -q "Runtime: running"; then
    echo "✓ gateway 重启完成"
  else
    echo "✗ gateway 重启后未处于 running 状态，请查看状态与日志：openclaw gateway status"
    exit 1
  fi
else
  # 未重启/未启动时，仅输出当前状态
  openclaw gateway status 2>/dev/null || true
fi
