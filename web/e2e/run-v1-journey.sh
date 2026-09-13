#!/usr/bin/env bash
# Runs the V1 browser journey end to end against a fresh mainnet fork.
#
# The fork must be FRESH. Robinhood Chain's public RPC is not an archive node and
# stops serving state for a block within minutes of it being mined, so a fork node
# that has been up for a while dies mid-run with "metadata is not found, <block>".
# Nothing is wrong with the product when that happens — the fork's upstream simply
# forgot the state it was pinned to. This script therefore starts the fork, deploys,
# and runs immediately, rather than reusing a long-lived node.
set -euo pipefail
# Job control, so each background job below lands in its OWN process group and
# can be killed as a tree. Without it every job shares this script's group, and
# killing that group would kill the script too.
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RPC="${FORK_RPC:-https://rpc.mainnet.chain.robinhood.com}"
NODE_PORT="${NODE_PORT:-8545}"
SERVER_PORT="${SERVER_PORT:-4173}"
WORK="$(mktemp -d)"

# `npx hardhat node` spawns through an npm wrapper, so killing the PID we hold
# leaves the real node running and still holding the port. Killing the job's
# process group takes the whole tree, which is what "stop the fork" has to mean.
stop_tree() {
  local pid="${1:-}"
  [[ -z "$pid" ]] && return 0
  local pgid
  pgid="$(ps -o pgid= "$pid" 2>/dev/null | tr -d ' ')"
  # Never signal our own group: that would kill this script and its caller.
  if [[ -n "$pgid" && "$pgid" != "$$" ]]; then
    kill -- "-$pgid" 2>/dev/null || true
  else
    kill "$pid" 2>/dev/null || true
  fi
}
cleanup() {
  stop_tree "${SERVER_PID:-}"
  stop_tree "${NODE_PID:-}"
}
trap cleanup EXIT

echo "--- forking $RPC at its head"
(cd "$ROOT/contracts" && FORK_RPC="$RPC" npx hardhat node \
  --hostname 127.0.0.1 --port "$NODE_PORT" > "$WORK/fork.log" 2>&1) &
NODE_PID=$!

for _ in $(seq 1 60); do
  if curl -s -m 2 -X POST "http://127.0.0.1:$NODE_PORT" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | grep -q result; then
    break
  fi
  sleep 1
done

echo "--- deploying the V1 stack"
(cd "$ROOT/contracts" && npx hardhat run scripts/setupV1Fork.cjs --network localhost) \
  | tee "$WORK/deploy.json"

read_addr() { node -e "console.log(JSON.parse(require('fs').readFileSync('$WORK/deploy.json','utf8')).$1)"; }

echo "--- starting the server"
(cd "$ROOT/server" && \
  RPC_URL="http://127.0.0.1:$NODE_PORT" PORT="$SERVER_PORT" APEX=launchpad.family \
  CHAIN_ID="$(read_addr CHAIN_ID)" \
  FACTORY="$(read_addr FACTORY)" LAUNCHER="$(read_addr LAUNCHER)" \
  REWARDS="$(read_addr REWARDS)" PROTOCOL_TREASURY="$(read_addr PROTOCOL_TREASURY)" \
  node index.js > "$WORK/server.log" 2>&1) &
SERVER_PID=$!

for _ in $(seq 1 30); do
  curl -s -m 2 "http://127.0.0.1:$SERVER_PORT/api/health" | grep -q '"ok":true' && break
  sleep 1
done

echo "--- running the journey"
cd "$ROOT"
RPC_URL="http://127.0.0.1:$NODE_PORT" PORT="$SERVER_PORT" APEX=launchpad.family \
  CHAIN_ID="$(read_addr CHAIN_ID)" \
  OWNER="$(read_addr OWNER)" CREATOR="$(read_addr CREATOR)" \
  node web/e2e/v1-journey.mjs
STATUS=$?

# The fork's own log is the only place an upstream-pruning crash is visible, so
# surface it rather than letting it read as a product failure.
if grep -q 'metadata is not found' "$WORK/fork.log" 2>/dev/null; then
  echo
  echo "NOTE: the fork node lost its upstream state mid-run (public RPC pruning)."
  echo "      Failures above may be infrastructure, not product. Re-run."
fi

exit $STATUS
