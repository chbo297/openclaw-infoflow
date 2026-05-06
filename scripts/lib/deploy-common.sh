#!/usr/bin/env bash

set -euo pipefail

PLUGIN_DIR=""
PLUGIN_ID="infoflow"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"
BAIDU_NPM_REGISTRY="${BAIDU_NPM_REGISTRY:-${NPM_CONFIG_REGISTRY_BAIDU:-http://registry.npm.baidu-int.com}}"
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plugin-dir) PLUGIN_DIR="$2"; shift 2 ;;
    --plugin-id) PLUGIN_ID="$2"; shift 2 ;;
    --config-file) CONFIG_FILE="$2"; shift 2 ;;
    --baidu-registry) BAIDU_NPM_REGISTRY="$2"; shift 2 ;;
    --dry-run) DRY_RUN="true"; shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ -z "$PLUGIN_DIR" ]]; then
  echo "Missing --plugin-dir"
  exit 1
fi

cd "$PLUGIN_DIR"

run_cmd() {
  echo "$ $*"
  if [[ "$DRY_RUN" == "true" ]]; then
    return 0
  fi
  "$@"
}

echo "==> 链接 openclaw peer dependency（build 前确保可解析）"
if [ -n "${OPENCLAW_DIR:-}" ] && [ -d "${OPENCLAW_DIR:-}" ]; then
  OPENCLAW_GLOBAL="$OPENCLAW_DIR"
elif command -v pnpm >/dev/null 2>&1; then
  OPENCLAW_GLOBAL="$(pnpm root -g 2>/dev/null)/openclaw"
else
  OPENCLAW_GLOBAL="$(npm root -g 2>/dev/null)/openclaw"
fi

if [ -d "${OPENCLAW_GLOBAL:-}" ]; then
  run_cmd mkdir -p "$PLUGIN_DIR/node_modules"
  run_cmd rm -rf "$PLUGIN_DIR/node_modules/openclaw"
  run_cmd ln -s "$OPENCLAW_GLOBAL" "$PLUGIN_DIR/node_modules/openclaw"
  echo "  ✓ 已链接 $OPENCLAW_GLOBAL -> $PLUGIN_DIR/node_modules/openclaw"
else
  echo "  - 未检测到全局 openclaw，跳过链接"
fi

echo "==> 安装依赖"
  run_cmd npm install --silent

WEBSOCKET_ENABLED="false"
if [ -f "$CONFIG_FILE" ]; then
  WEBSOCKET_ENABLED="$(node -e "
    const fs = require('fs');
    try {
      const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
      const section = cfg?.channels?.$PLUGIN_ID ?? {};
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
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  - dry-run 模式，跳过 websocket 依赖安装"
  elif node --input-type=module -e "import('@baidu/infoflow-sdk-nodejs').then(()=>process.exit(0)).catch(()=>process.exit(1))"; then
    echo "  ✓ @baidu/infoflow-sdk-nodejs 已可用"
  else
    echo "  - 使用私有源安装: $BAIDU_NPM_REGISTRY"
    npm_config_registry="$BAIDU_NPM_REGISTRY" npm install --save-optional --registry "$BAIDU_NPM_REGISTRY" @baidu/infoflow-sdk-nodejs
    if node --input-type=module -e "import('@baidu/infoflow-sdk-nodejs').then(()=>process.exit(0)).catch(()=>process.exit(1))"; then
      echo "  ✓ 运行时依赖校验通过：@baidu/infoflow-sdk-nodejs"
    else
      echo "  ✗ @baidu/infoflow-sdk-nodejs 仍不可用（websocket 模式必须）"
      exit 1
    fi
  fi
else
  echo "==> 当前非 websocket 模式，跳过 @baidu/infoflow-sdk-nodejs 安装"
fi

echo "==> 构建插件（确保 build 完成）"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  - dry-run 模式，跳过实际构建"
else
  if [ -d "$PLUGIN_DIR/dist" ] && [ ! -f "$PLUGIN_DIR/tsconfig.build.json" ] && [ ! -f "$PLUGIN_DIR/tsconfig.json" ]; then
    echo "  - 检测到预编译发布包（无 tsconfig），跳过构建"
  elif node -e "const p=require('./package.json'); process.exit(p?.scripts?.build ? 0 : 1)"; then
    if [ -f "$PLUGIN_DIR/tsconfig.build.json" ] || [ -f "$PLUGIN_DIR/tsconfig.json" ]; then
      npm run build
    elif [ -d "$PLUGIN_DIR/dist" ]; then
      echo "  - scripts.build 存在但缺少 tsconfig，使用已存在 dist 产物并跳过构建"
    else
      echo "  ✗ scripts.build 存在但缺少 tsconfig 且无 dist 产物"
      exit 1
    fi
  elif [ -f "$PLUGIN_DIR/tsconfig.build.json" ]; then
    npx -y -p typescript tsc -p "$PLUGIN_DIR/tsconfig.build.json"
  elif [ -f "$PLUGIN_DIR/tsconfig.json" ]; then
    npx -y -p typescript tsc -p "$PLUGIN_DIR/tsconfig.json"
  elif [ -d "$PLUGIN_DIR/dist" ]; then
    echo "  - 未检测到构建配置，使用已存在 dist 产物并跳过构建"
  else
    echo "  ✗ 未检测到 scripts.build 或 tsconfig，无法构建"
    exit 1
  fi
fi

if [ ! -d "$PLUGIN_DIR/dist" ] && [[ "$DRY_RUN" != "true" ]]; then
  echo "  ✗ 构建完成但未发现产物目录：$PLUGIN_DIR/dist"
  exit 1
fi
echo "  ✓ 已检测到构建产物目录：$PLUGIN_DIR/dist"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "  ✗ 未找到 $CONFIG_FILE，请先完成 OpenClaw 初始化后再部署"
  exit 1
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "==> dry-run 模式，跳过配置写入与 gateway 操作"
  exit 0
fi

echo "==> 更新 OpenClaw 配置"
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
  const id = '$PLUGIN_ID';

  cfg.plugins = cfg.plugins ?? {};
  cfg.plugins.entries = cfg.plugins.entries ?? {};
  if (!cfg.plugins.entries[id]) cfg.plugins.entries[id] = { enabled: true };
  else if (!cfg.plugins.entries[id].enabled) cfg.plugins.entries[id].enabled = true;

  if (Array.isArray(cfg.plugins.allow) && !cfg.plugins.allow.includes(id)) cfg.plugins.allow.push(id);
  fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n');
"

echo "==> 检查 OpenClaw gateway 运行状态"
GATEWAY_STATUS="$(openclaw gateway status 2>/dev/null || true)"
if echo "$GATEWAY_STATUS" | rg -q "Runtime: running"; then
  echo "==> gateway 当前运行中，执行重启"
  openclaw gateway restart
  sleep 2
  if openclaw gateway status 2>/dev/null | rg -q "Runtime: running"; then
    echo "✓ gateway 重启完成"
  else
    echo "✗ gateway 重启后未处于 running 状态，请查看 openclaw gateway status"
    exit 1
  fi
else
  echo "==> gateway 当前未运行，按要求跳过启动/重启"
fi
