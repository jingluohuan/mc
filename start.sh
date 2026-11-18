#!/usr/bin/env bash
# ITLZMC 一体化启动：静态站点 + 房间服务 REST + 本地房间（WebRTC）信令
# 用法：./start.sh [端口]   默认 8080（也可用环境变量 PORT）
set -e
cd "$(dirname "$0")"
PORT="${1:-${PORT:-8080}}"
export PORT
echo "ITLZMC -> http://localhost:${PORT}/"
echo "已一并启动：静态资源 / 房间列表 / 邀请码 / 本地房间联机 / 皮肤查询"
echo "按 Ctrl+C 停止"
exec node server.js
