#!/usr/bin/env bash
# fork-dev.sh — Start a local Anvil fork of Base mainnet for UI testing.
#
# Usage:
#   bash scripts/fork-dev.sh [your-wallet-address]
#
# What it does:
#   1. Forks Base mainnet at latest block (port 8545, chainId 8453)
#   2. Gives your wallet 100 ETH for gas
#   3. Impersonates a USDC whale and sends you 1,000,000 USDC
#   4. Prints MetaMask setup instructions
#
# Prerequisites:
#   - Anvil installed: curl -L https://foundry.paradigm.xyz | bash && foundryup
#   - A Base mainnet RPC URL (Alchemy / Infura / public)
#
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
PORT=8545
CHAIN_ID=8453

# USDC on Base mainnet
USDC_ADDRESS="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
# A known USDC whale on Base (Circle's reserve / large holder)
USDC_WHALE="0x0B0A5886664376F59C351ba3f598C8A8B4D0A6f3"
# Amount: 1,000,000 USDC (6 decimals)
USDC_AMOUNT="0x00000000000000000000000000000000000000000000000000000000003D0900"
# 1_000_000 * 10^6 = 0xF4240 hex → but let's use full: 1000000 * 1e6 = 1e12 = 0xE8D4A51000
USDC_AMOUNT_HEX="0x$(python3 -c 'print(hex(1_000_000 * 10**6)[2:])'  2>/dev/null || printf '%x' $((1000000 * 1000000)))"

# Base mainnet RPC — try env var first, then public fallback
BASE_RPC="${BASE_MAINNET_RPC_URL:-${ALCHEMY_BASE_URL:-https://mainnet.base.org}}"

# Target wallet — first CLI arg or $TEST_WALLET_ADDRESS env var
TARGET="${1:-${TEST_WALLET_ADDRESS:-}}"

# ── Helpers ───────────────────────────────────────────────────────────────────
red()   { echo -e "\033[0;31m$*\033[0m"; }
green() { echo -e "\033[0;32m$*\033[0m"; }
yellow(){ echo -e "\033[0;33m$*\033[0m"; }
blue()  { echo -e "\033[0;34m$*\033[0m"; }
bold()  { echo -e "\033[1m$*\033[0m"; }

rpc() {
  curl -s -X POST "http://127.0.0.1:${PORT}" \
    -H "Content-Type: application/json" \
    --data "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result','') if 'error' not in d else d['error'])" 2>/dev/null
}

# ── Check dependencies ────────────────────────────────────────────────────────
if ! command -v anvil &>/dev/null; then
  red "✗ anvil not found."
  echo "  Install Foundry:  curl -L https://foundry.paradigm.xyz | bash && foundryup"
  exit 1
fi

if [[ -z "$TARGET" ]]; then
  yellow "⚠  No wallet address provided."
  echo "   Pass it as an argument:  bash scripts/fork-dev.sh 0xYourAddress"
  echo "   Or set: export TEST_WALLET_ADDRESS=0xYourAddress"
  echo ""
  echo "   Starting fork anyway — you can fund later with:"
  echo "   cast send \$USDC_ADDR 'transfer(address,uint256)' \$YOUR_ADDR 1000000000000 --from \$WHALE --unlocked --rpc-url http://127.0.0.1:8545"
  echo ""
fi

# ── Kill any existing Anvil on this port ─────────────────────────────────────
if lsof -ti tcp:${PORT} &>/dev/null; then
  yellow "→ Killing existing process on port ${PORT}…"
  kill $(lsof -ti tcp:${PORT}) 2>/dev/null || true
  sleep 1
fi

# ── Start Anvil fork ──────────────────────────────────────────────────────────
bold "⛓  Starting Anvil fork of Base mainnet…"
echo "   RPC source: ${BASE_RPC}"
echo ""

anvil \
  --fork-url "${BASE_RPC}" \
  --chain-id ${CHAIN_ID} \
  --port ${PORT} \
  --block-time 2 \
  --accounts 10 \
  --balance 10000 \
  --gas-limit 30000000 \
  --no-cors \
  &

ANVIL_PID=$!
echo "   Anvil PID: ${ANVIL_PID}"

