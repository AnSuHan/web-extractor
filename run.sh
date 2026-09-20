#!/usr/bin/env bash
# web-extractor — macOS / Linux 용 실행 스크립트.
# Node 가 없으면 이 폴더 안(.tools/node)에 내려받아 씁니다. 시스템에는 설치하지 않습니다.
set -euo pipefail
cd "$(dirname "$0")"

NODE_VERSION="v22.20.0"
TOOLS_DIR=".tools"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  [ "$major" -ge 20 ]
}

NODE_BIN="node"

if ! node_ok; then
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *) echo "지원하지 않는 OS 입니다. https://nodejs.org 에서 Node LTS 를 설치해 주세요."; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *) echo "지원하지 않는 아키텍처입니다. https://nodejs.org 에서 Node LTS 를 설치해 주세요."; exit 1 ;;
  esac

  DIR="node-${NODE_VERSION}-${os}-${arch}"
  if [ ! -x "${TOOLS_DIR}/${DIR}/bin/node" ]; then
    echo ""
    echo "Node 를 내려받습니다 (시스템에는 설치하지 않습니다)…"
    mkdir -p "$TOOLS_DIR"
    URL="https://nodejs.org/dist/${NODE_VERSION}/${DIR}.tar.gz"
    echo "  $URL"
    curl -fsSL "$URL" | tar -xz -C "$TOOLS_DIR"
  fi
  NODE_BIN="$(pwd)/${TOOLS_DIR}/${DIR}/bin/node"
  export PATH="$(dirname "$NODE_BIN"):$PATH"
fi

exec "$NODE_BIN" scripts/launch.mjs
