#!/bin/sh
set -eu
APP_DIR="${OMNIMOD_MARKET_APP_DIR:-/home/omniaeyu/crypto-bot}"
NODE_BIN="${OMNIMOD_MARKET_NODE_BIN:-/home/omniaeyu/nodevenv/crypto-bot/20/bin/node}"
LOCK_FILE="${OMNIMOD_MARKET_LOCK_FILE:-/home/omniaeyu/.omnimod-market-bots.lock}"
cd "$APP_DIR"
exec /usr/bin/flock -n "$LOCK_FILE" "$NODE_BIN" hosting/manager.js
