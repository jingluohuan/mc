#!/usr/bin/env bash
# 把本 Skill 安装到当前用户的 CodeBuddy skills 目录
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${HOME}/.codebuddy/skills/itlzmc-plugin-dev"
mkdir -p "$(dirname "$DST")"
rm -rf "$DST"
cp -a "$SRC" "$DST"
echo "已安装到：$DST"