# Wait for Anvil to be ready
echo -n "   Waiting for Anvil"
for i in {1..30}; do
  if curl -s "http://127.0.0.1:${PORT}" -X POST -H "Content-Type: application/json" \
       --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' &>/dev/null; then
    echo " ready!"
    break
  fi
  echo -n "."
  sleep 1
done
echo ""

# ── Fund target wallet ────────────────────────────────────────────────────────
if [[ -n "$TARGET" ]]; then
  bold "💰 Funding ${TARGET}…"

  # Give ETH for gas (100 ETH)
  ETH_RESULT=$(rpc "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_setBalance\",\"params\":[\"${TARGET}\",\"0x56BC75E2D63100000\"],\"id\":1}")
  green "   ✓ ETH balance set to 100 ETH"

  # Impersonate USDC whale
  rpc "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_impersonateAccount\",\"params\":[\"${USDC_WHALE}\"],\"id\":2}" > /dev/null

  # Transfer USDC (ERC-20 transfer calldata)
  # transfer(address to, uint256 amount) selector = 0xa9059cbb
  PADDED_TARGET=$(printf '%064s' "${TARGET#0x}" | tr ' ' '0')
  PADDED_AMOUNT=$(python3 -c "print(format(1_000_000 * 10**6, '064x'))" 2>/dev/null || printf '%064x' $((1000000 * 1000000)))
  CALLDATA="0xa9059cbb${PADDED_TARGET}${PADDED_AMOUNT}"

  TX_RESULT=$(rpc "{\"jsonrpc\":\"2.0\",\"method\":\"eth_sendTransaction\",\"params\":[{\"from\":\"${USDC_WHALE}\",\"to\":\"${USDC_ADDRESS}\",\"data\":\"${CALLDATA}\",\"gas\":\"0x30000\"}],\"id\":3}")

  # Stop impersonating
  rpc "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_stopImpersonatingAccount\",\"params\":[\"${USDC_WHALE}\"],\"id\":4}" > /dev/null

  if [[ "$TX_RESULT" == 0x* ]]; then
    green "   ✓ 1,000,000 USDC transferred to ${TARGET}"
  else
    yellow "   ⚠  USDC transfer returned: ${TX_RESULT}"
    echo "      You can retry manually — see command below."
  fi
  echo ""
fi

# ── Print instructions ────────────────────────────────────────────────────────
bold "═══════════════════════════════════════════════════════"
bold "  Anvil fork running on http://127.0.0.1:${PORT}"
bold "═══════════════════════════════════════════════════════"
echo ""
bold "MetaMask — Add Network Manually:"
echo "  Network name:  Base Fork (Local)"
echo "  RPC URL:       http://127.0.0.1:${PORT}"
echo "  Chain ID:      ${CHAIN_ID}"
echo "  Currency:      ETH"
echo "  Block explorer: (leave blank)"
echo ""
bold "Frontend — Start in fork mode:"
echo "  NEXT_PUBLIC_FORK_RPC_URL=http://127.0.0.1:${PORT} pnpm --filter @defi-composer/frontend dev"
echo ""
echo "  Or set in apps/frontend/.env.local:"
echo "    NEXT_PUBLIC_FORK_RPC_URL=http://127.0.0.1:${PORT}"
echo ""
bold "Useful cast commands:"
echo "  # Check USDC balance"
echo "  cast call ${USDC_ADDRESS} 'balanceOf(address)(uint256)' ${TARGET:-0xYourAddress} --rpc-url http://127.0.0.1:${PORT}"
echo ""
echo "  # Send more USDC to yourself"
echo "  cast send ${USDC_ADDRESS} 'transfer(address,uint256)' ${TARGET:-0xYourAddress} 1000000000000 --from ${USDC_WHALE} --unlocked --rpc-url http://127.0.0.1:${PORT}"
echo ""
echo "  # Mine blocks manually"
echo "  cast rpc anvil_mine 10 --rpc-url http://127.0.0.1:${PORT}"
echo ""
yellow "Press Ctrl-C to stop Anvil."
echo ""

# Keep script alive (Anvil is in background)
wait $ANVIL_PID
