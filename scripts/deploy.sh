#!/usr/bin/env bash
# 部署 openclaw-infoflow 插件到本地 OpenClaw 并重启 gateway

set -euo pipefail

PLUGIN_ID="infoflow"
PLUGIN_DIR="$HOME/.openclaw/extensions/$PLUGIN_ID"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMMON_SCRIPT="$SCRIPT_DIR/lib/deploy-common.sh"

echo "==> 同步插件文件到 $PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR"
rsync -av --delete "$PROJECT_DIR/" "$PLUGIN_DIR/" \
  --exclude node_modules \
  --exclude dist \
  --exclude .git

if [ ! -f "$COMMON_SCRIPT" ]; then
  echo "✗ 缺少公共部署脚本: $COMMON_SCRIPT"
  exit 1
fi

bash "$COMMON_SCRIPT" \
  --plugin-dir "$PLUGIN_DIR" \
  --plugin-id "$PLUGIN_ID" \
  --config-file "$CONFIG_FILE" \
  --baidu-registry "${BAIDU_NPM_REGISTRY:-${NPM_CONFIG_REGISTRY_BAIDU:-http://registry.npm.baidu-int.com}}"
